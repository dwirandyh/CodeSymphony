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
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
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
  });

  it("emits started_not_finished anomaly when lifecycle is incomplete", async () => {
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
    await runClaudeWithStreaming({
      prompt: "read readme",
      sessionId: null,
      cwd: process.cwd(),
      onText: () => {},
      onToolStarted: () => {},
      onToolOutput: () => {},
      onToolFinished: () => {},
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: async () => ({ decision: "allow" }),
      onPlanFileDetected: () => {},
      onToolInstrumentation: (event) => {
        instrumentationEvents.push(event as unknown as Record<string, unknown>);
      },
    });

    const anomalyEvent = instrumentationEvents.find(
      (event) =>
        event.stage === "anomaly"
        && typeof event.anomaly === "object"
        && event.anomaly != null
        && (event.anomaly as Record<string, unknown>).code === "started_not_finished",
    );
    expect(anomalyEvent).toBeDefined();
  });
});
