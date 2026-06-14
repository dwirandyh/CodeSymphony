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

describe("runCodexWithStreaming spawn error handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects instead of crashing when the codex binary is missing (ENOENT)", async () => {
    const child = new MockCodexChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { runCodexWithStreaming } = await import("../src/codex/sessionRunner");

    const enoent = Object.assign(
      new Error("spawn codex ENOENT"),
      { code: "ENOENT", syscall: "spawn codex" },
    );

    // Bun assigns child.pid optimistically, then emits 'error' asynchronously.
    // onProcessSpawned awaits (yields the event loop) so the error fires before
    // the completion-promise listener is attached — the exact crash scenario.
    const runPromise = runCodexWithStreaming({
      prompt: "Inspect the repo, then stop.",
      sessionId: null,
      cwd: process.cwd(),
      abortController: new AbortController(),
      permissionMode: "default",
      threadPermissionMode: "default",
      onProcessSpawned: async () => {
        await Promise.resolve();
        child.emit("error", enoent);
      },
      onText: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onSubagentStarted: () => { },
      onSubagentStopped: () => { },
    });

    await expect(runPromise).rejects.toMatchObject({ code: "ENOENT" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
