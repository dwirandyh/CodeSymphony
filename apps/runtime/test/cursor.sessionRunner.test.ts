import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockCursorChild,
  fakeCursorNewSessionRequests,
  fakeCursorSessions,
  MockCursorChild,
  resetFakeCursorAcpState,
} from "./support/fakeCursorAcp";

describe("cursor session runner", () => {
  afterEach(() => {
    resetFakeCursorAcpState();
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("passes configured MCP servers into new Cursor ACP sessions", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "cursor-mcp-home-"));
    await mkdir(join(tempHome, ".cursor"), { recursive: true });
    await writeFile(join(tempHome, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        Context7: {
          url: "https://mcp.context7.com/mcp",
          headers: {},
        },
        maestro: {
          command: "maestro",
          args: ["mcp"],
        },
      },
    }));
    vi.stubEnv("HOME", tempHome);

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createMockCursorChild({
        onPrompt: async ({ agent, sessionId }) => {
          await agent.emitText(sessionId, "Done.");
        },
      })),
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");

    await expect(runCursorWithStreaming({
      prompt: "Use configured MCP servers.",
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
    })).resolves.toMatchObject({
      output: "Done.",
      sessionId: "cursor-session-1",
    });

    expect(fakeCursorNewSessionRequests).toHaveLength(1);
    expect(fakeCursorNewSessionRequests[0]?.mcpServers).toEqual([
      {
        type: "http",
        name: "Context7",
        url: "https://mcp.context7.com/mcp",
        headers: [],
      },
      {
        name: "maestro",
        command: "maestro",
        args: ["mcp"],
        env: [],
      },
    ]);
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
    const todoUpdates: Array<Record<string, unknown>> = [];
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
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
    expect(todoUpdates).toEqual([]);
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("This thread uses on-request approvals.");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("Approval-gated edits and command execution should go through the runtime approval flow");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).not.toContain("Do not edit files or execute commands.");
    expect(fakeCursorSessions.get("cursor-session-1")?.prompts[0]).toContain("User request:\nInspect this repo and propose a plan.");
  });

  it("keeps a stable todo group across repeated Cursor ACP plan snapshots", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitPlan(sessionId, [
          { content: "Inspect the workspace", status: "in_progress" },
          { content: "Render todo row", status: "pending" },
        ]);
        await agent.emitPlan(sessionId, [
          { content: "Inspect the workspace", status: "completed" },
          { content: "Render todo row", status: "in_progress" },
        ]);
        await agent.emitText(sessionId, "Done.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];

    const result = await runCursorWithStreaming({
      prompt: "Inspect this repo and propose a plan.",
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.output).toBe("Done.");
    expect(todoUpdates).toHaveLength(2);
    expect(todoUpdates[0]?.groupId).toBe(todoUpdates[1]?.groupId);
    expect(todoUpdates[1]).toMatchObject({
      agent: "cursor",
      explanation: null,
      items: [
        { content: "Inspect the workspace", status: "completed" },
        { content: "Render todo row", status: "in_progress" },
      ],
    });
  });

  it("emits todo updates from Cursor TodoWrite tool results", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "todo_1",
          title: "TodoWrite",
          status: "pending",
          _meta: {
            args: {
              todos: [
                { id: "update-timestamp", content: "Update README timestamp", status: "completed" },
                { id: "remove-last-edited", content: "Remove Last Edited", status: "completed" },
                { id: "verify-diff", content: "Verify diff", status: "in_progress" },
              ],
            },
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "todo_1",
          title: "TodoWrite",
          status: "completed",
          rawOutput: {
            success: {
              todos: [
                { id: "update-timestamp", content: "Update README timestamp", status: "TODO_STATUS_COMPLETED" },
                { id: "remove-last-edited", content: "Remove Last Edited", status: "TODO_STATUS_COMPLETED" },
                { id: "verify-diff", content: "Verify diff", status: "TODO_STATUS_IN_PROGRESS" },
              ],
            },
          },
          content: [],
        } as never);

        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "todo_2",
          title: "TodoWrite",
          status: "pending",
          rawInput: {
            merge: true,
            todos: [
              { id: "verify-diff", content: "Verify diff", status: "completed" },
            ],
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "todo_2",
          title: "TodoWrite",
          status: "completed",
          rawOutput: {
            output: {
              success: {
                todos: [
                  { id: "update-timestamp", content: "Update README timestamp", status: "TODO_STATUS_COMPLETED" },
                  { id: "remove-last-edited", content: "Remove Last Edited", status: "TODO_STATUS_COMPLETED" },
                  { id: "verify-diff", content: "Verify diff", status: "TODO_STATUS_COMPLETED" },
                ],
              },
            },
          },
          content: [],
        } as never);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Implement approved plan.",
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(todoUpdates).toHaveLength(2);
    expect(todoUpdates[0]?.groupId).toBe(todoUpdates[1]?.groupId);
    expect(todoUpdates[0]).toMatchObject({
      agent: "cursor",
      explanation: null,
      items: [
        { id: "update-timestamp", content: "Update README timestamp", status: "completed" },
        { id: "remove-last-edited", content: "Remove Last Edited", status: "completed" },
        { id: "verify-diff", content: "Verify diff", status: "in_progress" },
      ],
    });
    expect(todoUpdates[1]).toMatchObject({
      agent: "cursor",
      items: [
        { id: "update-timestamp", content: "Update README timestamp", status: "completed" },
        { id: "remove-last-edited", content: "Remove Last Edited", status: "completed" },
        { id: "verify-diff", content: "Verify diff", status: "completed" },
      ],
    });
  });

  it("emits todo updates from Cursor Update TODOs tool presentation", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "tool_c03e64e3-1b7e-4c92-ab61-be9a92fe83e",
          title: "Update TODOs",
          status: "pending",
          rawInput: {
            _toolName: "updateTodos",
            merge: true,
            todos: [
              { id: "read-timestamp", status: "completed" },
              { id: "update-readme", status: "in_progress" },
            ],
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool_c03e64e3-1b7e-4c92-ab61-be9a92fe83e",
          title: "Update TODOs",
          status: "completed",
          rawOutput: {
            success: {
              todos: [
                { id: "read-timestamp", content: "Ambil waktu lokal saat implementasi", status: "TODO_STATUS_COMPLETED" },
                { id: "update-readme", content: "Ganti baris **Last Updated:** di README.md", status: "TODO_STATUS_IN_PROGRESS" },
                { id: "verify-readme", content: "Verifikasi README.md menampilkan timestamp terbaru", status: "TODO_STATUS_PENDING" },
              ],
            },
          },
          content: [],
        } as never);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];
    const toolFinishes: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Implement approved plan.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(todoUpdates).toHaveLength(1);
    expect(todoUpdates[0]).toMatchObject({
      agent: "cursor",
      explanation: null,
      items: [
        { id: "read-timestamp", content: "Ambil waktu lokal saat implementasi", status: "completed" },
        { id: "update-readme", content: "Ganti baris **Last Updated:** di README.md", status: "in_progress" },
        { id: "verify-readme", content: "Verifikasi README.md menampilkan timestamp terbaru", status: "pending" },
      ],
    });
    expect(toolFinishes.map((entry) => entry.toolName)).toEqual(["Update TODOs"]);
  });

  it("emits todo updates from Cursor Update TODOs highLevelToolCallResult meta", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "tool_0f260d1f-881f-42ce-99e4-d9c045632fe",
          title: "Update TODOs",
          status: "pending",
          rawInput: { _toolName: "updateTodos", merge: true, todos: [{ id: "update-timestamp", status: "completed" }] },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool_0f260d1f-881f-42ce-99e4-d9c045632fe",
          title: "Update TODOs",
          status: "completed",
          _meta: {
            highLevelToolCallResult: {
              output: {
                success: {
                  todos: [
                    {
                      id: "update-timestamp",
                      content: "Update baris **Last Updated:** di README.md",
                      status: "TODO_STATUS_COMPLETED",
                    },
                  ],
                },
              },
              isError: false,
            },
          },
          content: [],
        } as never);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Implement approved plan.",
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(todoUpdates).toHaveLength(1);
    expect(todoUpdates[0]).toMatchObject({
      agent: "cursor",
      items: [
        { id: "update-timestamp", content: "Update baris **Last Updated:** di README.md", status: "completed" },
      ],
    });
  });

  it("emits todo updates from Cursor Update TODOs tool result content text", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "tool_0f260d1f-881f-42ce-99e4-d9c045632fe",
          title: "Update TODOs",
          status: "pending",
          rawInput: { _toolName: "updateTodos" },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool_0f260d1f-881f-42ce-99e4-d9c045632fe",
          title: "Update TODOs",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Successfully updated TODOs.\n\nHere are the latest contents of your todo list:\n- **COMPLETED**: Update baris `**Last Updated:**` di README.md ke waktu saat implementasi (format YYYY-MM-DD HH:MM) (id: update-timestamp)",
              },
            },
          ],
        } as never);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Implement approved plan.",
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(todoUpdates).toHaveLength(1);
    expect(todoUpdates[0]).toMatchObject({
      agent: "cursor",
      items: [
        {
          id: "update-timestamp",
          content: "Update baris `**Last Updated:**` di README.md ke waktu saat implementasi (format YYYY-MM-DD HH:MM)",
          status: "completed",
        },
      ],
    });
  });

  it("preserves TodoWrite args when completed update strips rawInput to _toolName", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "tool_927699af-97db-43c1-a96c-e6b657807d6",
          title: "Update TODOs",
          status: "pending",
          rawInput: {
            _toolName: "updateTodos",
            merge: true,
            todos: [
              {
                id: "update-timestamp",
                content: "Edit README.md line 20: **Last Updated:** to current local datetime (YYYY-MM-DD HH:MM)",
                status: "completed",
              },
              {
                id: "verify-diff",
                content: "Confirm git diff shows only the timestamp line changed",
                status: "completed",
              },
            ],
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool_927699af-97db-43c1-a96c-e6b657807d6",
          title: "Update TODOs",
          status: "in_progress",
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool_927699af-97db-43c1-a96c-e6b657807d6",
          title: "Update TODOs",
          status: "completed",
          rawInput: {
            _toolName: "updateTodos",
          },
          content: [],
        } as never);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const todoUpdates: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Implement approved plan.",
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
      onTodoUpdate: (event) => {
        todoUpdates.push(event as unknown as Record<string, unknown>);
      },
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(todoUpdates).toHaveLength(1);
    expect(todoUpdates[0]).toMatchObject({
      agent: "cursor",
      items: [
        {
          id: "update-timestamp",
          content: "Edit README.md line 20: **Last Updated:** to current local datetime (YYYY-MM-DD HH:MM)",
          status: "completed",
        },
        {
          id: "verify-diff",
          content: "Confirm git diff shows only the timestamp line changed",
          status: "completed",
        },
      ],
    });
  });

  it("enriches Cursor terminal tool calls from rawOutput instead of the generic Terminal placeholder", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "terminal_1",
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: {},
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "terminal_1",
          status: "completed",
          rawOutput: {
            exitCode: 0,
            stdout: "/tmp/project\nhello-from-cursor\n",
            stderr: "",
          },
          content: [],
        });
        await agent.emitText(sessionId, "Done.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const toolStarts: Array<Record<string, unknown>> = [];
    const toolFinishes: Array<Record<string, unknown>> = [];

    const result = await runCursorWithStreaming({
      prompt: "Run a quick terminal command.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "full_access",
      onText: () => {},
      onToolStarted: (event) => {
        toolStarts.push(event as unknown as Record<string, unknown>);
      },
      onToolOutput: () => {},
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.output).toBe("Done.");
    expect(toolStarts).toMatchObject([
      {
        toolName: "Bash",
        shell: "bash",
        isBash: true,
      },
    ]);
    expect(toolStarts[0]?.command).toBeUndefined();
    expect(toolFinishes).toMatchObject([
      {
        toolName: "Bash",
        summary: "Ran terminal command",
        output: "/tmp/project\nhello-from-cursor\n",
        shell: "bash",
        isBash: true,
      },
    ]);
    expect(toolFinishes[0]?.command).toBeUndefined();
  });

  it("preserves Cursor vendor-shaped tool args and raw text results", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "read_1",
          title: "Read File",
          kind: "read",
          status: "pending",
          _meta: {
            args: {
              path: "/tmp/project/README.md",
            },
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "read_1",
          status: "completed",
          rawOutput: {
            content: "# README",
          },
          content: [],
        });

        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "grep_1",
          title: "Grep",
          kind: "search",
          status: "pending",
          _meta: {
            args: {
              pattern: "Last Updated",
              path: "/tmp/project",
            },
          },
          content: [],
        } as never);
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "grep_1",
          status: "completed",
          rawOutput: {
            result: "./README.md\n  20:**Last Updated:** 2026-04-02 16:33",
          },
          content: [],
        });
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const toolStarts: Array<Record<string, unknown>> = [];
    const toolFinishes: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Inspect README.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: (event) => {
        toolStarts.push(event as unknown as Record<string, unknown>);
      },
      onToolOutput: () => {},
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(toolStarts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolUseId: "read_1",
        toolName: "Read",
        editTarget: "/tmp/project/README.md",
      }),
      expect.objectContaining({
        toolUseId: "grep_1",
        toolName: "Grep",
        searchParams: "Last Updated",
      }),
    ]));
    expect(toolFinishes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        precedingToolUseIds: ["read_1"],
        summary: "Read /tmp/project/README.md",
        toolInput: {
          path: "/tmp/project/README.md",
        },
        output: "# README",
      }),
      expect.objectContaining({
        precedingToolUseIds: ["grep_1"],
        summary: "Searched /tmp/project",
        toolInput: {
          pattern: "Last Updated",
          path: "/tmp/project",
        },
        searchParams: "Last Updated",
        output: "./README.md\n  20:**Last Updated:** 2026-04-02 16:33",
      }),
    ]));
  });

  it("normalizes Cursor MCP and web-search tool calls for the timeline", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "web_1",
          title: "Web",
          kind: "search",
          status: "pending",
          rawInput: {
            query: "OpenAI Codex CLI official GitHub npm",
          },
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "web_1",
          status: "completed",
          rawInput: {
            query: "OpenAI Codex CLI official GitHub npm",
          },
          rawOutput: {
            content: "Search complete.",
          },
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Search complete.",
              },
            },
          ],
        });

        await agent.emitToolCall(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "mcp_1",
          title: "MCP",
          kind: "other",
          status: "pending",
          rawInput: {
            server: "context7",
            tool: "resolve-library-id",
            query: "react",
          },
          content: [],
        });
        await agent.emitToolCallUpdate(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "mcp_1",
          status: "completed",
          rawInput: {
            server: "context7",
            tool: "resolve-library-id",
            query: "react",
          },
          rawOutput: {
            content: "Resolved library id.",
          },
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Resolved library id.",
              },
            },
          ],
        });

        await agent.emitText(sessionId, "Done.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const toolStarts: Array<Record<string, unknown>> = [];
    const toolFinishes: Array<Record<string, unknown>> = [];

    const result = await runCursorWithStreaming({
      prompt: "Use MCP and web search.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: (event) => {
        toolStarts.push(event as unknown as Record<string, unknown>);
      },
      onToolOutput: () => {},
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(result.output).toBe("Done.");
    expect(toolStarts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolUseId: "web_1",
        toolName: "WebSearch",
        toolKind: "web_search",
        searchParams: "OpenAI Codex CLI official GitHub npm",
      }),
      expect.objectContaining({
        toolUseId: "mcp_1",
        toolName: "context7.resolve-library-id",
        toolKind: "mcp",
      }),
    ]));
    expect(toolFinishes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        precedingToolUseIds: ["web_1"],
        toolName: "WebSearch",
        toolKind: "web_search",
        searchParams: "OpenAI Codex CLI official GitHub npm",
        summary: "Searched OpenAI Codex CLI official GitHub npm",
      }),
      expect.objectContaining({
        precedingToolUseIds: ["mcp_1"],
        toolName: "context7.resolve-library-id",
        toolKind: "mcp",
        summary: "Ran context7.resolve-library-id",
        output: "Resolved library id.",
      }),
    ]));
  });

  it("keeps specific Cursor MCP titles when later updates fall back to generic labels", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => createMockCursorChild({
        onPrompt: async ({ agent, sessionId }) => {
          await agent.emitToolCall(sessionId, {
            sessionUpdate: "tool_call",
            toolCallId: "mcp_1",
            title: "context7_resolve-library-id",
            kind: "other",
            rawInput: {},
            content: [],
            status: "pending",
          });
          await agent.emitToolCallUpdate(sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: "mcp_1",
            title: "MCP: tool",
            kind: "other",
            status: "completed",
            rawInput: {},
            content: [],
          });
        },
      })),
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const toolFinishes: Array<Record<string, unknown>> = [];

    await runCursorWithStreaming({
      prompt: "Use MCP.",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: (event) => {
        toolFinishes.push(event as unknown as Record<string, unknown>);
      },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(toolFinishes).toEqual([
      expect.objectContaining({
        toolName: "context7.resolve-library-id",
        toolKind: "mcp",
        summary: "Ran context7.resolve-library-id",
      }),
    ]);
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
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("routes reused Cursor ACP connection updates to the current run callbacks", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      onPrompt: async ({ agent, sessionId, promptText }) => {
        await agent.emitText(sessionId, `reply:${promptText}`);
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    const firstChunks: string[] = [];
    const secondChunks: string[] = [];

    const first = await runCursorWithStreaming({
      prompt: "first",
      sessionId: null,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: (chunk) => {
        firstChunks.push(chunk);
      },
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    await runCursorWithStreaming({
      prompt: "second",
      sessionId: first.sessionId,
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onText: (chunk) => {
        secondChunks.push(chunk);
      },
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onSubagentStarted: () => {},
      onSubagentStopped: () => {},
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(firstChunks).toHaveLength(1);
    expect(secondChunks).toHaveLength(1);
    expect(firstChunks[0]).toContain("User request:\nfirst");
    expect(secondChunks[0]).toContain("User request:\nsecond");
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

  it("adds setup hints when the Cursor catalog child emits a spawn error", async () => {
    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const child = new MockCursorChild();
        queueMicrotask(() => {
          child.emit("error", new Error("spawn cursor-agent ENOENT"));
        });
        return child;
      },
    }));

    const { listCursorSlashCommands } = await import("../src/cursor/sessionRunner");

    await expect(listCursorSlashCommands({
      cwd: "/tmp/project",
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
    expect(__testing.toolNameFromCursorKind(null, "Terminal")).toBe("Bash");
    expect(__testing.buildCursorPrompt({
      prompt: "Create a file",
      acpMode: "agent",
      threadPermissionMode: "full_access",
    })).toBe("Create a file");
    expect(__testing.stripCursorModelVariant("gpt-5.4[context=272k,reasoning=medium]")).toBe("gpt-5.4");
    expect(__testing.cursorAcpSupportsQuestionElicitation).toBe(true);
    expect(__testing.cursorAcpSupportsSubagentLifecycle).toBe(false);

    expect(__testing.parseCursorPlanTodosFromExecutePrompt(
      "The user has approved the following plan. Please execute it now:\n\n1. Update README timestamp\n2. Verify diff (in progress)",
    )).toEqual([
      { id: null, content: "Update README timestamp", status: "pending" },
      { id: null, content: "Verify diff", status: "in_progress" },
    ]);

    expect(__testing.extractTodoItemsFromCursorStoreRecord({
      role: "tool",
      id: "tool_abc",
      providerOptions: {
        cursor: {
          highLevelToolCallResult: {
            output: {
              success: {
                todos: [
                  { id: "todo-1", content: "Ship it", status: "TODO_STATUS_COMPLETED" },
                ],
              },
            },
          },
        },
      },
    }, "tool_abc", [])).toEqual([
      { id: "todo-1", content: "Ship it", status: "completed" },
    ]);
  });

  it("sends native image prompt blocks when Cursor advertises image prompt support", async () => {
    const spawnMock = vi.fn(() => createMockCursorChild({
      promptCapabilities: {
        image: true,
      },
      onPrompt: async ({ agent, sessionId }) => {
        await agent.emitText(sessionId, "Image received.");
      },
    }));
    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const { runCursorWithStreaming } = await import("../src/cursor/sessionRunner");
    await runCursorWithStreaming({
      prompt: "Inspect the dropped image.",
      promptWithAttachments: [
        "Inspect the dropped image.",
        "",
        '<attachment filename="screen.png" type="image/png" path="/tmp/screen.png">[Image saved at path. Use Read tool to view.]</attachment>',
      ].join("\n"),
      attachments: [
        {
          filename: "screen.png",
          mimeType: "image/png",
          content: Buffer.from("image-bytes").toString("base64"),
          storagePath: "/tmp/screen.png",
        },
      ],
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
    });

    const promptBlocks = fakeCursorSessions.get("cursor-session-1")?.promptBlocks[0] as Array<Record<string, unknown>> | undefined;
    expect(promptBlocks).toBeDefined();
    expect(promptBlocks).toMatchObject([
      {
        type: "image",
        data: Buffer.from("image-bytes").toString("base64"),
        mimeType: "image/png",
        uri: "/tmp/screen.png",
      },
      {
        type: "text",
      },
    ]);
    expect((promptBlocks?.[1]?.text as string) ?? "").toContain("User request:\nInspect the dropped image.");
  });
});
