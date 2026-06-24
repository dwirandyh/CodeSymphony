import { afterEach, describe, expect, it, vi } from "vitest";

const runCursorSdkTurnViaNodeProcess = vi.fn(async () => ({
  output: "node",
  sessionId: "agent-node",
}));

vi.mock("../src/cursor/sdk/nodeTurnBridge.js", () => ({
  runCursorSdkTurnViaNodeProcess,
}));

vi.mock("../src/cursor/sdk/nodeRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cursor/sdk/nodeRuntime.js")>();
  return {
    ...actual,
    shouldRunCursorSdkInNodeProcess: vi.fn(actual.shouldRunCursorSdkInNodeProcess),
  };
});

describe("Cursor SDK Bun node bridge routing", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("delegates SDK turns to a Node host when running under Bun", async () => {
    const { shouldRunCursorSdkInNodeProcess } = await import("../src/cursor/sdk/nodeRuntime.js");
    vi.mocked(shouldRunCursorSdkInNodeProcess).mockReturnValue(true);

    const { runCursorSdkTurn } = await import("../src/cursor/sdk/runTurn.js");
    const result = await runCursorSdkTurn({
      prompt: "hello",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      onText: vi.fn(),
      onToolStarted: vi.fn(),
      onToolOutput: vi.fn(),
      onToolFinished: vi.fn(),
      onQuestionRequest: vi.fn(async () => ({ answers: {} })),
      onPermissionRequest: vi.fn(async () => ({ decision: "allow" as const })),
    });

    expect(result.sessionId).toBe("agent-node");
    expect(runCursorSdkTurnViaNodeProcess).toHaveBeenCalledTimes(1);
  });
});