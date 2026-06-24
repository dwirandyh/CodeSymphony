import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockClaudeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 5151;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe("createClaudeProcessSpawner", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("keeps a child error listener so a late abort error cannot crash the runtime", async () => {
    const child = new MockClaudeChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawn: spawnMock,
      };
    });

    const { __testing } = await import("../src/claude/sessionRunner.js");
    const spawnClaudeCodeProcess = __testing.createClaudeProcessSpawner({
      onStderr: () => {},
    });

    spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: new AbortController().signal,
    });

    const lateError = Object.assign(new Error("spawn aborted"), { code: "ABORT_ERR" });
    expect(() => child.emit("error", lateError)).not.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});