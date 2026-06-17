import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockCodexChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 4242;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

/**
 * Mirrors a failed Bun spawn where stdin is never writable: any attempt to
 * send a request throws synchronously, so the session settles via its
 * `finally` block before the async ENOENT 'error' event arrives.
 */
class DeadStdinCodexChildProcess extends EventEmitter {
  stdin = Object.assign(new PassThrough(), { writable: false });
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  pid = 4242;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

describe("withCodexAppServerSession spawn error handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects instead of crashing when codex binary is missing during model listing (ENOENT)", async () => {
    const child = new MockCodexChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { listCodexModels } = await import("../src/codex/sessionRunner");

    const enoent = Object.assign(
      new Error("spawn codex ENOENT"),
      { code: "ENOENT", syscall: "spawn codex" },
    );

    const listPromise = listCodexModels({ cwd: process.cwd() });

    // Emit the spawn failure asynchronously, mirroring Bun's behavior where
    // child.pid is assigned optimistically and 'error' fires on a later tick.
    queueMicrotask(() => {
      child.emit("error", enoent);
    });

    await expect(listPromise).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of crashing when codex binary is missing during slash command listing (ENOENT)", async () => {
    const child = new MockCodexChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { listCodexSlashCommands } = await import("../src/codex/sessionRunner");

    const enoent = Object.assign(
      new Error("spawn codex ENOENT"),
      { code: "ENOENT", syscall: "spawn codex" },
    );

    const listPromise = listCodexSlashCommands({ cwd: process.cwd() });

    queueMicrotask(() => {
      child.emit("error", enoent);
    });

    await expect(listPromise).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an error listener after the session settles so a late ENOENT cannot crash the process", async () => {
    // Reproduces the split-pane crash: Bun assigns child.pid optimistically and
    // queues the 'error' event for a later tick. stdin is dead, so the very
    // first sendRequest("initialize") throws and the session unwinds through its
    // `finally` (finish() -> child.removeAllListeners()) BEFORE Bun emits ENOENT.
    // With no listener left, emit("error") throws synchronously -> uncaught ->
    // runtime exit code 7.
    const child = new DeadStdinCodexChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { listCodexSlashCommands } = await import("../src/codex/sessionRunner");

    const enoent = Object.assign(
      new Error("spawn codex ENOENT"),
      { code: "ENOENT", syscall: "spawn codex" },
    );

    await expect(listCodexSlashCommands({ cwd: process.cwd() })).rejects.toBeInstanceOf(Error);

    // The session has settled and run its cleanup. A late ENOENT must not throw
    // (i.e. a listener must still be attached); otherwise it escapes as an
    // uncaughtException and kills the dev server.
    expect(() => child.emit("error", enoent)).not.toThrow();
  });
});
