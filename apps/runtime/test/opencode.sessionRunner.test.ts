import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../src/opencode/sessionRunner";
import { DEFAULT_CHAT_MODEL_BY_AGENT } from "@codesymphony/shared-types";
import {
  createMockCursorChild,
  fakeCursorSessions,
  resetFakeCursorAcpState,
} from "./support/fakeCursorAcp";

class MockOpencodeServerProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  pid = 43210;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = vi.fn(() => {
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit("exit", 0, null);
    });
    return true;
  });

  announce(url: string) {
    this.stdout.write(`opencode server listening on ${url}\n`);
  }
}

describe("opencode session runner config", () => {
  afterEach(() => {
    resetFakeCursorAcpState();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("defaults OpenCode threads to a free built-in model", () => {
    expect(DEFAULT_CHAT_MODEL_BY_AGENT.opencode).toBe("opencode/minimax-m2.5-free");
  });

  it("applies ask permissions to both build and plan agents for default threads", () => {
    const { config, agent, model } = __testing.buildOpencodeRuntimeConfig({
      permissionMode: "default",
      threadPermissionMode: "default",
      model: "opencode/minimax-m2.5-free",
    });

    expect(agent).toBe("build");
    expect(model).toEqual({
      providerID: "opencode",
      modelID: "minimax-m2.5-free",
    });
    expect(config.permission).toEqual({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      doom_loop: "ask",
      external_directory: "ask",
    });
    expect(config.agent?.build?.permission).toEqual(config.permission);
    expect(config.agent?.plan?.permission).toEqual(config.permission);
  });

  it("applies allow permissions to both build and plan agents for full access threads", () => {
    const { config } = __testing.buildOpencodeRuntimeConfig({
      permissionMode: "default",
      threadPermissionMode: "full_access",
      model: "opencode/minimax-m2.5-free",
    });

    expect(config.permission).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    });
    expect(config.agent?.build?.permission).toEqual(config.permission);
    expect(config.agent?.plan?.permission).toEqual(config.permission);
  });

  it("extracts session ids from headless SDK delta and permission events", () => {
    expect(__testing.getEventSessionId({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_delta",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "hello",
      },
    })).toBe("ses_delta");

    expect(__testing.getEventSessionId({
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID: "ses_perm",
        permission: "bash",
        patterns: ["pwd"],
        always: ["pwd *"],
        metadata: {},
        tool: {
          messageID: "msg_1",
          callID: "call_1",
        },
      },
    })).toBe("ses_perm");
  });

  it("normalizes headless SDK permission requests", () => {
    expect(__testing.derivePermissionBlockedPath({
      id: "perm_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["pwd > /tmp/out.txt"],
      always: ["pwd *"],
      metadata: {},
      tool: {
        messageID: "msg_1",
        callID: "call_1",
      },
    })).toBe("pwd > /tmp/out.txt");

    expect(__testing.normalizePermissionRequest({
      id: "perm_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["pwd > /tmp/out.txt"],
      always: ["pwd *"],
      metadata: {},
      tool: {
        messageID: "msg_1",
        callID: "call_1",
      },
    })).toEqual({
      requestId: "perm_1",
      callId: "call_1",
      toolNameFallback: "bash",
      toolInput: {
        command: "pwd > /tmp/out.txt",
      },
      blockedPath: "pwd > /tmp/out.txt",
    });
  });

  it("uses ACP plan updates for plan-mode OpenCode threads", async () => {
    const plans: Array<Record<string, unknown>> = [];
    const planPath = "/tmp/project/.opencode/plans/171-run-plan.md";
    const planContent = [
      "# Final Plan",
      "",
      "1. Inspect event pipeline",
      "2. Draft plan card fix",
    ].join("\n");

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createMockCursorChild({
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
        availableModels: [
          { modelId: "opencode/minimax-m2.5-free", name: "OpenCode/Minimax M2.5 Free" },
        ],
        onPrompt: async ({ agent, sessionId }) => {
          await agent.emitText(sessionId, "Inspecting repo.");
          await agent.emitToolCall(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "tool_plan_write",
            title: "write",
            kind: "edit",
            status: "pending",
            locations: [{ path: planPath }],
            rawInput: {
              filePath: planPath,
              content: planContent,
            },
          });
          await agent.emitToolCallUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool_plan_write",
            title: "write",
            kind: "edit",
            status: "completed",
            locations: [{ path: planPath }],
            rawInput: {
              filePath: planPath,
              content: planContent,
            },
            rawOutput: {
              output: "Plan file written.",
            },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planContent,
              },
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Plan file written.",
                },
              },
            ],
          });
          await agent.emitPlan(sessionId, [
            { content: "Inspect event pipeline", status: "completed" },
            { content: "Draft plan card fix", status: "in_progress" },
          ]);
          expect(plans).toHaveLength(0);
          await agent.emitToolCall(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "tool_plan_exit",
            title: "plan_exit",
            kind: "other",
            status: "pending",
            rawInput: {},
          });
          await agent.emitToolCallUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool_plan_exit",
            title: "plan_exit",
            kind: "other",
            status: "completed",
            rawInput: {},
            rawOutput: {
              output: "User approved switching to build agent.",
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "User approved switching to build agent.",
                },
              },
            ],
          });
        },
      })),
    }));
    vi.doMock("@opencode-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@opencode-ai/sdk")>("@opencode-ai/sdk");
      return {
        ...actual,
        createOpencodeServer: vi.fn(async () => {
          throw new Error("SDK transport should not run in ACP plan mode");
        }),
      };
    });

    const { runOpencodeWithStreaming } = await import("../src/opencode/sessionRunner");

    const result = await runOpencodeWithStreaming({
      prompt: "Need deterministic plan handling.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "plan",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: (payload) => {
        plans.push(payload as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result).toEqual({
      output: "Inspecting repo.",
      sessionId: "cursor-session-1",
    });
    expect(fakeCursorSessions.get("cursor-session-1")?.currentModeId).toBe("plan");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts.at(-1)).toBe("Need deterministic plan handling.");
    expect(plans).toEqual([
      {
        filePath: planPath,
        content: planContent,
        source: "claude_plan_file",
      },
    ]);
  });

  it("does not emit a plan card for draft OpenCode plan files without plan_exit", async () => {
    const plans: Array<Record<string, unknown>> = [];
    const planPath = "/tmp/project/.opencode/plans/171-draft-only.md";
    const planContent = [
      "# Draft Plan",
      "",
      "1. Inspect event pipeline",
      "2. Ask one clarification question",
    ].join("\n");

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createMockCursorChild({
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
        availableModels: [
          { modelId: "opencode/minimax-m2.5-free", name: "OpenCode/Minimax M2.5 Free" },
        ],
        onPrompt: async ({ agent, sessionId }) => {
          await agent.emitToolCallUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool_plan_write",
            title: "write",
            kind: "edit",
            status: "completed",
            locations: [{ path: planPath }],
            rawInput: {
              filePath: planPath,
              content: planContent,
            },
            content: [
              {
                type: "diff",
                path: planPath,
                oldText: "",
                newText: planContent,
              },
            ],
          });
          expect(plans).toHaveLength(0);
          await agent.emitText(sessionId, "What specific handoff are you referring to?");
        },
      })),
    }));
    vi.doMock("@opencode-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@opencode-ai/sdk")>("@opencode-ai/sdk");
      return {
        ...actual,
        createOpencodeServer: vi.fn(async () => {
          throw new Error("SDK transport should not run in ACP plan mode");
        }),
      };
    });

    const { runOpencodeWithStreaming } = await import("../src/opencode/sessionRunner");

    const result = await runOpencodeWithStreaming({
      prompt: "Need deterministic plan handling.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "plan",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: (payload) => {
        plans.push(payload as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result).toEqual({
      output: "What specific handoff are you referring to?",
      sessionId: "cursor-session-1",
    });
    expect(plans).toEqual([]);
  });

  it("falls back to final OpenCode markdown plans even when they end with an approval question", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createMockCursorChild({
        availableModes: [
          { id: "build", name: "Build" },
          { id: "plan", name: "Plan" },
        ],
        availableModels: [
          { modelId: "opencode/minimax-m2.5-free", name: "OpenCode/Minimax M2.5 Free" },
        ],
        onPrompt: async ({ agent, sessionId }) => {
          await agent.emitText(sessionId, [
            "Berdasarkan analisis codebase, saya sudah memahami masalah dan solusinya. Berikut implementation plan:",
            "",
            "---",
            "",
            "## Implementation Plan: Perbaiki False Positive Plan Card saat Assistant Hanya Bertanya Klarifikasi",
            "",
            "### Masalah Inti",
            "",
            "1. Ketatkan classifier klarifikasi pada fallback plan detection.",
            "2. Sinkronkan filter di web dan chat-timeline-core.",
            "3. Tambahkan regression test untuk clarification-shaped outputs.",
            "",
            "---",
            "",
            "Apakah saya harus lanjut ke implementation, atau ada yang ingin ditanyakan/diklarifikasi dulu?",
          ].join("\n"));
        },
      })),
    }));
    vi.doMock("@opencode-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@opencode-ai/sdk")>("@opencode-ai/sdk");
      return {
        ...actual,
        createOpencodeServer: vi.fn(async () => {
          throw new Error("SDK transport should not run in ACP plan mode");
        }),
      };
    });

    const { runOpencodeWithStreaming } = await import("../src/opencode/sessionRunner");
    const plans: Array<Record<string, unknown>> = [];

    const result = await runOpencodeWithStreaming({
      prompt: "Need deterministic plan handling.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "plan",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: (payload) => {
        plans.push(payload as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.sessionId).toBe("cursor-session-1");
    expect(result.output).toContain("## Implementation Plan: Perbaiki False Positive Plan Card");
    expect(plans).toEqual([
      {
        filePath: ".opencode/plans/opencode-plan.md",
        content: [
          "Berdasarkan analisis codebase, saya sudah memahami masalah dan solusinya. Berikut implementation plan:",
          "",
          "---",
          "",
          "## Implementation Plan: Perbaiki False Positive Plan Card saat Assistant Hanya Bertanya Klarifikasi",
          "",
          "### Masalah Inti",
          "",
          "1. Ketatkan classifier klarifikasi pada fallback plan detection.",
          "2. Sinkronkan filter di web dan chat-timeline-core.",
          "3. Tambahkan regression test untuk clarification-shaped outputs.",
        ].join("\n"),
        source: "streaming_fallback",
      },
    ]);
  });

  it("falls back to SDK transport for plan-mode threads with custom provider overrides", async () => {
    const spawnMock = vi.fn(() => {
      const child = new MockOpencodeServerProcess();
      queueMicrotask(() => {
        child.announce("http://127.0.0.1:9999");
      });
      return child;
    });
    const createOpencodeServer = vi.fn(async () => ({
      url: "http://127.0.0.1:9999",
      close: vi.fn(),
    }));
    const promptAsync = vi.fn(async () => ({}));
    const createOpencodeClient = vi.fn(() => ({
      session: {
        create: vi.fn(async () => ({ data: { id: "sdk-session-1" } })),
        messages: vi.fn(async () => ({ data: [] })),
        promptAsync,
        abort: vi.fn(async () => ({})),
      },
      event: {
        subscribe: vi.fn(async () => ({
          stream: (async function* () {
            yield {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_1",
                  sessionID: "sdk-session-1",
                  role: "assistant",
                },
              },
            };
            yield {
              type: "message.part.updated",
              properties: {
                delta: "SDK fallback.",
                part: {
                  id: "part_1",
                  sessionID: "sdk-session-1",
                  messageID: "msg_1",
                  type: "text",
                  text: "SDK fallback.",
                },
              },
            };
            yield {
              type: "session.idle",
              properties: {
                sessionID: "sdk-session-1",
              },
            };
          })(),
        })),
      },
      postSessionIdPermissionsPermissionId: vi.fn(async () => ({})),
    }));

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));
    vi.doMock("@opencode-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@opencode-ai/sdk")>("@opencode-ai/sdk");
      return {
        ...actual,
        createOpencodeServer,
        createOpencodeClient,
      };
    });

    const { runOpencodeWithStreaming } = await import("../src/opencode/sessionRunner");

    const result = await runOpencodeWithStreaming({
      prompt: "Need deterministic plan handling with custom provider.",
      promptWithAttachments: [
        "Need deterministic plan handling with custom provider.",
        "",
        '<attachment filename="screen.png" type="image/png" path="/tmp/screen.png">[Image saved at path. Use Read tool to view.]</attachment>',
      ].join("\n"),
      attachments: [
        {
          filename: "screen.png",
          mimeType: "image/png",
          content: "",
          storagePath: "/tmp/screen.png",
        },
      ],
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "plan",
      threadPermissionMode: "default",
      providerBaseUrl: "http://localhost:11434/v1",
      providerApiKey: "test-key",
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

    expect(result).toEqual({
      output: "SDK fallback.",
      sessionId: "sdk-session-1",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(createOpencodeServer).not.toHaveBeenCalled();
    expect(createOpencodeClient).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "screen.png",
            url: "file:///tmp/screen.png",
          },
          {
            type: "text",
            text: "Need deterministic plan handling with custom provider.",
          },
        ],
      }),
    }));
  });
});
