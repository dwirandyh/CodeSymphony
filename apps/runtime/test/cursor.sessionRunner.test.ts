import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockCursorChild,
  fakeCursorSessions,
  resetFakeCursorAcpState,
} from "./support/fakeCursorAcp";

describe("cursor session runner", () => {
  afterEach(() => {
    resetFakeCursorAcpState();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("lists slash commands and models from the Cursor ACP catalog", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      availableCommands: [
        { name: "dogfood", description: "QA a web app" },
        { name: "Excel", description: "Spreadsheet work" },
        { name: "dogfood", description: "Duplicate entry should collapse" },
      ],
      availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]", name: " " },
      ],
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { listCursorModels, listCursorSlashCommands } = await import("../src/cursor/sessionRunner");

    await expect(listCursorSlashCommands({
      cwd: "/tmp/project",
    })).resolves.toEqual([
      { name: "dogfood", description: "Duplicate entry should collapse", argumentHint: "" },
      { name: "Excel", description: "Spreadsheet work", argumentHint: "" },
    ]);

    await expect(listCursorModels({
      cwd: "/tmp/project",
    })).resolves.toEqual([
      { id: "default[]", name: "Auto" },
      { id: "gpt-5.4[context=272k,reasoning=medium,fast=false]", name: "gpt-5.4" },
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(1, "cursor-agent", ["acp"], expect.objectContaining({
      cwd: "/tmp/project",
    }));
  });

  it("streams text, tools, permission requests, and plan events from Cursor ACP", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]", name: "GPT-5.4" },
      ],
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitText(sessionId, "Scanning workspace.");
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "read_1",
          title: "Read README",
          kind: "read",
          status: "pending",
          locations: [{ path: "README.md" }],
          rawInput: { path: "README.md" },
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "read_1",
          status: "in_progress",
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "read_1",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "# README",
              },
            },
          ],
          rawOutput: { content: "# README" },
        });
        await agent.createPlan("Ship Cursor", "1. Inspect the workspace\n2. Report the plan");

        const permission = await agent.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "edit_1",
            title: "Edit config",
            kind: "edit",
            status: "pending",
            locations: [{ path: "src/config.ts" }],
            rawInput: {
              path: "src/config.ts",
              newString: "export const enabled = true;",
            },
            content: [],
          },
          options: [
            {
              kind: "allow_once",
              name: "Allow once",
              optionId: "allow",
            },
            {
              kind: "reject_once",
              name: "Reject",
              optionId: "reject",
            },
          ],
        });
        expect(permission).toEqual({
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        });

        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "edit_1",
          title: "Edit config",
          kind: "edit",
          status: "pending",
          locations: [{ path: "src/config.ts" }],
          rawInput: {
            path: "src/config.ts",
            newString: "export const enabled = true;",
          },
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "edit_1",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Applied change",
              },
            },
          ],
          rawOutput: { success: true },
        });
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const textChunks: string[] = [];
    const toolStarts: Array<Record<string, unknown>> = [];
    const toolOutputs: Array<Record<string, unknown>> = [];
    const toolFinishes: Array<Record<string, unknown>> = [];
    const permissionRequests: Array<Record<string, unknown>> = [];
    const plans: Array<Record<string, unknown>> = [];
    const sessionIds: string[] = [];

    const result = await runCursorWithStreaming({
      prompt: "Inspect this repo and propose a plan.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onSessionId: (sessionId) => {
        sessionIds.push(sessionId);
      },
      onText: (chunk) => {
        textChunks.push(chunk);
      },
      onToolStarted: (event) => {
        toolStarts.push(event as unknown as Record<string, unknown>);
      },
      onToolOutput: (event) => {
        toolOutputs.push(event as unknown as Record<string, unknown>);
      },
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async (event) => {
        permissionRequests.push(event as unknown as Record<string, unknown>);
        return { decision: "allow" };
      },
      onPlanFileDetected: (event) => {
        plans.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result).toEqual({
      output: "Scanning workspace.",
      sessionId: "cursor-session-1",
    });
    expect(sessionIds).toEqual(["cursor-session-1"]);
    expect(textChunks).toEqual(["Scanning workspace."]);
    expect(toolStarts.map((entry) => entry.toolName)).toEqual(["Read", "Edit"]);
    expect(toolOutputs).toHaveLength(1);
    expect(toolFinishes).toMatchObject([
      {
        toolName: "Read",
        summary: "Read README.md",
        output: "# README",
      },
      {
        toolName: "Edit",
        summary: "Edited src/config.ts",
        output: "Applied change",
      },
    ]);
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]).toMatchObject({
      toolName: "Edit",
      blockedPath: "src/config.ts",
      toolInput: {
        path: "src/config.ts",
        newString: "export const enabled = true;",
      },
    });
    expect(plans).toEqual([
      {
        filePath: ".cursor/plans/ship-cursor.plan.md",
        content: "1. Inspect the workspace\n2. Report the plan",
      },
    ]);
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("This thread uses on-request approvals.");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("Approval-gated edits and command execution should go through the runtime approval flow");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).not.toContain("Do not edit files or execute commands.");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("User request:\nInspect this repo and propose a plan.");
  });

  it("normalizes Cursor ACP elicitation requests into runtime question callbacks", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        const response = await agent.createFormElicitation({
          sessionId,
          message: "Need a few details before proceeding.",
          requestedSchema: {
            title: "Execution details",
            required: ["mode", "count", "confirmed", "notes", "targets"],
            properties: {
              mode: {
                type: "string",
                title: "Mode",
                description: "Which mode should I use?",
                oneOf: [
                  { const: "plan", title: "Plan" },
                  { const: "agent", title: "Agent" },
                ],
              },
              count: {
                type: "integer",
                title: "Count",
                description: "How many passes should I run?",
              },
              confirmed: {
                type: "boolean",
                title: "Confirmed",
                description: "Should I continue?",
              },
              notes: {
                type: "string",
                title: "Notes",
                description: "Anything else I should know?",
              },
              targets: {
                type: "array",
                title: "Targets",
                description: "Which surfaces should I touch?",
                items: {
                  anyOf: [
                    { const: "runtime", title: "Runtime" },
                    { const: "web", title: "Web" },
                  ],
                },
              },
            },
          },
        });

        expect(response).toEqual({
          action: "accept",
          content: {
            mode: "plan",
            count: 3,
            confirmed: true,
            notes: "Keep /skill intact",
            targets: ["runtime", "web"],
          },
        });

        await agent.emitText(sessionId, "Question flow complete.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const questionRequests: Array<Record<string, unknown>> = [];

    const result = await runCursorWithStreaming({
      prompt: "Ask me before acting.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async (payload) => {
        questionRequests.push(payload as unknown as Record<string, unknown>);
        const answers = Object.fromEntries(payload.questions.map((question) => {
          switch (question.question) {
            case "Which mode should I use?":
              return [question.question, "Plan"];
            case "How many passes should I run?":
              return [question.question, "3"];
            case "Should I continue?":
              return [question.question, "yes"];
            case "Anything else I should know?":
              return [question.question, "Keep /skill intact"];
            case "Which surfaces should I touch?":
              return [question.question, "Runtime, Web"];
            default:
              return [question.question, ""];
          }
        }));
        return { answers };
      },
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.output).toBe("Question flow complete.");
    expect(questionRequests).toHaveLength(1);
    expect(questionRequests[0]).toMatchObject({
      questions: [
        {
          question: "Which mode should I use?",
          header: "Mode",
          options: [
            { label: "Plan", description: "plan" },
            { label: "Agent", description: "agent" },
          ],
        },
        {
          question: "How many passes should I run?",
          header: "Count",
        },
        {
          question: "Should I continue?",
          header: "Confirmed",
        },
        {
          question: "Anything else I should know?",
          header: "Notes",
        },
        {
          question: "Which surfaces should I touch?",
          header: "Targets",
          multiSelect: true,
          options: [
            { label: "Runtime", description: "runtime" },
            { label: "Web", description: "web" },
          ],
        },
      ],
    });
  });

  it("loads an existing session and switches Cursor into agent mode for full access threads", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      availableModels: [
        { modelId: "default[]", name: "Auto" },
        { modelId: "gpt-5.4[context=272k,reasoning=medium,fast=false]", name: "GPT-5.4" },
      ],
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");

    const first = await runCursorWithStreaming({
      prompt: "Inspect only.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "deny" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    const second = await runCursorWithStreaming({
      prompt: "Ship it.",
      sessionId: first.sessionId,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "full_access",
      model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
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

    expect(second.sessionId).toBe(first.sessionId);
    expect(fakeCursorSessions.get(first.sessionId!)?.currentModeId).toBe("agent");
    expect(fakeCursorSessions.get(first.sessionId!)?.currentModelId).toBe("gpt-5.4[context=272k,reasoning=medium,fast=false]");
    expect(fakeCursorSessions.get(first.sessionId!)?.prompts.at(-1)).toBe("Ship it.");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported provider overrides with an actionable Cursor-specific error", async () => {
    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");

    await expect(runCursorWithStreaming({
      prompt: "Use a custom provider",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      providerBaseUrl: "https://example.invalid/v1",
      providerApiKey: "sk-test",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    })).rejects.toThrow("Cursor uses the authenticated Cursor account over ACP");
  });

  it("adds setup hints when the Cursor binary cannot be started", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        throw new Error("spawn cursor-agent ENOENT");
      },
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");

    await expect(runCursorWithStreaming({
      prompt: "Open Cursor",
      sessionId: null,
      cwd: "/tmp/project",
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
    })).rejects.toThrow("Cursor Agent CLI could not be started");
  });

  it("emits a fresh plan event when Cursor revises a persisted plan file via edit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cursor-plan-revise-"));
    const planPath = join(cwd, ".cursor/plans/revise-existing.plan.md");
    await mkdir(join(cwd, ".cursor/plans"), { recursive: true });
    await writeFile(planPath, "1. Initial plan", "utf8");
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const readFileMock = vi.fn(actualFs.readFile);
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      readFile: readFileMock,
    }));

    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "plan_edit_1",
          title: "Edit plan",
          kind: "edit",
          status: "pending",
          locations: [{ path: planPath }],
          rawInput: {
            path: planPath,
            oldString: "1. Initial plan",
            newString: "1. Revised plan\n2. Create cursor-plan-revise-b.txt",
          },
          content: [],
        });

        await writeFile(planPath, "1. Revised plan\n2. Create cursor-plan-revise-b.txt", "utf8");

        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "plan_edit_1",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Updated plan file",
              },
            },
          ],
          rawOutput: { success: true },
        });

        await agent.emitText(sessionId, "Plan revised.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const plans: Array<Record<string, unknown>> = [];

    const result = await runCursorWithStreaming({
      prompt: "Revise the plan.",
      sessionId: null,
      cwd,
      permissionMode: "plan",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: (event) => {
        plans.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.output).toBe("Plan revised.");
    expect(readFileMock).toHaveBeenCalledWith(planPath, "utf8");
    await vi.waitFor(() => {
      expect(plans).toEqual([
        {
          filePath: planPath,
          content: "1. Revised plan\n2. Create cursor-plan-revise-b.txt",
        },
      ]);
    });
  });

  it("exposes stable helper behavior for mode and plan normalization", async () => {
    const { __testing } = await import("../src/cursor/sessionRunner");

    expect(__testing.resolveCursorRuntimeMode({
      permissionMode: "default",
      threadPermissionMode: "default",
    })).toBe("agent");
    expect(__testing.resolveCursorRuntimeMode({
      permissionMode: "default",
      threadPermissionMode: "full_access",
    })).toBe("agent");
    expect(__testing.resolveCursorRuntimeMode({
      permissionMode: "plan",
      threadPermissionMode: "full_access",
    })).toBe("plan");

    expect(__testing.buildCursorPlanMarkdown([
      { content: "Inspect the repo", status: "completed" },
      { content: "Draft the plan", status: "in_progress" },
      { content: "Apply changes", status: "pending" },
    ])).toBe([
      "1. Inspect the repo (completed)",
      "2. Draft the plan (in progress)",
      "3. Apply changes",
    ].join("\n"));

    expect(__testing.buildCursorPrompt({
      prompt: "Need a plan",
      acpMode: "plan",
      threadPermissionMode: "default",
    })).toContain("You are in plan mode.");
    expect(__testing.buildCursorPrompt({
      prompt: "Create a file",
      acpMode: "agent",
      threadPermissionMode: "default",
    })).toContain("This thread uses on-request approvals.");
    expect(__testing.buildCursorPrompt({
      prompt: "Create a file",
      acpMode: "agent",
      threadPermissionMode: "full_access",
    })).toBe("Create a file");
    expect(__testing.stripCursorModelVariant("gpt-5.4[context=272k,reasoning=medium]")).toBe("gpt-5.4");
    expect(__testing.cursorAcpSupportsQuestionElicitation).toBe(true);
    expect(__testing.cursorAcpSupportsSubagentLifecycle).toBe(false);
  });
});
