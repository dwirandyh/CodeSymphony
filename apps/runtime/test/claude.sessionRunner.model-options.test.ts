import { describe, expect, it } from "vitest";
import { getClaudeModelCapabilities } from "../src/claude/modelCapabilities";

describe("Claude model options", () => {
  describe("getClaudeModelCapabilities", () => {
    it("returns reasoning effort descriptor", () => {
      const capabilities = getClaudeModelCapabilities();
      const effortDescriptor = capabilities.optionDescriptors.find((d) => d.id === "reasoningEffort");
      expect(effortDescriptor).toBeDefined();
      expect(effortDescriptor!.type).toBe("select");
    });

    it("returns fast mode descriptor", () => {
      const capabilities = getClaudeModelCapabilities();
      const fastDescriptor = capabilities.optionDescriptors.find((d) => d.id === "fastMode");
      expect(fastDescriptor).toBeDefined();
      expect(fastDescriptor!.type).toBe("toggle");
    });

    it("has high as default effort", () => {
      const capabilities = getClaudeModelCapabilities();
      const effortDescriptor = capabilities.optionDescriptors.find((d) => d.id === "reasoningEffort");
      expect(effortDescriptor).toBeDefined();
      if (effortDescriptor!.type === "select") {
        expect(effortDescriptor!.currentValue).toBe("high");
      }
    });

    it("has fast mode off by default", () => {
      const capabilities = getClaudeModelCapabilities();
      const fastDescriptor = capabilities.optionDescriptors.find((d) => d.id === "fastMode");
      expect(fastDescriptor).toBeDefined();
      if (fastDescriptor!.type === "toggle") {
        expect(fastDescriptor!.currentValue).toBe(false);
      }
    });
  });
});
