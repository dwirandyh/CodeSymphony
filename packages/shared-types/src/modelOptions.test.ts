import { describe, expect, it } from "vitest";
import {
  buildProviderOptionSelectionsFromDescriptors,
  buildThreadModelOptionsKey,
  formatModelOptionsDisplaySummary,
  formatModelOptionsSummaryForSelector,
  formatReasoningEffortDisplayLabel,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
  isFastModeEnabled,
  resolveThreadModelOptions,
} from "./modelOptions.js";
import { getCursorModelCapabilities, resolveModelCapabilities } from "./modelCapabilities.js";
import { ModelCapabilitiesSchema, ProviderOptionSelectionSchema } from "./workflow.js";

describe("model option helpers", () => {
  it("resolves selected effort over descriptor default", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
      ],
    });

    const selections = [
      ProviderOptionSelectionSchema.parse({ id: "reasoningEffort", value: "high" }),
    ];

    expect(
      getProviderOptionStringSelectionValue(capabilities, selections, "reasoningEffort"),
    ).toBe("high");
  });

  it("falls back to descriptor currentValue when no selection", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
      ],
    });

    expect(
      getProviderOptionStringSelectionValue(capabilities, [], "reasoningEffort"),
    ).toBe("medium");
  });

  it("returns undefined for missing descriptor", () => {
    const capabilities = ModelCapabilitiesSchema.parse({ optionDescriptors: [] });
    expect(
      getProviderOptionStringSelectionValue(capabilities, [], "reasoningEffort"),
    ).toBeUndefined();
  });

  it("resolves boolean fastMode selection", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "fastMode",
          label: "Fast mode",
          type: "toggle",
          currentValue: false,
        },
      ],
    });

    const selections = [
      ProviderOptionSelectionSchema.parse({ id: "fastMode", value: true }),
    ];

    expect(
      getProviderOptionBooleanSelectionValue(capabilities, selections, "fastMode"),
    ).toBe(true);
  });

  it("falls back to boolean descriptor default", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "fastMode",
          label: "Fast mode",
          type: "toggle",
          currentValue: true,
        },
      ],
    });

    expect(
      getProviderOptionBooleanSelectionValue(capabilities, [], "fastMode"),
    ).toBe(true);
  });

  it("returns undefined for missing boolean descriptor", () => {
    const capabilities = ModelCapabilitiesSchema.parse({ optionDescriptors: [] });
    expect(
      getProviderOptionBooleanSelectionValue(capabilities, [], "fastMode"),
    ).toBeUndefined();
  });

  it("builds selections from descriptors using defaults", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
        {
          id: "fastMode",
          label: "Fast mode",
          type: "toggle",
          currentValue: false,
        },
      ],
    });

    const selections = buildProviderOptionSelectionsFromDescriptors(capabilities);
    expect(selections).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "fastMode", value: false },
    ]);
  });

  it("builds selections with overrides", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
        {
          id: "fastMode",
          label: "Fast mode",
          type: "toggle",
          currentValue: false,
        },
      ],
    });

    const selections = buildProviderOptionSelectionsFromDescriptors(capabilities, [
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(selections).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
    ]);
  });

  it("returns descriptors from capabilities", () => {
    const capabilities = ModelCapabilitiesSchema.parse({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
          ],
        },
      ],
    });

    const descriptors = getProviderOptionDescriptors(capabilities);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]!.id).toBe("reasoningEffort");
  });

  it("returns empty array for capabilities without descriptors", () => {
    const capabilities = ModelCapabilitiesSchema.parse({});
    expect(getProviderOptionDescriptors(capabilities)).toEqual([]);
  });

  it("formats reasoning effort and fast labels from descriptor defaults", () => {
    const capabilities = getCursorModelCapabilities("gpt-5.5[context=272k,reasoning=medium,fast=true]");

    expect(formatReasoningEffortDisplayLabel(capabilities, [])).toBe("Medium");
    expect(isFastModeEnabled(capabilities, [])).toBe(true);
    expect(formatModelOptionsDisplaySummary(capabilities, [])).toBe("Medium · Fast");
  });

  it("omits selector summary when cursor catalog label already encodes variant options", () => {
    const capabilities = getCursorModelCapabilities(
      "claude-sonnet-4-6[thinking=true,context=200k,effort=medium,fast=true]",
    );
    const catalogLabel = "Claude Sonnet 4.6 [effort=medium][fast]";

    expect(
      formatModelOptionsSummaryForSelector("cursor", catalogLabel, capabilities, []),
    ).toBe("");
    expect(
      formatModelOptionsSummaryForSelector("claude", catalogLabel, capabilities, []),
    ).toBe("Medium · Fast");
  });

  it("formats effort labels from effort metadata aliases", () => {
    const capabilities = getCursorModelCapabilities("claude-fable-5[thinking=true,context=300k,effort=high]");

    expect(formatReasoningEffortDisplayLabel(capabilities, [])).toBe("High");
    expect(formatModelOptionsDisplaySummary(capabilities, [])).toBe("High");
  });

  it("prefers per-model overrides over thread modelOptions", () => {
    const modelKey = buildThreadModelOptionsKey({
      agent: "cursor",
      model: "composer-2.5[fast=true]",
      modelProviderId: null,
    });

    const resolved = resolveThreadModelOptions({
      agent: "cursor",
      model: "composer-2.5[fast=true]",
      modelProviderId: null,
      modelOptions: [{ id: "fastMode", value: true }],
      modelOptionsPerModel: {
        [modelKey]: [{ id: "fastMode", value: false }],
      },
    });

    expect(resolved).toEqual([{ id: "fastMode", value: false }]);
  });

  it("builds descriptor defaults when thread modelOptions are empty", () => {
    const resolved = resolveThreadModelOptions({
      agent: "cursor",
      model: "composer-2.5[fast=true]",
      modelProviderId: null,
      modelOptions: [],
      modelOptionsPerModel: {},
    });

    expect(resolved).toEqual([{ id: "fastMode", value: true }]);
  });

  it("resolves bare cursor model effort from per-model overrides when catalog hints exist", () => {
    const modelKey = buildThreadModelOptionsKey({
      agent: "cursor",
      model: "gpt-5.5",
      modelProviderId: null,
    });
    const hints = {
      defaultVariantParams: { thinking: "medium" },
      parameters: [
        { id: "thinking", values: ["low", "medium", "high"] },
      ],
    };

    const resolved = resolveThreadModelOptions({
      agent: "cursor",
      model: "gpt-5.5",
      modelProviderId: null,
      modelOptions: [],
      modelOptionsPerModel: {
        [modelKey]: [{ id: "reasoningEffort", value: "low" }],
      },
      cursorCatalogHints: hints,
    });

    expect(resolved).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("returns undefined for bare cursor ids without catalog hints even when overrides exist", () => {
    const modelKey = buildThreadModelOptionsKey({
      agent: "cursor",
      model: "gpt-5.5",
      modelProviderId: null,
    });

    const resolved = resolveThreadModelOptions({
      agent: "cursor",
      model: "gpt-5.5",
      modelProviderId: null,
      modelOptions: [],
      modelOptionsPerModel: {
        [modelKey]: [{ id: "reasoningEffort", value: "low" }],
      },
    });

    expect(resolved).toBeUndefined();
  });

  it("formats selector summary for bare cursor ids using catalog default variant params", () => {
    const hints = {
      defaultVariantParams: { thinking: "medium" },
      parameters: [
        { id: "thinking", values: ["low", "medium", "high"] },
        { id: "fast", values: ["true", "false"] },
      ],
    };
    const capabilities = resolveModelCapabilities("cursor", "claude-opus-4-8", hints);

    expect(
      formatModelOptionsSummaryForSelector("cursor", "Opus 4.8", capabilities, []),
    ).toBe("Medium");
  });
});
