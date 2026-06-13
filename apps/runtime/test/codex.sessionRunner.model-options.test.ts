import { describe, expect, it, vi } from "vitest";
import { buildCollaborationMode } from "../src/codex/collaborationMode";
import { getCodexModelCapabilities } from "../src/codex/modelCapabilities";

describe("Codex model options", () => {
  describe("buildCollaborationMode", () => {
    it("uses xhigh reasoning effort by default", () => {
      const mode = buildCollaborationMode("gpt-5.4", undefined);
      expect(mode.settings.reasoning_effort).toBe("xhigh");
    });

    it("accepts custom reasoning effort", () => {
      const mode = buildCollaborationMode("gpt-5.4", undefined, {
        reasoningEffort: "medium",
      });
      expect(mode.settings.reasoning_effort).toBe("medium");
    });

    it("accepts high reasoning effort", () => {
      const mode = buildCollaborationMode("gpt-5.4", undefined, {
        reasoningEffort: "high",
      });
      expect(mode.settings.reasoning_effort).toBe("high");
    });
  });

  describe("getCodexModelCapabilities", () => {
    it("returns reasoning effort descriptor", () => {
      const capabilities = getCodexModelCapabilities();
      expect(capabilities.optionDescriptors).toHaveLength(1);
      expect(capabilities.optionDescriptors[0]!.id).toBe("reasoningEffort");
      expect(capabilities.optionDescriptors[0]!.type).toBe("select");
    });
  });
});
