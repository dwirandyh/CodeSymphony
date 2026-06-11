import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

const mockPtyProcess = () => {
  const emitter = new EventEmitter();
  return {
    pid: 123,
    onData: vi.fn((cb: (data: string) => void) => {
      emitter.on("data", cb);
    }),
    onExit: vi.fn((cb: (event: { exitCode: number; signal?: number }) => void) => {
      emitter.on("exit", cb);
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _emit: (event: string, data: unknown) => emitter.emit(event, data),
  };
};

let currentMockPty: ReturnType<typeof mockPtyProcess>;

// The terminal service talks to the PTY layer through spawnPty (a Node sidecar
// running node-pty). Tests exercise the service logic against a controllable
// fake PTY so they stay runtime-agnostic and do not spawn real processes.
const spawnPty = vi.fn((_file: string, _args: string[], options: { cwd: string }) => {
  if (options.cwd === "/missing") {
    throw new Error("ENOENT: missing cwd");
  }
  currentMockPty = mockPtyProcess();
  return currentMockPty;
});

vi.mock("../src/services/ptyBackend.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/ptyBackend")>(
    "../src/services/ptyBackend",
  );
  return {
    ...actual,
    spawnPty: (...args: Parameters<typeof spawnPty>) => spawnPty(...args),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  appendFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 })),
  writeFileSync: vi.fn(),
}));

vi.mock("../src/claude/shellEnv.js", () => ({
  buildClaudeRuntimeEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => ({ ...baseEnv })),
}));

import { buildClaudeRuntimeEnv } from "../src/claude/shellEnv.js";
import { getRuntimeDebugEntries, resetRuntimeDebugLog } from "../src/routes/debug.js";
import { buildExecShellArgs, createTerminalService } from "../src/services/terminalService";

type FakeTerminalTabRow = {
  id: string;
  worktreeId: string;
  sessionId: string;
  title: string;
  ordinal: number;
  createdAt: Date;
  updatedAt: Date;
};

// Minimal in-memory stand-in for the prisma.terminalTab model the service
// depends on. Mirrors only the operations the service calls.
function createFakePrisma() {
  const rows: FakeTerminalTabRow[] = [];
  const terminalTab = {
    findFirst: async ({ where, orderBy }: any) => {
      const filtered = rows.filter((row) => !where?.worktreeId || row.worktreeId === where.worktreeId);
      if (orderBy?.ordinal === "desc") {
        filtered.sort((a, b) => b.ordinal - a.ordinal);
      }
      return filtered[0] ?? null;
    },
    findMany: async ({ where, orderBy }: any = {}) => {
      let filtered = rows.filter((row) => !where?.worktreeId || row.worktreeId === where.worktreeId);
      if (orderBy?.ordinal === "asc") {
        filtered = [...filtered].sort((a, b) => a.ordinal - b.ordinal);
      }
      return filtered.map((row) => ({ ...row }));
    },
    findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
    create: async ({ data }: any) => {
      const row: FakeTerminalTabRow = {
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((entry) => entry.id === where.id);
      if (!row) {
        throw new Error("Record to update not found");
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    delete: async ({ where }: any) => {
      const index = rows.findIndex((entry) => entry.id === where.id);
      if (index < 0) {
        throw new Error("Record to delete does not exist");
      }
      const [removed] = rows.splice(index, 1);
      return { ...removed };
    },
  };

  return {
    terminalTab,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn({ terminalTab }),
    __rows: rows,
  };
}

describe("terminalService", () => {
  let service: ReturnType<typeof createTerminalService>;
  let fakePrisma: ReturnType<typeof createFakePrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeDebugLog();
    fakePrisma = createFakePrisma();
    service = createTerminalService(fakePrisma as never);
  });

  describe("spawn", () => {
    it("creates a new session", () => {
      const session = service.spawn("s1", "/tmp");
      expect(session.id).toBe("s1");
      expect(session.requestedCwd).toBe("/tmp");
      expect(session.resolvedCwd).toBe("/tmp");
      expect(service.has("s1")).toBe(true);
    });

    it("returns existing session if not replacing and cwd is unchanged", () => {
      const first = service.spawn("s1", "/tmp");
      const second = service.spawn("s1", "/tmp");
      expect(first).toBe(second);
    });

    it("respawns exited workspace terminal sessions when reconnecting", async () => {
      const first = service.spawn("wt1:terminal:abc", "/tmp");
      const exitedPty = currentMockPty;

      exitedPty._emit("exit", { exitCode: 0, signal: 0 });
      await Promise.resolve();

      const second = service.spawn("wt1:terminal:abc", "/tmp");

      expect(second).not.toBe(first);
      expect(second.active).toBe(true);
      expect(currentMockPty).not.toBe(exitedPty);
      expect(spawnPty).toHaveBeenCalledTimes(2);
    });

    it("replaces the session when cwd changes", () => {
      const first = service.spawn("s1", "/tmp");
      const oldPty = currentMockPty;

      const second = service.spawn("s1", "/var/tmp");

      expect(second).not.toBe(first);
      expect(oldPty.kill).toHaveBeenCalled();
      expect(second.requestedCwd).toBe("/var/tmp");
      expect(second.resolvedCwd).toBe("/var/tmp");
    });

    it("replaces session when replace option is true", () => {
      const first = service.spawn("s1", "/tmp");
      const second = service.spawn("s1", "/tmp", { replace: true });
      expect(second).not.toBe(first);
      expect(service.has("s1")).toBe(true);
    });

    it("kills old pty when replacing", () => {
      service.spawn("s1", "/tmp");
      const oldPty = currentMockPty;
      service.spawn("s1", "/tmp", { replace: true });
      expect(oldPty.kill).toHaveBeenCalled();
    });

    it("strips NO_COLOR from terminal env so CLI tools can emit ANSI colors", () => {
      const originalNoColor = process.env.NO_COLOR;
      const originalShell = process.env.SHELL;
      process.env.NO_COLOR = "1";
      process.env.SHELL = "/bin/zsh";

      try {
        service.spawn("s1", "/tmp", { replace: true });

        const spawnCall = spawnPty.mock.calls.at(-1);
        const env = spawnCall?.[2]?.env as Record<string, string> | undefined;
        expect(env?.NO_COLOR).toBeUndefined();
        expect(env?.FORCE_COLOR).toBe("1");
      } finally {
        process.env.NO_COLOR = originalNoColor;
        process.env.SHELL = originalShell;
      }
    });

    it("strips Cursor agent env from terminal spawn so shell rc does not disable colors", () => {
      const originals = {
        NO_COLOR: process.env.NO_COLOR,
        FORCE_COLOR: process.env.FORCE_COLOR,
        CURSOR_AGENT: process.env.CURSOR_AGENT,
        CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS,
        OPENCODE: process.env.OPENCODE,
        OPENCODE_PROCESS_ROLE: process.env.OPENCODE_PROCESS_ROLE,
        OPENCODE_RUN_ID: process.env.OPENCODE_RUN_ID,
        TERM_PROGRAM: process.env.TERM_PROGRAM,
        CODESYMPHONY_TERMINAL_ZDOTDIR: process.env.CODESYMPHONY_TERMINAL_ZDOTDIR,
        CODESYMPHONY_TERMINAL_ZSHRC_TEMPLATE: process.env.CODESYMPHONY_TERMINAL_ZSHRC_TEMPLATE,
        SHELL: process.env.SHELL,
      };
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
      process.env.CURSOR_AGENT = "1";
      process.env.CURSOR_INVOKED_AS = "agent";
      process.env.OPENCODE = "1";
      process.env.OPENCODE_PROCESS_ROLE = "worker";
      process.env.OPENCODE_RUN_ID = "run-1";
      process.env.TERM_PROGRAM = "zed";
      process.env.CODESYMPHONY_TERMINAL_ZDOTDIR = "/tmp/codesymphony-terminal-zsh";
      process.env.CODESYMPHONY_TERMINAL_ZSHRC_TEMPLATE = "/Applications/CodeSymphony.app/Contents/Resources/runtime-bundle/terminal-zsh/.zshrc";
      process.env.SHELL = "/bin/zsh";

      try {
        service.spawn("s1", "/tmp", { replace: true });

        const env = spawnPty.mock.calls.at(-1)?.[2]?.env as Record<string, string> | undefined;
        expect(env?.NO_COLOR).toBeUndefined();
        expect(env?.FORCE_COLOR).toBe("1");
        expect(env?.CURSOR_AGENT).toBeUndefined();
        expect(env?.CURSOR_INVOKED_AS).toBeUndefined();
        expect(env?.OPENCODE).toBeUndefined();
        expect(env?.OPENCODE_PROCESS_ROLE).toBeUndefined();
        expect(env?.OPENCODE_RUN_ID).toBeUndefined();
        expect(env?.TERM_PROGRAM).toBe("kitty");
        expect(env?.ZDOTDIR).toBe("/tmp/codesymphony-terminal-zsh");
        expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/codesymphony-terminal-zsh", { recursive: true });
        expect(fs.copyFileSync).toHaveBeenCalledWith(
          "/Applications/CodeSymphony.app/Contents/Resources/runtime-bundle/terminal-zsh/.zshrc",
          "/tmp/codesymphony-terminal-zsh/.zshrc",
        );
      } finally {
        for (const [key, value] of Object.entries(originals)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    });

    it("starts interactive shells as login shells", () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = "/bin/zsh";

      try {
      service.spawn("s1", "/tmp");

      expect(buildClaudeRuntimeEnv).toHaveBeenCalled();
      expect(spawnPty).toHaveBeenCalledWith(
        expect.any(String),
        ["-o", "nopromptsp"],
        expect.objectContaining({
          cwd: "/tmp",
          env: expect.objectContaining({
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            FORCE_COLOR: "1",
            CLICOLOR_FORCE: "1",
            TERM_PROGRAM: "kitty",
          }),
        }),
      );
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it("keeps exec mode on login shell command execution", () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = "/bin/zsh";

      try {
        service.spawn("s1", "/tmp", { mode: "exec", command: "pwd", replace: true });

        expect(spawnPty).toHaveBeenCalledWith(
          "/bin/zsh",
          ["-lic", "pwd"],
          expect.objectContaining({
            cwd: "/tmp",
          }),
        );
      } finally {
        process.env.SHELL = originalShell;
      }
    });

    it("does not fall back to HOME when an explicit cwd fails", () => {
      expect(() => service.spawn("s1", "/missing")).toThrow("ENOENT: missing cwd");
      const spawnCalls = spawnPty.mock.calls;
      expect(spawnCalls.length).toBeGreaterThan(0);
      expect(spawnCalls.every(([, , options]) => options.cwd === "/missing")).toBe(true);
    });

    it("falls back when no cwd is provided", () => {
      const originalHome = process.env.HOME;
      const originalShell = process.env.SHELL;
      process.env.HOME = "/Users/tester";
      process.env.SHELL = "/bin/zsh";

      try {
        const session = service.spawn("s1");
        expect(session.requestedCwd).toBeUndefined();
        expect(session.resolvedCwd).toBe("/Users/tester");
        expect(spawnPty).toHaveBeenCalledWith(
          expect.any(String),
          ["-o", "nopromptsp"],
          expect.objectContaining({
            cwd: "/Users/tester",
          }),
        );
      } finally {
        process.env.HOME = originalHome;
        process.env.SHELL = originalShell;
      }
    });
  });

  describe("buildExecShellArgs", () => {
    it("uses interactive login mode for zsh", () => {
      expect(buildExecShellArgs("/bin/zsh", "command -v flutter")).toEqual([
        "-lic",
        "command -v flutter",
      ]);
    });

    it("uses interactive login mode for bash", () => {
      expect(buildExecShellArgs("/bin/bash", "echo hi")).toEqual([
        "-lic",
        "echo hi",
      ]);
    });

    it("keeps non-interactive exec mode for sh", () => {
      expect(buildExecShellArgs("/bin/sh", "echo hi")).toEqual([
        "-lc",
        "echo hi",
      ]);
    });
  });

  describe("write", () => {
    it("writes data to pty process", () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      service.write("s1", "ls\r");
      expect(pty.write).toHaveBeenCalledWith("ls\r");
    });

    it("logs sanitized pty write diagnostics", () => {
      service.spawn("wt1:terminal:1", "/tmp");
      service.write("wt1:terminal:1", "secret-token");

      const writeLog = getRuntimeDebugEntries().find(
        (entry) => entry.source === "terminal.input" && entry.message === "[DEBUG-terminal-typing] service.write.ptyWriteOk",
      );
      expect(writeLog?.data).toMatchObject({
        sessionId: "wt1:terminal:1",
        worktreeId: "wt1",
        inputSummary: {
          kind: "printable",
          byteLength: 12,
          printableAsciiCount: 12,
        },
      });
      expect(JSON.stringify(writeLog?.data)).not.toContain("secret-token");
    });

    it("does nothing for non-existent session", () => {
      expect(() => service.write("nonexistent", "data")).not.toThrow();
    });
  });

  describe("resize", () => {
    it("resizes pty process", () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      service.resize("s1", 120, 40);
      expect(pty.resize).toHaveBeenCalledWith(120, 40);
    });

    it("does nothing for non-existent session", () => {
      expect(() => service.resize("nonexistent", 80, 24)).not.toThrow();
    });
  });

  describe("addListener", () => {
    it("registers data listener and receives data", () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      service.addListener("s1", listener);

      currentMockPty._emit("data", "hello");
      expect(listener).toHaveBeenCalledWith("hello");
    });

    it("logs sanitized pty output diagnostics", () => {
      service.spawn("wt1:terminal:1", "/tmp");

      currentMockPty._emit("data", "secret output\n");

      const outputLog = getRuntimeDebugEntries().find(
        (entry) => entry.source === "terminal.output" && entry.message === "[DEBUG-terminal-typing] service.pty.output",
      );
      expect(outputLog?.data).toMatchObject({
        sessionId: "wt1:terminal:1",
        worktreeId: "wt1",
        outputSeq: 1,
        outputSummary: {
          kind: "paste",
          byteLength: 14,
          lineBreakCount: 1,
        },
      });
      expect(JSON.stringify(outputLog?.data)).not.toContain("secret output");
    });

    it("returns noop for non-existent session", () => {
      const unsub = service.addListener("nonexistent", vi.fn());
      expect(typeof unsub).toBe("function");
      expect(() => unsub()).not.toThrow();
    });

    it("replays scrollback on new listener", () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("data", "line1");
      currentMockPty._emit("data", "line2");

      const listener = vi.fn();
      service.addListener("s1", listener);
      expect(listener).toHaveBeenCalledWith("line1line2");
    });

    it("can skip scrollback replay when requested", () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("data", "line1");

      const listener = vi.fn();
      service.addListener("s1", listener, { replay: false });

      expect(listener).not.toHaveBeenCalled();
    });

    it("removes listener on unsub call", () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      const unsub = service.addListener("s1", listener);

      listener.mockClear();
      unsub();
      currentMockPty._emit("data", "after-unsub");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("addExitListener", () => {
    it("registers exit listener", async () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      service.addExitListener("s1", listener);

      currentMockPty._emit("exit", { exitCode: 0, signal: 0 });
      await Promise.resolve();
      expect(listener).toHaveBeenCalledWith({ exitCode: 0, signal: 0 });
    });

    it("returns noop for non-existent session", () => {
      const unsub = service.addExitListener("nonexistent", vi.fn());
      expect(typeof unsub).toBe("function");
    });

    it("removes listener on unsub", async () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      const unsub = service.addExitListener("s1", listener);
      unsub();
      currentMockPty._emit("exit", { exitCode: 1 });
      await Promise.resolve();
      expect(listener).not.toHaveBeenCalled();
    });

    it("replays the exit event for an already exited session", async () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("exit", { exitCode: 0, signal: 9 });
      await Promise.resolve();

      const listener = vi.fn();
      service.addExitListener("s1", listener);

      expect(listener).toHaveBeenCalledWith({ exitCode: 0, signal: 9 });
    });

    it("can skip immediate exit replay when requested", async () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("exit", { exitCode: 0, signal: 9 });
      await Promise.resolve();

      const listener = vi.fn();
      service.addExitListener("s1", listener, { replay: false });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("session persistence", () => {
    it("retains exited sessions for reconnect and excludes them from resource sessions", async () => {
      const session = service.spawn("s1", "/tmp");
      const spawnCountBeforeExit = spawnPty.mock.calls.length;

      currentMockPty._emit("data", "done\n");
      currentMockPty._emit("exit", { exitCode: 0, signal: 0 });
      await Promise.resolve();

      expect(service.has("s1")).toBe(true);
      expect(service.listResourceSessions()).toEqual([]);
      expect(service.listSessions()).toEqual([
        {
          sessionId: "s1",
          requestedCwd: "/tmp",
          resolvedCwd: "/tmp",
          active: false,
          exitCode: 0,
          signal: 0,
        },
      ]);

      const replayListener = vi.fn();
      service.addListener("s1", replayListener);
      expect(replayListener).toHaveBeenCalledWith("done\n");

      const reconnectedSession = service.spawn("s1", "/tmp");
      expect(reconnectedSession).toBe(session);
      expect(spawnPty.mock.calls).toHaveLength(spawnCountBeforeExit);
    });

    it("returns stored scrollback and exit metadata", async () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("data", "done\n");
      currentMockPty._emit("exit", { exitCode: 7, signal: 0 });
      await Promise.resolve();

      expect(service.getScrollback("s1")).toBe("done\n");
      expect(service.getExitEvent("s1")).toEqual({ exitCode: 7, signal: 0 });
    });
  });

  describe("has", () => {
    it("returns false for non-existent session", () => {
      expect(service.has("nonexistent")).toBe(false);
    });
  });

  describe("kill", () => {
    it("kills a session and removes it", () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      service.kill("s1");
      expect(pty.kill).toHaveBeenCalled();
      expect(service.has("s1")).toBe(false);
    });

    it("does nothing for non-existent session", () => {
      expect(() => service.kill("nonexistent")).not.toThrow();
    });
  });

  describe("killAll", () => {
    it("kills all sessions", () => {
      service.spawn("s1", "/tmp");
      const pty1 = currentMockPty;
      service.spawn("s2", "/tmp");
      const pty2 = currentMockPty;

      service.killAll();
      expect(pty1.kill).toHaveBeenCalled();
      expect(pty2.kill).toHaveBeenCalled();
      expect(service.has("s1")).toBe(false);
      expect(service.has("s2")).toBe(false);
    });
  });

  describe("tab registry", () => {
    it("creates a tab with server-assigned id, sessionId, ordinal and title", async () => {
      const tab = await service.createTab("wt1");

      expect(tab.worktreeId).toBe("wt1");
      expect(tab.ordinal).toBe(1);
      expect(tab.title).toBe("Terminal");
      expect(tab.id).toBeTruthy();
      expect(tab.sessionId).toBe(`wt1:terminal:${tab.id}`);
    });

    it("always titles new tabs 'Terminal' but keeps incrementing ordinal per worktree", async () => {
      const first = await service.createTab("wt1");
      const second = await service.createTab("wt1");
      const otherWorktree = await service.createTab("wt2");

      expect(first.ordinal).toBe(1);
      expect(first.title).toBe("Terminal");
      expect(second.ordinal).toBe(2);
      expect(second.title).toBe("Terminal");
      expect(otherWorktree.ordinal).toBe(1);
      expect(otherWorktree.title).toBe("Terminal");
    });

    it("lists tabs filtered by worktree, ordered by ordinal", async () => {
      const first = await service.createTab("wt1");
      const second = await service.createTab("wt1");
      await service.createTab("wt2");

      expect(await service.listTabs("wt1")).toEqual([first, second]);
    });

    it("lists all tabs when no worktree filter is given", async () => {
      const first = await service.createTab("wt1");
      const second = await service.createTab("wt2");

      expect(await service.listTabs()).toEqual([first, second]);
    });

    it("renames a tab and persists the new title", async () => {
      const tab = await service.createTab("wt1");

      const renamed = await service.renameTab(tab.id, "Build");

      expect(renamed?.title).toBe("Build");
      expect((await service.listTabs("wt1"))[0]?.title).toBe("Build");
    });

    it("returns null when renaming an unknown tab", async () => {
      expect(await service.renameTab("missing", "Nope")).toBeNull();
    });

    it("closes a tab and kills its pty session", async () => {
      const tab = await service.createTab("wt1");
      service.spawn(tab.sessionId, "/tmp");
      const pty = currentMockPty;

      await service.closeTab(tab.id);

      expect(pty.kill).toHaveBeenCalled();
      expect(service.has(tab.sessionId)).toBe(false);
      expect(await service.listTabs("wt1")).toEqual([]);
    });

    it("returns the closed tab so callers can broadcast it", async () => {
      const tab = await service.createTab("wt1");

      expect(await service.closeTab(tab.id)).toEqual(tab);
    });

    it("returns null when closing an unknown tab", async () => {
      expect(await service.closeTab("missing")).toBeNull();
    });
  });

  describe("headless emulator query responses", () => {
    const ALT_ENTER = "\x1b[?1049h";

    it("answers a DA1 query by writing the reply back to the PTY with no listeners attached", async () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      pty.write.mockClear();

      pty._emit("data", "\x1b[c");
      // Emulator writes are async; let xterm process and emit the reply.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const written = pty.write.mock.calls.map((call) => call[0]).join("");
      expect(written).toContain("\x1b[?");
    });

    it("produces an attach snapshot reflecting alternate-screen mode", async () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      service.resize("s1", 122, 43);
      pty._emit("data", `${ALT_ENTER}opencode frame`);

      const snapshot = await service.getAttachSnapshot("s1");
      expect(snapshot.modes.alternateScreen).toBe(true);
      expect(snapshot.cols).toBe(122);
      expect(snapshot.rows).toBe(43);
    });

    it("captures written text in the attach snapshot", async () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("data", "hello from shell");

      const snapshot = await service.getAttachSnapshot("s1");
      expect(snapshot.snapshotAnsi).toContain("hello from shell");
    });

    it("detects alt-screen enter even when the sequence is split across chunks", async () => {
      service.spawn("s1", "/tmp");
      currentMockPty._emit("data", "\x1b[?10");
      currentMockPty._emit("data", "49hframe");

      const snapshot = await service.getAttachSnapshot("s1");
      expect(snapshot.modes.alternateScreen).toBe(true);
    });

    it("returns an empty snapshot for an unknown session", async () => {
      const snapshot = await service.getAttachSnapshot("nope");
      expect(snapshot.snapshotAnsi).toBe("");
      expect(snapshot.modes.alternateScreen).toBe(false);
    });
  });

  describe("scrollback buffer management", () => {
    it("trims scrollback when exceeding MAX_SCROLLBACK_BYTES", () => {
      service.spawn("s1", "/tmp");
      const bigData = "x".repeat(30000);
      currentMockPty._emit("data", bigData);
      currentMockPty._emit("data", bigData);

      const listener = vi.fn();
      service.addListener("s1", listener);
      const replayedData = listener.mock.calls[0]?.[0] as string;
      expect(replayedData.length).toBeLessThanOrEqual(60000);
    });
  });
});
