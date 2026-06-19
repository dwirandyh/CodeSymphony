import { describe, expect, it } from "vitest";
import {
  buildProviderOptionSelectionsFromDescriptors,
  type CursorModelCatalogEntry,
} from "@codesymphony/shared-types";
import { resolveBuiltinModelCapabilities } from "./composerModelCapabilities.js";

describe("resolveBuiltinModelCapabilities", () => {
  const opusCatalog: CursorModelCatalogEntry[] = [
    {
      id: "claude-opus-4-8",
      name: "Opus 4.8",
      defaultVariantParams: { thinking: "medium" },
      parameters: [
        { id: "thinking", values: ["low", "medium", "high"] },
        { id: "fast", values: ["true", "false"] },
      ],
    },
  ];

  it("includes reasoning effort descriptors for bare cursor ids when catalog hints exist", () => {
    const capabilities = resolveBuiltinModelCapabilities(
      { agent: "cursor", model: "claude-opus-4-8", modelProviderId: null },
      opusCatalog,
    );

    expect(capabilities.optionDescriptors.some((d) => d.id === "reasoningEffort")).toBe(true);
  });

  it("keeps effort selection when normalizing overlay changes", () => {
    const capabilities = resolveBuiltinModelCapabilities(
      { agent: "cursor", model: "claude-opus-4-8", modelProviderId: null },
      opusCatalog,
    );

    const normalized = buildProviderOptionSelectionsFromDescriptors(capabilities, [
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(normalized.find((s) => s.id === "reasoningEffort")?.value).toBe("high");
  });

  it("drops effort without catalog hints (regression guard)", () => {
    const capabilities = resolveBuiltinModelCapabilities(
      { agent: "cursor", model: "claude-opus-4-8", modelProviderId: null },
    );

    const normalized = buildProviderOptionSelectionsFromDescriptors(capabilities, [
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(normalized.find((s) => s.id === "reasoningEffort")).toBeUndefined();
  });
});