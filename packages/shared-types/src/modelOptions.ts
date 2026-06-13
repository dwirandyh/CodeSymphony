import type { CliAgent, ModelCapabilities, ProviderOptionDescriptor, ProviderOptionSelection } from "./workflow.js";
import { resolveModelCapabilities } from "./modelCapabilities.js";

export function getProviderOptionDescriptors(capabilities: ModelCapabilities): ProviderOptionDescriptor[] {
  return capabilities.optionDescriptors ?? [];
}

function findDescriptorById(
  capabilities: ModelCapabilities,
  id: string,
): ProviderOptionDescriptor | undefined {
  return capabilities.optionDescriptors.find((d) => d.id === id);
}

function findSelectionById(
  selections: readonly ProviderOptionSelection[],
  id: string,
): ProviderOptionSelection | undefined {
  return selections.find((s) => s.id === id);
}

export function getProviderOptionStringSelectionValue(
  capabilities: ModelCapabilities,
  selections: readonly ProviderOptionSelection[],
  id: string,
): string | undefined {
  const descriptor = findDescriptorById(capabilities, id);
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type !== "select") {
    return undefined;
  }

  const selection = findSelectionById(selections, id);
  if (selection && typeof selection.value === "string") {
    return selection.value;
  }

  return descriptor.currentValue;
}

export function getProviderOptionBooleanSelectionValue(
  capabilities: ModelCapabilities,
  selections: readonly ProviderOptionSelection[],
  id: string,
): boolean | undefined {
  const descriptor = findDescriptorById(capabilities, id);
  if (!descriptor) {
    return undefined;
  }
  if (descriptor.type !== "toggle") {
    return undefined;
  }

  const selection = findSelectionById(selections, id);
  if (selection && typeof selection.value === "boolean") {
    return selection.value;
  }

  return descriptor.currentValue;
}

export function buildProviderOptionSelectionsFromDescriptors(
  capabilities: ModelCapabilities,
  overrides?: readonly ProviderOptionSelection[],
): ProviderOptionSelection[] {
  return capabilities.optionDescriptors.map((descriptor) => {
    const override = overrides?.find((o) => o.id === descriptor.id);
    if (override) {
      return { id: descriptor.id, value: override.value };
    }
    return { id: descriptor.id, value: descriptor.currentValue };
  });
}

export function hasConfigurableModelOptions(capabilities: ModelCapabilities): boolean {
  return (capabilities.optionDescriptors?.length ?? 0) > 0;
}

export function formatReasoningEffortDisplayLabel(
  capabilities: ModelCapabilities,
  selections: readonly ProviderOptionSelection[],
): string | undefined {
  const value = getProviderOptionStringSelectionValue(capabilities, selections, "reasoningEffort");
  if (!value) {
    return undefined;
  }

  const descriptor = findDescriptorById(capabilities, "reasoningEffort");
  if (descriptor?.type === "select") {
    const option = descriptor.options.find((entry) => entry.value === value);
    if (option) {
      return option.label;
    }
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function isFastModeEnabled(
  capabilities: ModelCapabilities,
  selections: readonly ProviderOptionSelection[],
): boolean {
  return getProviderOptionBooleanSelectionValue(capabilities, selections, "fastMode") === true;
}

export function buildThreadModelOptionsKey(input: {
  agent: string;
  model: string;
  modelProviderId?: string | null;
}): string {
  return `${input.agent}::${input.model}::${input.modelProviderId ?? ""}`;
}

export function resolveThreadModelOptions(input: {
  agent: CliAgent;
  model: string;
  modelProviderId?: string | null;
  modelOptions?: readonly ProviderOptionSelection[];
  modelOptionsPerModel?: Record<string, readonly ProviderOptionSelection[]>;
}): ProviderOptionSelection[] | undefined {
  const modelKey = buildThreadModelOptionsKey(input);
  const overrides = input.modelOptionsPerModel?.[modelKey] ?? input.modelOptions;
  const capabilities = resolveModelCapabilities(input.agent, input.model);

  if (!hasConfigurableModelOptions(capabilities)) {
    return undefined;
  }

  return buildProviderOptionSelectionsFromDescriptors(capabilities, overrides);
}

export function formatModelOptionsDisplaySummary(
  capabilities: ModelCapabilities,
  selections: readonly ProviderOptionSelection[],
): string {
  const parts: string[] = [];
  const effortLabel = formatReasoningEffortDisplayLabel(capabilities, selections);
  if (effortLabel) {
    parts.push(effortLabel);
  }
  if (isFastModeEnabled(capabilities, selections)) {
    parts.push("Fast");
  }
  return parts.join(" · ");
}
