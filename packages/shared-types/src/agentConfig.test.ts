import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  TestAgentConfigInputSchema,
  UpdateAgentConfigInputSchema,
} from "./agentConfig.js";

describe("AgentConfigSchema", () => {
  it("accepts a masked config response", () => {
    const parsed = AgentConfigSchema.parse({
      claudePath: "/usr/local/bin/claude",
      codexPath: null,
      opencodePath: null,
      claudePathResolved: "/usr/local/bin/claude",
      codexPathResolved: "codex",
      opencodePathResolved: "opencode",
      cursorApiKeyMasked: "key-abc...7890",
      cursorApiKeySet: true,
      updatedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(parsed.claudePath).toBe("/usr/local/bin/claude");
    expect(parsed.cursorApiKeySet).toBe(true);
    expect(parsed.cursorApiKeyMasked).toBe("key-abc...7890");
    expect(parsed.codexPathResolved).toBe("codex");
  });

  it("never carries a plaintext cursor key field", () => {
    expect(Object.keys(AgentConfigSchema.shape)).not.toContain("cursorApiKey");
  });
});

describe("UpdateAgentConfigInputSchema", () => {
  it("treats all fields as optional (omitted = unchanged)", () => {
    const parsed = UpdateAgentConfigInputSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("allows empty strings to signal clearing a value", () => {
    const parsed = UpdateAgentConfigInputSchema.parse({
      claudePath: "",
      cursorApiKey: "",
    });
    expect(parsed.claudePath).toBe("");
    expect(parsed.cursorApiKey).toBe("");
  });

  it("accepts plaintext values for all fields", () => {
    const parsed = UpdateAgentConfigInputSchema.parse({
      claudePath: "/bin/claude",
      codexPath: "/bin/codex",
      opencodePath: "/bin/opencode",
      cursorApiKey: "secret-key",
    });
    expect(parsed).toEqual({
      claudePath: "/bin/claude",
      codexPath: "/bin/codex",
      opencodePath: "/bin/opencode",
      cursorApiKey: "secret-key",
    });
  });
});

describe("TestAgentConfigInputSchema", () => {
  it("requires an agent and a value", () => {
    const parsed = TestAgentConfigInputSchema.parse({
      agent: "claude",
      value: "/usr/local/bin/claude",
    });
    expect(parsed.agent).toBe("claude");
    expect(parsed.value).toBe("/usr/local/bin/claude");
  });

  it("rejects unknown agents", () => {
    expect(() =>
      TestAgentConfigInputSchema.parse({ agent: "unknown", value: "x" }),
    ).toThrow();
  });
});
