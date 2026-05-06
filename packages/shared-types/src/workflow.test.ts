import { describe, expect, it } from "vitest";
import {
  ApprovePlanInputSchema,
  ApprovePlanResultSchema,
  BUILTIN_CHAT_MODELS_BY_AGENT,
  CliAgentSchema,
  CreateChatThreadInputSchema,
  CreateModelProviderInputSchema,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  hasSameThreadSelection,
  ModelProviderSchema,
  resolveApprovedPlanExecutionKind,
  shouldHandoffApprovedPlanExecution,
  shouldPreserveThreadSelectionSessionIds,
  TestModelProviderInputSchema,
  UpdateChatThreadAgentSelectionInputSchema,
  UpdateModelProviderInputSchema,
} from "./workflow.js";

describe("Cursor shared workflow schemas", () => {
  it("accepts cursor in the common agent schema", () => {
    expect(CliAgentSchema.parse("cursor")).toBe("cursor");
  });

  it("declares non-empty built-in and default Cursor models", () => {
    const builtins = BUILTIN_CHAT_MODELS_BY_AGENT.cursor;
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins).toContain(DEFAULT_CHAT_MODEL_BY_AGENT.cursor);
  });

  it("accepts Cursor thread creation and agent-selection payloads", () => {
    expect(CreateChatThreadInputSchema.parse({
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    })).toMatchObject({
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    expect(UpdateChatThreadAgentSelectionInputSchema.parse({
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    })).toMatchObject({
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });
  });

  it("accepts Cursor across provider-facing schemas", () => {
    expect(ModelProviderSchema.parse({
      id: "provider-1",
      agent: "cursor",
      name: "Cursor Account",
      modelId: "default[]",
      baseUrl: null,
      apiKeyMasked: "",
      isActive: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      agent: "cursor",
      modelId: "default[]",
    });

    expect(CreateModelProviderInputSchema.parse({
      agent: "cursor",
      name: "Cursor Account",
      modelId: "default[]",
    })).toMatchObject({
      agent: "cursor",
      modelId: "default[]",
    });

    expect(UpdateModelProviderInputSchema.parse({
      agent: "cursor",
      modelId: "default[]",
    })).toMatchObject({
      agent: "cursor",
      modelId: "default[]",
    });

    expect(TestModelProviderInputSchema.parse({
      agent: "cursor",
      baseUrl: "http://localhost:9999",
      apiKey: "key",
      modelId: "default[]",
    })).toMatchObject({
      agent: "cursor",
      modelId: "default[]",
    });
  });

  it("accepts explicit plan execution target payloads and results", () => {
    expect(ApprovePlanInputSchema.parse({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    })).toMatchObject({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });

    expect(ApprovePlanResultSchema.parse({
      executionKind: "same_thread_switch",
      sourceThreadId: "t1",
      executionThreadId: "t1",
    })).toMatchObject({
      executionKind: "same_thread_switch",
      sourceThreadId: "t1",
      executionThreadId: "t1",
    });
  });

  it("shares the approved-plan handoff rules across runtime and web", () => {
    expect(shouldHandoffApprovedPlanExecution({
      messageCount: 1,
      threadKind: "default",
      sourceAgent: "codex",
      sourceModelProviderId: null,
      sourceProviderHasBaseUrl: false,
      targetAgent: "codex",
      targetModelProviderId: null,
    })).toBe(false);

    expect(shouldHandoffApprovedPlanExecution({
      messageCount: 1,
      threadKind: "default",
      sourceAgent: "claude",
      sourceModelProviderId: "provider-1",
      sourceProviderHasBaseUrl: true,
      targetAgent: "claude",
      targetModelProviderId: null,
    })).toBe(true);
  });

  it("compares thread selections and preserves session ids across same-source switches", () => {
    expect(hasSameThreadSelection({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: "provider-1",
    }, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: "provider-1",
    })).toBe(true);

    expect(hasSameThreadSelection({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: "provider-1",
    }, {
      agent: "codex",
      model: "gpt-5.4-mini",
      modelProviderId: "provider-1",
    })).toBe(false);

    expect(shouldPreserveThreadSelectionSessionIds({
      threadKind: "default",
      currentAgent: "codex",
      currentModelProviderId: "provider-1",
      nextAgent: "codex",
      nextModelProviderId: "provider-1",
    })).toBe(true);

    expect(shouldPreserveThreadSelectionSessionIds({
      threadKind: "default",
      currentAgent: "codex",
      currentModelProviderId: "provider-1",
      nextAgent: "codex",
      nextModelProviderId: null,
    })).toBe(false);
  });

  it("resolves approved-plan execution kind with explicit and automatic handoffs", () => {
    expect(resolveApprovedPlanExecutionKind({
      requestedExecutionKind: "handoff",
      messageCount: 0,
      threadKind: "default",
      sourceAgent: "codex",
      sourceModelProviderId: null,
      sourceProviderHasBaseUrl: false,
      targetAgent: "codex",
      targetModelProviderId: null,
    })).toBe("handoff");

    expect(resolveApprovedPlanExecutionKind({
      messageCount: 1,
      threadKind: "default",
      sourceAgent: "codex",
      sourceModelProviderId: null,
      sourceProviderHasBaseUrl: false,
      targetAgent: "codex",
      targetModelProviderId: null,
    })).toBe("same_thread_switch");

    expect(resolveApprovedPlanExecutionKind({
      messageCount: 1,
      threadKind: "default",
      sourceAgent: "claude",
      sourceModelProviderId: "provider-1",
      sourceProviderHasBaseUrl: true,
      targetAgent: "claude",
      targetModelProviderId: null,
    })).toBe("handoff");
  });
});
