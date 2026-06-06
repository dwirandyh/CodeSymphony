import { describe, expect, it } from "vitest";
import {
  ApprovePlanInputSchema,
  ApprovePlanResultSchema,
  AutomationSchema,
  BUILTIN_CHAT_MODELS_BY_AGENT,
  ClaudeModelCatalogSchema,
  CliAgentSchema,
  CodexModelCatalogSchema,
  CreateAutomationInputSchema,
  CreateChatThreadInputSchema,
  CreateModelProviderInputSchema,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  hasSameThreadSelection,
  MODEL_PROVIDER_AGENTS_BY_COMPATIBILITY,
  ModelProviderSchema,
  resolveApprovedPlanExecutionKind,
  shouldHandoffApprovedPlanExecution,
  shouldPreserveThreadSelectionSessionIds,
  supportsModelProviderCompatibility,
  TestModelProviderInputSchema,
  UpdateAutomationInputSchema,
  UpdateChatThreadAgentSelectionInputSchema,
  UpdateModelProviderInputSchema,
} from "./workflow.js";

describe("Cursor shared workflow schemas", () => {
  it("accepts cursor in the common agent schema", () => {
    expect(CliAgentSchema.parse("cursor")).toBe("cursor");
  });

  it("keeps shared built-in model catalogs empty so runtime can source them from each CLI", () => {
    expect(BUILTIN_CHAT_MODELS_BY_AGENT.claude).toEqual([]);
    expect(BUILTIN_CHAT_MODELS_BY_AGENT.codex).toEqual([]);
    expect(BUILTIN_CHAT_MODELS_BY_AGENT.cursor).toEqual([]);
    expect(BUILTIN_CHAT_MODELS_BY_AGENT.opencode).toEqual([]);
  });

  it("keeps the existing Claude default model id for persisted thread compatibility", () => {
    expect(DEFAULT_CHAT_MODEL_BY_AGENT.claude).toBe("claude-sonnet-4-6");
  });

  it("keeps Codex built-in models out of shared-types and requires runtime resolution", () => {
    expect(DEFAULT_CHAT_MODEL_BY_AGENT.codex).toBe("");
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

  it("maps provider compatibilities to supported agents", () => {
    expect(MODEL_PROVIDER_AGENTS_BY_COMPATIBILITY.anthropic).toEqual(["claude", "opencode"]);
    expect(MODEL_PROVIDER_AGENTS_BY_COMPATIBILITY.openai).toEqual(["codex", "opencode"]);
    expect(supportsModelProviderCompatibility("claude", "anthropic")).toBe(true);
    expect(supportsModelProviderCompatibility("claude", "openai")).toBe(false);
    expect(supportsModelProviderCompatibility("codex", "openai")).toBe(true);
    expect(supportsModelProviderCompatibility("opencode", "anthropic")).toBe(true);
  });

  it("accepts compatibility-based provider schemas", () => {
    expect(ModelProviderSchema.parse({
      id: "provider-1",
      name: "OpenAI",
      compatibility: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyMasked: "••••",
      models: [{
        id: "model-1",
        providerId: "provider-1",
        modelId: "gpt-5.4",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      compatibility: "openai",
      models: [{ modelId: "gpt-5.4" }],
    });

    expect(CreateModelProviderInputSchema.parse({
      name: "Anthropic",
      compatibility: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-test",
      models: [{ modelId: "claude-sonnet-4-6" }],
    })).toMatchObject({
      compatibility: "anthropic",
      models: [{ modelId: "claude-sonnet-4-6" }],
    });

    expect(UpdateModelProviderInputSchema.parse({
      name: "OpenAI Gateway",
      compatibility: "openai",
      baseUrl: "https://gateway.example/v1",
    })).toMatchObject({
      name: "OpenAI Gateway",
      compatibility: "openai",
    });

    expect(TestModelProviderInputSchema.parse({
      compatibility: "openai",
      baseUrl: "http://localhost:9999",
      apiKey: "key",
      modelId: "gpt-5.4",
    })).toMatchObject({
      compatibility: "openai",
      modelId: "gpt-5.4",
    });
  });

  it("accepts Codex model catalogs from the app-server", () => {
    expect(CodexModelCatalogSchema.parse({
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier model for complex coding.",
          hidden: false,
          isDefault: true,
        },
      ],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          hidden: false,
          isDefault: true,
        },
      ],
    });
  });

  it("accepts Claude model catalogs from the Claude CLI SDK", () => {
    expect(ClaudeModelCatalogSchema.parse({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
          description: "Use the default model.",
        },
        {
          id: "opus",
          name: "Opus",
          description: "Most capable for complex work.",
        },
      ],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
        },
        {
          id: "opus",
          name: "Opus",
        },
      ],
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

  it("accepts automation definitions and automation updates", () => {
    expect(CreateAutomationInputSchema.parse({
      repositoryId: "repo-1",
      targetWorktreeId: "worktree-1",
      targetMode: "worktree",
      name: "Daily audit",
      prompt: "Summarize repository issues.",
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "plan",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "Asia/Jakarta",
    })).toMatchObject({
      agent: "cursor",
      chatMode: "plan",
      targetMode: "worktree",
      timezone: "Asia/Jakarta",
    });

    expect(UpdateAutomationInputSchema.parse({
      prompt: "Summarize repository issues and propose fixes.",
      enabled: false,
    })).toMatchObject({
      prompt: "Summarize repository issues and propose fixes.",
      enabled: false,
    });

    expect(AutomationSchema.parse({
      id: "automation-1",
      repositoryId: "repo-1",
      targetWorktreeId: "worktree-1",
      targetMode: "repo_root",
      name: "Daily audit",
      prompt: "Summarize repository issues.",
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "plan",
      enabled: true,
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "Asia/Jakarta",
      dtstart: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-02T02:00:00.000Z",
      lastRunAt: null,
      latestRun: null,
      promptVersionCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      agent: "cursor",
      latestRun: null,
      promptVersionCount: 1,
      targetMode: "repo_root",
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
      currentModel: "gpt-5.4",
      currentModelProviderId: "provider-1",
      nextAgent: "codex",
      nextModel: "gpt-5.4",
      nextModelProviderId: "provider-1",
    })).toBe(true);

    expect(shouldPreserveThreadSelectionSessionIds({
      threadKind: "default",
      currentAgent: "codex",
      currentModel: "gpt-5.4",
      currentModelProviderId: "provider-1",
      nextAgent: "codex",
      nextModel: "gpt-5.4",
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
