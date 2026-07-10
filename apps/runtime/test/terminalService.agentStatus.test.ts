import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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

const spawnPty = vi.fn(() => {
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
  readFileSync: vi.fn(() => "{}"),
}));

vi.mock("../src/claude/shellEnv.js", () => ({
  buildClaudeRuntimeEnv: vi.fn((baseEnv: NodeJS.ProcessEnv) => ({ ...baseEnv })),
}));

import { createTerminalService } from "../src/services/terminalService";

function createFakePrisma() {
  const rows: any[] = [];
  const terminalTab = {
    findFirst: async () => null,
    findMany: async () => [],
    findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
    create: async ({ data }: any) => {
      rows.push(data);
      return { ...data };
    },
    delete: async ({ where }: any) => {
      const index = rows.findIndex((entry) => entry.id === where.id);
      const [removed] = rows.splice(index, 1);
      return { ...removed };
    },
  };
  return { terminalTab, __rows: rows } as never;
}

describe("terminalService agent status store", () => {
  let onAgentStatusChange: ReturnType<typeof vi.fn>;
  let service: ReturnType<typeof createTerminalService>;

  beforeEach(() => {
    vi.clearAllMocks();
    onAgentStatusChange = vi.fn();
    service = createTerminalService(createFakePrisma(), { onAgentStatusChange });
  });

  it("returns undefined for an unknown session", () => {
    expect(service.getAgentStatus("nope")).toBeUndefined();
  });

  it("stores a status and reports change on first set", () => {
    const changed = service.setAgentStatus("s1", "running");
    expect(changed).toBe(true);
    expect(service.getAgentStatus("s1")).toBe("running");
    expect(onAgentStatusChange).toHaveBeenCalledWith("s1", "running");
  });

  it("does not report change when status is unchanged", () => {
    service.setAgentStatus("s1", "running");
    onAgentStatusChange.mockClear();
    const changed = service.setAgentStatus("s1", "running");
    expect(changed).toBe(false);
    expect(onAgentStatusChange).not.toHaveBeenCalled();
  });

  it("lists all known statuses", () => {
    service.setAgentStatus("s1", "running");
    service.setAgentStatus("s2", "waiting_approval");
    expect(service.listAgentStatuses()).toEqual(
      expect.arrayContaining([
        { sessionId: "s1", status: "running" },
        { sessionId: "s2", status: "waiting_approval" },
      ]),
    );
  });

  it("forces idle and fires the callback when the PTY exits", async () => {
    service.spawn("wt1:terminal:abc", "/tmp");
    service.setAgentStatus("wt1:terminal:abc", "running");
    onAgentStatusChange.mockClear();

    currentMockPty._emit("exit", { exitCode: 0, signal: 0 });
    await Promise.resolve();

    expect(service.getAgentStatus("wt1:terminal:abc")).toBe("idle");
    expect(onAgentStatusChange).toHaveBeenCalledWith("wt1:terminal:abc", "idle");
  });

  it("forces idle when a session is killed", () => {
    service.spawn("s1", "/tmp");
    service.setAgentStatus("s1", "waiting_approval");
    onAgentStatusChange.mockClear();

    service.kill("s1");

    expect(onAgentStatusChange).toHaveBeenCalledWith("s1", "idle");
  });
});
