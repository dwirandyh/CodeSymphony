import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockCodexChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill = vi.fn(() => {
    if (this.killed) {
      return true;
    }

    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", null, "SIGTERM");
    });
    return true;
  });
}

function attachJsonRpcServer(
  child: MockCodexChildProcess,
  options?: { onTurnStart?: () => void },
) {
  let buffer = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      const message = JSON.parse(line) as { id: string; method?: string };
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        continue;
      }

      if (message.method === "thread/start") {
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: "codex-thread-1",
            },
          },
        })}\n`);
        continue;
      }

      if (message.method === "turn/start") {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        options?.onTurnStart?.();
      }
    }
  });
}

describe("runCodexWithStreaming abort handling", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects promptly when aborted after turn start", async () => {
    const child = new MockCodexChildProcess();
    const abortController = new AbortController();
    attachJsonRpcServer(child, {
      onTurnStart: () => {
        queueMicrotask(() => {
          abortController.abort();
        });
      },
    });

    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCodexWithStreaming } = await import("../src/codex/sessionRunner");

    await expect(runCodexWithStreaming({
      prompt: "Inspect the repo, then stop.",
      sessionId: null,
      cwd: process.cwd(),
      abortController,
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onSubagentStarted: () => { },
      onSubagentStopped: () => { },
    })).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
