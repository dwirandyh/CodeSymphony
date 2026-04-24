import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockCursorChild,
  resetFakeCursorAcpState,
} from "./support/fakeCursorAcp";

describe("runCursorWithStreaming abort handling", () => {
  afterEach(() => {
    resetFakeCursorAcpState();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("rejects promptly when the runtime aborts an active Cursor turn", async () => {
    let child: ReturnType<typeof createMockCursorChild> | null = null;
    const spawnMock = vi.fn(() => {
      child = createMockCursorChild({
        onPrompt: async ({ abortSignal }) => {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { stopReason: "cancelled" };
        },
      });
      return child;
    });
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const abortController = new AbortController();

    const runPromise = runCursorWithStreaming({
      prompt: "Inspect the repo until I stop you.",
      sessionId: null,
      cwd: "/tmp/project",
      abortController,
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    queueMicrotask(() => {
      abortController.abort();
    });

    await expect(runPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(child?.killed).toBe(true);
  });
});
