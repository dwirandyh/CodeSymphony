import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    const sentMessage = fakeCursorSdkAgents.get("agent-1")?.sends[0]?.message as string;
    // Prompt is steered to use the ask tool but preserved verbatim at the tail.
    expect(sentMessage).toContain("ask_user_question");
    expect(sentMessage.endsWith("Draft plan.")).toBe(true);
    expect(fakeCursorSdkAgents.get("agent-1")?.sends[0]).toMatchObject({
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

  it("emits plan-mode inline text as a plan when no plan file was written", async () => {
    configureFakeCursorSdk({
      onSend: ({ run }) => {
        run.push({
          type: "assistant",
          agent_id: run.agentId,
          run_id: run.id,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "## Plan\n\n1. Add a README note about local-first dev." }],
          },
        });
      },
    });
    const callbacks = createCallbacks();

    await runCursorSdkTurn({
      prompt: "Draft a plan and ask for approval.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      ...callbacks,
    });

    expect(callbacks.onPlanFileDetected).toHaveBeenCalledTimes(1);
    expect(callbacks.onPlanFileDetected).toHaveBeenCalledWith(expect.objectContaining({
      content: "## Plan\n\n1. Add a README note about local-first dev.",
      source: "streaming_fallback",
    }));
  });

  it("does not emit a fallback plan in default (execute) mode", async () => {
    configureFakeCursorSdk({
      onSend: ({ run }) => {
        run.push({
          type: "assistant",
          agent_id: run.agentId,
          run_id: run.id,
          message: { role: "assistant", content: [{ type: "text", text: "Some prose." }] },
        });
      },
    });
    const callbacks = createCallbacks();

    await runCursorSdkTurn({
      prompt: "Do the thing.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "default",
      threadPermissionMode: "default",
      ...callbacks,
    });

    expect(callbacks.onPlanFileDetected).not.toHaveBeenCalled();
  });

  it("does not double-emit a fallback plan when a plan file was already detected", async () => {
    const planRelativePath = join(".cursor", "plans", "feature.plan.md");
    const worktree = await mkdtemp(path.join(os.tmpdir(), "cs-runturn-plan-"));
    const planAbsolutePath = path.join(worktree, planRelativePath);
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(path.join(worktree, ".cursor", "plans"), { recursive: true })
        .then(() => writeFile(planAbsolutePath, "# Real plan\n", "utf8")),
    );

    configureFakeCursorSdk({
      onSend: ({ run }) => {
        run.push({
          type: "assistant",
          agent_id: run.agentId,
          run_id: run.id,
          message: { role: "assistant", content: [{ type: "text", text: "wrote the plan file" }] },
        });
        run.push({
          type: "tool_call",
          agent_id: run.agentId,
          run_id: run.id,
          call_id: "plan 1",
          name: "Write",
          status: "completed",
          args: { path: planRelativePath },
          result: { content: `Plan saved to ${pathToFileURL(planAbsolutePath).href}` },
        });
      },
    });
    const callbacks = createCallbacks();

    try {
      await runCursorSdkTurn({
        prompt: "Draft a plan.",
        sessionId: null,
        cwd: worktree,
        apiKey: "cursor-key",
        permissionMode: "plan",
        ...callbacks,
      });

      // Only the file-based detection fires; no streaming_fallback double-emit.
      expect(callbacks.onPlanFileDetected).toHaveBeenCalledTimes(1);
      expect(callbacks.onPlanFileDetected).toHaveBeenCalledWith(expect.objectContaining({
        filePath: planAbsolutePath,
      }));
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
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

  it("installs and removes the worktree .cursor/hooks.json gate for default-mode permissions", async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "cs-runturn-wt-"));
    const hooksPath = path.join(worktree, ".cursor", "hooks.json");
    const callbacks = createCallbacks();
    let hookDuringTurn: unknown = null;

    configureFakeCursorSdk({
      onSend: async () => {
        // Capture the hooks file while the turn is still in-flight.
        hookDuringTurn = JSON.parse(await readFile(hooksPath, "utf8"));
      },
    });

    try {
      const result = await runCursorSdkTurn({
        prompt: "Use a tool.",
        sessionId: null,
        cwd: worktree,
        apiKey: "cursor-key",
        permissionMode: "default",
        threadPermissionMode: "default",
        ...callbacks,
      });

      expect(result).toEqual({ output: "", sessionId: "agent-1" });
      // Gate present during the turn, registers only preToolUse...
      expect((hookDuringTurn as { hooks: { preToolUse: unknown[] } }).hooks.preToolUse).toHaveLength(1);
      // Agent cwd is the worktree (no ephemeral second cwd).
      expect(fakeCursorSdkCreateRequests[0]).toMatchObject({
        local: {
          cwd: worktree,
          settingSources: ["project", "user"],
        },
      });
      // ...and is cleaned up after the turn.
      await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("loads user-scope skills (e.g. ~/.agents/skills) in plan mode without a hook project", async () => {
    const result = await runCursorSdkTurn({
      prompt: "Draft plan.",
      sessionId: null,
      cwd: "/tmp/project",
      apiKey: "cursor-key",
      permissionMode: "plan",
      ...createCallbacks(),
    });

    expect(result.sessionId).toBe("agent-1");
    expect(fakeCursorSdkCreateRequests[0]).toMatchObject({
      local: {
        cwd: "/tmp/project",
        settingSources: ["project", "user"],
      },
    });
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
