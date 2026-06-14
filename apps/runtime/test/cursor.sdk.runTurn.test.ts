import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeCursorSdkModule,
  configureFakeCursorSdk,
  fakeCursorSdkAgents,
  fakeCursorSdkCreateRequests,
  fakeCursorSdkRuns,
  resetFakeCursorSdkState,
} from "./support/fakeCursorSdk.js";
import { disposeAllCursorSdkAgents } from "../src/cursor/sdk/agentPool.js";
import { runCursorSdkTurn } from "../src/cursor/sdk/runTurn.js";
import { getRuntimeDebugEntries, resetRuntimeDebugLog } from "../src/routes/debug.js";

vi.mock("@cursor/sdk", () => FakeCursorSdkModule);

function createCallbacks() {
  return {
    onText: vi.fn(),
    onToolStarted: vi.fn(),
    onToolOutput: vi.fn(),
    onToolFinished: vi.fn(),
    onQuestionRequest: vi.fn(async () => ({ answers: {} })),
    onPermissionRequest: vi.fn(async () => ({ decision: "allow" as const })),
    onPlanFileDetected: vi.fn(),
    onTodoUpdate: vi.fn(),
    onSubagentStarted: vi.fn(),
    onSubagentStopped: vi.fn(),
  };
}

describe("Cursor SDK run turn", () => {
  beforeEach(() => {
    resetFakeCursorSdkState();
    resetRuntimeDebugLog({ clearFile: false });
  });

  afterEach(async () => {
    await disposeAllCursorSdkAgents();
    resetFakeCursorSdkState();
    resetRuntimeDebugLog({ clearFile: false });
  });

  it("sends plan mode and maps text plus TodoWrite results", async () => {
    configureFakeCursorSdk({
      onSend: ({ run }) => {
        run.push({
          type: "assistant",
          agent_id: "agent-1",
          run_id: run.id,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Plan saved." }],
          },
        });
        run.push({
          type: "tool_call",
          agent_id: "agent-1",
          run_id: run.id,
          call_id: "todo 1",
          name: "TodoWrite",
          status: "completed",
          result: "- **PENDING**: Write SDK bridge tests (id: todo-1)",
        });
      },
    });
    const callbacks = createCallbacks();

    const result = await runCursorSdkTurn({
      prompt: "Draft plan.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      ...callbacks,
    });

    expect(result).toEqual({ output: "Plan saved.", sessionId: "agent-1" });
    expect(fakeCursorSdkAgents.get("agent-1")?.sends[0]).toMatchObject({
      message: "Draft plan.",
      options: { mode: "plan" },
    });
    expect(callbacks.onText).toHaveBeenCalledWith("Plan saved.");
    expect(callbacks.onTodoUpdate).toHaveBeenCalledWith({
      agent: "cursor",
      groupId: "cursor-sdk:todo1",
      explanation: null,
      anchorToolUseId: "todo1",
      items: [{
        id: "todo-1",
        content: "Write SDK bridge tests",
        status: "pending",
      }],
    });
  });

  it("retries once when the SDK stream fails with NGHTTP2_FRAME_SIZE_ERROR", async () => {
    let attempt = 0;
    configureFakeCursorSdk({
      onSend: ({ run }) => {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR");
          (error as { code?: string }).code = "ERR_HTTP2_STREAM_ERROR";
          throw error;
        }
        run.push({
          type: "assistant",
          agent_id: run.agentId,
          run_id: run.id,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered." }],
          },
        });
      },
    });
    const callbacks = createCallbacks();

    const result = await runCursorSdkTurn({
      prompt: "Do the thing.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      ...callbacks,
    });

    expect(attempt).toBe(2);
    expect(result.output).toBe("Recovered.");
    expect(callbacks.onText).toHaveBeenCalledWith("Recovered.");
  });

  it("gives up after exhausting NGHTTP2 retries and surfaces the error", async () => {
    let attempt = 0;
    configureFakeCursorSdk({
      onSend: () => {
        attempt += 1;
        const error = new Error("[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR");
        (error as { code?: string }).code = "ERR_HTTP2_STREAM_ERROR";
        throw error;
      },
    });

    await expect(runCursorSdkTurn({
      prompt: "Do the thing.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      ...createCallbacks(),
    })).rejects.toThrow(/NGHTTP2_FRAME_SIZE_ERROR/);

    expect(attempt).toBe(3);
  });

  it("cancels the SDK run when aborted before streaming", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(runCursorSdkTurn({
      prompt: "Keep working.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      abortController,
      ...createCallbacks(),
    })).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });

    expect(fakeCursorSdkRuns[0]?.status).toBe("cancelled");
  });

  it("uses a per-turn project hook settings root for default-mode permissions", async () => {
    const callbacks = createCallbacks();

    const result = await runCursorSdkTurn({
      prompt: "Use a tool.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "default",
      threadPermissionMode: "default",
      ...callbacks,
    });

    expect(result).toEqual({ output: "", sessionId: "agent-1" });
    expect(fakeCursorSdkCreateRequests[0]).toMatchObject({
      local: {
        cwd: [
          "/tmp/project",
          expect.stringContaining("codesymphony-cursor-sdk-permissions-"),
        ],
        settingSources: ["project"],
      },
    });
    expect(fakeCursorSdkAgents.get("agent-1")?.closed).toBe(true);
  });

  it("emits cursor.sdk debug entries on a successful turn", async () => {
    configureFakeCursorSdk({
      onSend: ({ run }) => {
        run.push({
          type: "assistant",
          agent_id: "agent-1",
          run_id: run.id,
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        });
      },
    });

    await runCursorSdkTurn({
      prompt: "Hi",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      ...createCallbacks(),
    });

    const entries = getRuntimeDebugEntries();
    const sources = entries.map((entry) => entry.source);
    expect(sources).toContain("cursor.sdk.turnStart");
    expect(sources).toContain("cursor.sdk.turnCompleted");
    const startEntry = entries.find((entry) => entry.source === "cursor.sdk.turnStart");
    expect(startEntry?.data).toMatchObject({
      sdkModel: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      mode: "plan",
      hasSessionId: false,
    });
  });

  it("emits cursor.sdk.turnError when the SDK throws after retries", async () => {
    configureFakeCursorSdk({
      onSend: () => {
        throw new Error("Invalid params");
      },
    });

    await expect(runCursorSdkTurn({
      prompt: "Boom",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
      ...createCallbacks(),
    })).rejects.toThrow(/Invalid params/);

    const entries = getRuntimeDebugEntries();
    const errorEntry = entries.find((entry) => entry.source === "cursor.sdk.turnError");
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.data).toMatchObject({
      error: expect.stringContaining("Invalid params"),
      sdkModel: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    });
  });
});
