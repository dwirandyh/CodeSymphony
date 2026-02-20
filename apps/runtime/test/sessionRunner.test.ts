import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { __testing, runClaudeWithStreaming } from "../src/claude/sessionRunner";

describe("extractBashToolResult", () => {
  it("extracts stdout and stderr payloads", () => {
    const result = __testing.extractBashToolResult({
      stdout: "/tmp/project",
      stderr: "",
      interrupted: false,
    });

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/tmp/project");
    expect(result?.error).toBeUndefined();
    expect(result?.truncated).toBe(false);
  });

  it("treats string tool response as output", () => {
    const result = __testing.extractBashToolResult("/tmp/project");

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/tmp/project");
    expect(result?.error).toBeUndefined();
  });

  it("treats error-prefixed string as error output", () => {
    const result = __testing.extractBashToolResult("Error: Exit code 1");

    expect(result).not.toBeNull();
    expect(result?.output).toBeUndefined();
    expect(result?.error).toBe("Error: Exit code 1");
  });

  it("extracts text content payloads", () => {
    const result = __testing.extractBashToolResult({
      is_error: false,
      content: [
        {
          type: "text",
          text: "/Users/demo/project",
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.output).toBe("/Users/demo/project");
    expect(result?.error).toBeUndefined();
  });
});

describe("tool instrumentation", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.CLAUDE_CODE_EXECUTABLE = "node";
  });

  it("sanitizes sensitive keys and truncates long nested strings", () => {
    const sanitized = __testing.sanitizeForLog({
      apiKey: "top-secret",
      nested: {
        authorization: "Bearer token",
        content: "x".repeat(600),
      },
    }) as Record<string, unknown>;

    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect((sanitized.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect(typeof (sanitized.nested as Record<string, unknown>).content).toBe("string");
    expect(String((sanitized.nested as Record<string, unknown>).content).length).toBeLessThanOrEqual(503);
  });

  it("emits requested/decision/started/finished instrumentation events", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Read", { path: "README.md", token: "should-redact" }, {
          toolUseID: "tool-1",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-1" };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-1",
          tool_name: "Read",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0.3,
        };
        yield {
          type: "tool_use_summary",
          summary: "Read README.md",
          preceding_tool_use_ids: ["tool-1"],
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        };
      })();
    });

    const instrumentationEvents: Array<Record<string, unknown>> = [];
    await runClaudeWithStreaming({
      prompt: "read readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: (event) => {
        instrumentationEvents.push(event as unknown as Record<string, unknown>);
      },
    });

    const stages = instrumentationEvents.map((event) => event.stage);
    expect(stages).toContain("requested");
    expect(stages).toContain("decision");
    expect(stages).toContain("started");
    expect(stages).toContain("finished");

    const requested = instrumentationEvents.find((event) => event.stage === "requested");
    const preview = (requested?.preview as Record<string, unknown>) ?? {};
    expect((preview.input as Record<string, unknown>).token).toBe("[REDACTED]");

    const started = instrumentationEvents.find((event) => event.stage === "started");
    const startedPreview = (started?.preview as Record<string, unknown>) ?? {};
    expect(started?.toolName).toBe("Read");
    expect(startedPreview.startSource).toBe("sdk.stream.tool_progress");
  });

  it("emits started instrumentation from PreToolUse hook for non-bash tools", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Read", { path: "README.md" }, {
          toolUseID: "tool-hook-1",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        const hooks = options.hooks as {
          PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>, toolUseId: string) => Promise<{ continue: boolean }>> }>;
          PostToolUse: Array<{ hooks: Array<(input: Record<string, unknown>, toolUseId: string) => Promise<{ continue: boolean }>> }>;
        };
        const preToolUseHook = hooks.PreToolUse[0]?.hooks[0];
        const postToolUseHook = hooks.PostToolUse[0]?.hooks[0];

        await preToolUseHook?.(
          {
            hook_event_name: "PreToolUse",
            tool_use_id: "tool-hook-1",
            tool_name: "Read",
            tool_input: { path: "README.md" },
          },
          "tool-hook-1",
        );
        await postToolUseHook?.(
          {
            hook_event_name: "PostToolUse",
            tool_use_id: "tool-hook-1",
            tool_name: "Read",
            tool_input: { path: "README.md" },
            tool_response: "README content",
          },
          "tool-hook-1",
        );

        yield { type: "system", subtype: "init", session_id: "session-hook-1" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        };
      })();
    });

    const instrumentationEvents: Array<Record<string, unknown>> = [];
    const onToolFinished = vi.fn();
    await runClaudeWithStreaming({
      prompt: "read readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished,
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: (event) => {
        instrumentationEvents.push(event as unknown as Record<string, unknown>);
      },
    });

    const started = instrumentationEvents.find(
      (event) => event.stage === "started" && event.toolUseId === "tool-hook-1",
    );
    expect(started?.toolName).toBe("Read");
    expect((started?.preview as Record<string, unknown>)?.startSource).toBe("sdk.hook.pre_tool_use");
    expect(onToolFinished).toHaveBeenCalledWith(expect.objectContaining({ summary: "Read README.md" }));
  });

  it("includes search parameters in onToolStarted payload for search tools", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Glob", { pattern: "README.md", path: "apps/web/src" }, {
          toolUseID: "tool-glob-1",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-glob-1" };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-glob-1",
          tool_name: "Glob",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0.2,
        };
        yield {
          type: "tool_use_summary",
          summary: "Completed Glob",
          preceding_tool_use_ids: ["tool-glob-1"],
        };
      })();
    });

    const onToolStarted = vi.fn();
    await runClaudeWithStreaming({
      prompt: "find readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: () => { },
      onToolStarted,
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(onToolStarted).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "Glob",
      toolUseId: "tool-glob-1",
      searchParams: "pattern=README.md, path=apps/web/src",
    }));
  });

  it("includes edit target metadata for edit lifecycle events", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Edit", {
          file_path: "src/main.ts",
          old_string: "export const main = () => 1;",
          new_string: "export const main = () => 2;",
        }, {
          toolUseID: "tool-edit-1",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-edit-1" };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-edit-1",
          tool_name: "Edit",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0.1,
        };
        yield {
          type: "tool_use_summary",
          summary: "Edited src/main.ts",
          preceding_tool_use_ids: ["tool-edit-1"],
        };
      })();
    });

    const onToolStarted = vi.fn();
    const onToolFinished = vi.fn();
    await runClaudeWithStreaming({
      prompt: "update main",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: () => { },
      onToolStarted,
      onToolOutput: () => { },
      onToolFinished,
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(onToolStarted).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "Edit",
      toolUseId: "tool-edit-1",
      editTarget: "src/main.ts",
    }));
    expect(onToolFinished).toHaveBeenCalledWith(expect.objectContaining({
      summary: "Edited src/main.ts",
      precedingToolUseIds: ["tool-edit-1"],
      editTarget: "src/main.ts",
    }));
  });

  it("emits synthetic finish for incomplete non-bash lifecycle", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Read", { path: "README.md" }, {
          toolUseID: "tool-incomplete",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-2" };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-incomplete",
          tool_name: "Read",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0.5,
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "partial" }],
          },
        };
      })();
    });

    const instrumentationEvents: Array<Record<string, unknown>> = [];
    const onToolFinished = vi.fn();
    await runClaudeWithStreaming({
      prompt: "read readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished,
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: (event) => {
        instrumentationEvents.push(event as unknown as Record<string, unknown>);
      },
    });

    expect(onToolFinished).toHaveBeenCalled();
    const finished = instrumentationEvents.find((event) => event.stage === "finished");
    expect(finished).toBeDefined();
    const startedNotFinished = instrumentationEvents.find(
      (event) =>
        event.stage === "anomaly"
        && typeof event.anomaly === "object"
        && event.anomaly != null
        && (event.anomaly as Record<string, unknown>).code === "started_not_finished",
    );
    expect(startedNotFinished).toBeUndefined();
  });

  it("inserts newline separator between text blocks separated by tool use", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Read", { path: "config.yaml" }, {
          toolUseID: "tool-read-sep",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-sep" };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Let me read the file." },
          },
        };
        yield {
          type: "tool_progress",
          tool_use_id: "tool-read-sep",
          tool_name: "Read",
          parent_tool_use_id: null,
          elapsed_time_seconds: 0.3,
        };
        yield {
          type: "tool_use_summary",
          summary: "Read config.yaml",
          preceding_tool_use_ids: ["tool-read-sep"],
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "The file does not exist." },
          },
        };
      })();
    });

    const textChunks: string[] = [];
    const result = await runClaudeWithStreaming({
      prompt: "check config",
      sessionId: null,
      cwd: process.cwd(),
      onText: (chunk) => { textChunks.push(chunk); },
      onThinking: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    const fullText = textChunks.join("");
    expect(fullText).toContain("Let me read the file.\n\nThe file does not exist.");
    expect(result.output).toContain("Let me read the file.\n\nThe file does not exist.");
  });

  it("emits requested_not_started anomaly when tool is allowed but never starts", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string }>;
        await canUseTool("Read", { path: "README.md" }, {
          toolUseID: "tool-never-started",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        yield { type: "system", subtype: "init", session_id: "session-3" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        };
      })();
    });

    const instrumentationEvents: Array<Record<string, unknown>> = [];
    await runClaudeWithStreaming({
      prompt: "read readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: (event) => {
        instrumentationEvents.push(event as unknown as Record<string, unknown>);
      },
    });

    const anomalyEvent = instrumentationEvents.find(
      (event) =>
        event.stage === "anomaly"
        && typeof event.anomaly === "object"
        && event.anomaly != null
        && (event.anomaly as Record<string, unknown>).code === "requested_not_started",
    );
    expect(anomalyEvent).toBeDefined();
  });

  it("denies AskUserQuestion in default (execute) mode", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string; message?: string }>;
        const result = await canUseTool("AskUserQuestion", {
          questions: [{ question: "Which framework?" }],
        }, {
          toolUseID: "tool-question-1",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        expect(result.behavior).toBe("deny");
        expect(result.message).toContain("execute mode");

        yield { type: "system", subtype: "init", session_id: "session-q-deny" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I will proceed." }],
          },
        };
      })();
    });

    const onQuestionRequest = vi.fn();
    await runClaudeWithStreaming({
      prompt: "do something",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest,
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(onQuestionRequest).not.toHaveBeenCalled();
  });

  it("allows AskUserQuestion in plan mode", async () => {
    mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      return (async function* () {
        const canUseTool = options.canUseTool as (
          toolName: string,
          input: Record<string, unknown>,
          runtimeOptions: Record<string, unknown>,
        ) => Promise<{ behavior: string; updatedInput?: unknown }>;
        const result = await canUseTool("AskUserQuestion", {
          questions: [{ question: "Which framework?" }],
        }, {
          toolUseID: "tool-question-plan",
          blockedPath: null,
          decisionReason: null,
          suggestions: [],
        });

        expect(result.behavior).toBe("allow");

        yield { type: "system", subtype: "init", session_id: "session-q-allow" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Plan created." }],
          },
        };
      })();
    });

    const onQuestionRequest = vi.fn().mockResolvedValue({ answers: { "0": "React" } });
    await runClaudeWithStreaming({
      prompt: "plan something",
      sessionId: null,
      cwd: process.cwd(),
      permissionMode: "plan",
      onText: () => { },
      onThinking: () => { },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest,
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(onQuestionRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "tool-question-plan",
    }));
  });
});

describe("thinking_delta", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.CLAUDE_CODE_EXECUTABLE = "node";
  });

  it("forwards thinking_delta events to onThinking callback", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "session-think" };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "Let me think about this..." },
          },
          parent_tool_use_id: null,
          uuid: "uuid-think-1",
          session_id: "session-think",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: " I should check the file first." },
          },
          parent_tool_use_id: null,
          uuid: "uuid-think-2",
          session_id: "session-think",
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Here is the answer." },
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Here is the answer." }],
          },
        };
      })();
    });

    const thinkingChunks: string[] = [];
    const textChunks: string[] = [];
    await runClaudeWithStreaming({
      prompt: "complex question",
      sessionId: null,
      cwd: process.cwd(),
      onText: (chunk) => { textChunks.push(chunk); },
      onThinking: (chunk) => { thinkingChunks.push(chunk); },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(thinkingChunks).toEqual(["Let me think about this...", " I should check the file first."]);
    expect(textChunks.join("")).toBe("Here is the answer.");
  });

  it("skips thinking_delta from subagent (parent_tool_use_id set)", async () => {
    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "session-think-sub" };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "subagent thinking" },
          },
          parent_tool_use_id: "parent-tool-1",
          uuid: "uuid-sub-think",
          session_id: "session-think-sub",
        };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        };
      })();
    });

    const thinkingChunks: string[] = [];
    await runClaudeWithStreaming({
      prompt: "test",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => { },
      onThinking: (chunk) => { thinkingChunks.push(chunk); },
      onToolStarted: () => { },
      onToolOutput: () => { },
      onToolFinished: () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => { },
      onToolInstrumentation: () => { },
    });

    expect(thinkingChunks).toEqual([]);
  });
});
