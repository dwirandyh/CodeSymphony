import { describe, it, expect } from "vitest";
import { applyCursorModelOptions, dedupeCursorCatalogEntries, getCursorModelCapabilities, normalizeCursorCatalogModelId, parseCursorModelMetadata, resolveCursorSessionModelId } from "./modelCapabilities.js";

describe("parseCursorModelMetadata", () => {
  it("parses fast=true from model string", () => {
    const meta = parseCursorModelMetadata("composer-2.5[fast=true]");
    expect(meta.get("fast")).toBe("true");
    expect(meta.size).toBe(1);
  });

  it("parses reasoning and fast from model string", () => {
    const meta = parseCursorModelMetadata("gpt-5.5[context=272k,reasoning=high,fast=true]");
    expect(meta.get("context")).toBe("272k");
    expect(meta.get("reasoning")).toBe("high");
    expect(meta.get("fast")).toBe("true");
    expect(meta.size).toBe(3);
  });

  it("handles model without metadata brackets", () => {
    const meta = parseCursorModelMetadata("gpt-5.4");
    expect(meta.size).toBe(0);
  });

  it("handles empty metadata brackets", () => {
    const meta = parseCursorModelMetadata("default[]");
    expect(meta.size).toBe(0);
  });

  it("handles undefined", () => {
    const meta = parseCursorModelMetadata(undefined);
    expect(meta.size).toBe(0);
  });

  it("parses fast=false", () => {
    const meta = parseCursorModelMetadata("gpt-5.4[context=272k,reasoning=medium,fast=false]");
    expect(meta.get("fast")).toBe("false");
  });
});

describe("applyCursorModelOptions", () => {
  it("turns off fast mode", () => {
    const result = applyCursorModelOptions("composer-2.5[fast=true]", [
      { id: "fastMode", value: false },
    ]);
    expect(result).toBe("composer-2.5[fast=true]");
  });

  it("exposes fast toggle for composer models", () => {
    const capabilities = getCursorModelCapabilities("composer-2.5[fast=true]");
    const fastDescriptor = capabilities.optionDescriptors.find((descriptor) => descriptor.id === "fastMode");
    expect(fastDescriptor).toBeDefined();
    expect(fastDescriptor?.currentValue).toBe(true);
  });

  it("exposes fast toggle for bare composer ids defaulting to SDK fast default", () => {
    const capabilities = getCursorModelCapabilities("composer-2.5");
    const fastDescriptor = capabilities.optionDescriptors.find((descriptor) => descriptor.id === "fastMode");
    expect(fastDescriptor).toBeDefined();
    expect(fastDescriptor?.currentValue).toBe(true);
  });

  it("exposes reasoning effort from catalog hints when model id has no variant metadata", () => {
    const capabilities = getCursorModelCapabilities("claude-opus-4-8", {
      defaultVariantParams: { thinking: "medium" },
      parameters: [
        { id: "thinking", values: ["low", "medium", "high"] },
        { id: "fast", values: ["true", "false"] },
      ],
    });
    const effort = capabilities.optionDescriptors.find((descriptor) => descriptor.id === "reasoningEffort");
    expect(effort).toMatchObject({
      id: "reasoningEffort",
      type: "select",
      currentValue: "medium",
    });
    expect(capabilities.optionDescriptors.some((descriptor) => descriptor.id === "fastMode")).toBe(true);
  });

  it("dedupes stale composer catalog rows that only differ by fast metadata", () => {
    expect(dedupeCursorCatalogEntries([
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5[fast=false]", name: "Composer 2.5" },
      { id: "composer-2.5[fast=true]", name: "Composer 2.5 Fast" },
    ])).toEqual([{ id: "composer-2.5", name: "Composer 2.5" }]);
  });

  it("normalizes catalog ids to bare base model names", () => {
    expect(normalizeCursorCatalogModelId("composer-2.5[fast=true]")).toBe("composer-2.5");
    expect(normalizeCursorCatalogModelId("default[]")).toBe("default[]");
    expect(normalizeCursorCatalogModelId("gpt-5.5[context=272k,reasoning=medium,fast=true]")).toBe(
      "gpt-5.5",
    );
    expect(normalizeCursorCatalogModelId("claude-opus-4-8[reasoning=high,fast=true]")).toBe(
      "claude-opus-4-8",
    );
  });

  it("dedupes variant catalog rows that share the same base model id", () => {
    expect(dedupeCursorCatalogEntries([
      { id: "claude-opus-4-8", name: "Opus 4.8" },
      { id: "claude-opus-4-8[reasoning=low,fast=false]", name: "Opus 4.8" },
      { id: "claude-opus-4-8[reasoning=medium,fast=true]", name: "Opus 4.8" },
    ])).toEqual([{ id: "claude-opus-4-8", name: "Opus 4.8" }]);
  });

  it("resolves composer session model to bare id by default", () => {
    expect(resolveCursorSessionModelId("composer-2.5[fast=true]")).toBe("composer-2.5");
    expect(resolveCursorSessionModelId("composer-2.5[fast=true]", [{ id: "fastMode", value: false }])).toBe(
      "composer-2.5",
    );
  });

  it("resolves composer session model to fast variant when explicitly enabled", () => {
    expect(resolveCursorSessionModelId("composer-2.5", [{ id: "fastMode", value: true }])).toBe(
      "composer-2.5[fast=true]",
    );
  });

  it("turns on fast mode", () => {
    const result = applyCursorModelOptions("composer-2.5[fast=false]", [
      { id: "fastMode", value: true },
    ]);
    expect(result).toBe("composer-2.5[fast=true]");
  });

  it("adds fast mode to model that had none", () => {
    const result = applyCursorModelOptions("composer-2.5[]", [
      { id: "fastMode", value: true },
    ]);
    expect(result).toBe("composer-2.5[fast=true]");
  });

  it("returns same string when no options affect metadata", () => {
    const result = applyCursorModelOptions("composer-2.5[fast=true]", []);
    expect(result).toBe("composer-2.5[fast=true]");
  });

  it("changes reasoning effort", () => {
    const result = applyCursorModelOptions(
      "gpt-5.5[context=272k,reasoning=high,fast=true]",
      [{ id: "reasoningEffort", value: "medium" }],
    );
    expect(result).toBe("gpt-5.5[context=272k,reasoning=medium,fast=true]");
  });

  it("removes reasoning when set to none", () => {
    const result = applyCursorModelOptions(
      "gpt-5.5[context=272k,reasoning=high,fast=true]",
      [{ id: "reasoningEffort", value: "none" }],
    );
    expect(result).toBe("gpt-5.5[context=272k,fast=true]");
  });

  it("applies both fastMode and reasoningEffort together", () => {
    const result = applyCursorModelOptions(
      "gpt-5.5[context=272k,reasoning=high,fast=true]",
      [
        { id: "fastMode", value: false },
        { id: "reasoningEffort", value: "low" },
      ],
    );
    expect(result).toBe("gpt-5.5[context=272k,reasoning=low,fast=false]");
  });

  it("preserves unknown metadata keys", () => {
    const result = applyCursorModelOptions(
      "model[context=272k,custom=val,fast=true]",
      [{ id: "fastMode", value: false }],
    );
    expect(result).toBe("model[context=272k,custom=val,fast=false]");
  });
});
