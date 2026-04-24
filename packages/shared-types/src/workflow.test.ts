import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  CliAgentSchema,
  CreateChatThreadInputSchema,
  CreateModelProviderInputSchema,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  ModelProviderSchema,
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
});
