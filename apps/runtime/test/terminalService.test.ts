import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const mockPtyProcess = () => {
  const emitter = new EventEmitter();
  return {
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

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    currentMockPty = mockPtyProcess();
    return currentMockPty;
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  chmodSync: vi.fn(),
}));

vi.mock("node:module", () => ({
  createRequire: vi.fn(() => ({
    resolve: vi.fn(() => "/fake/node_modules/node-pty/package.json"),
  })),
}));

import { createTerminalService } from "../src/services/terminalService";

describe("terminalService", () => {
  let service: ReturnType<typeof createTerminalService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createTerminalService();
  });

  describe("spawn", () => {
    it("creates a new session", () => {
      const session = service.spawn("s1", "/tmp");
      expect(session.id).toBe("s1");
      expect(service.has("s1")).toBe(true);
    });

    it("returns existing session if not replacing", () => {
      const first = service.spawn("s1", "/tmp");
      const second = service.spawn("s1", "/tmp");
      expect(first).toBe(second);
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
  });

  describe("write", () => {
    it("writes data to pty process", () => {
      service.spawn("s1", "/tmp");
      const pty = currentMockPty;
      service.write("s1", "ls\r");
      expect(pty.write).toHaveBeenCalledWith("ls\r");
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
    it("registers exit listener", () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      service.addExitListener("s1", listener);

      currentMockPty._emit("exit", { exitCode: 0, signal: 0 });
      expect(listener).toHaveBeenCalledWith({ exitCode: 0, signal: 0 });
    });

    it("returns noop for non-existent session", () => {
      const unsub = service.addExitListener("nonexistent", vi.fn());
      expect(typeof unsub).toBe("function");
    });

    it("removes listener on unsub", () => {
      service.spawn("s1", "/tmp");
      const listener = vi.fn();
      const unsub = service.addExitListener("s1", listener);
      unsub();
      currentMockPty._emit("exit", { exitCode: 1 });
      expect(listener).not.toHaveBeenCalled();
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
