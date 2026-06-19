import type { CliAgent } from "./workflow.js";
import type { CursorModelCatalogEntry, ModelCapabilities } from "./workflow.js";

export type CursorModelCapabilityHints = Pick<
  CursorModelCatalogEntry,
  "defaultVariantParams" | "parameters"
>;

const CURSOR_REASONING_OPTIONS = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

const CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Effort",
      type: "select",
      currentValue: "high",
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
};

const CODEX_MODEL_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Effort",
      type: "select",
      currentValue: "xhigh",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "Extra High" },
      ],
    },
  ],
};

const OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [],
};

export function parseCursorModelMetadata(model: string | undefined): Map<string, string> {
  if (!model) {
    return new Map();
  }

  const metadataMatch = model.match(/\[([^\]]*)]$/);
  if (!metadataMatch) {
    return new Map();
  }

  return new Map(
    metadataMatch[1]!
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .flatMap((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) {
          return [];
        }

        return [[part.slice(0, separatorIndex), part.slice(separatorIndex + 1)] as const];
      }),
  );
}

export function getCursorBaseModelName(model: string): string {
  const metadataMatch = model.match(/\[([^\]]*)]$/);
  if (!metadataMatch) {
    return model.trim();
  }

  const hasVariantParams = metadataMatch[1]!
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => part.includes("="));
  if (!hasVariantParams) {
    return model.trim();
  }

  return model.replace(/\[[^\]]*]$/, "").trim();
}

export function isCursorComposerModel(model: string): boolean {
  return getCursorBaseModelName(model).startsWith("composer-");
}

function isComposerFastExplicitlyEnabled(
  modelOptions?: readonly { id: string; value: unknown }[],
): boolean {
  return modelOptions?.find((option) => option.id === "fastMode")?.value === true;
}

/** Bare catalog id for picker + thread storage; variant params live in Edit overlay. */
export function normalizeCursorCatalogModelId(modelId: string): string {
  return getCursorBaseModelName(modelId);
}

export function normalizeCursorCatalogListEntry(entry: {
  id: string;
  name: string;
  defaultVariantParams?: Record<string, string>;
  parameters?: CursorModelCatalogEntry["parameters"];
}): {
  id: string;
  name: string;
  defaultVariantParams?: Record<string, string>;
  parameters?: CursorModelCatalogEntry["parameters"];
} {
  const id = normalizeCursorCatalogModelId(entry.id);
  return {
    id,
    name: entry.name.trim() || getCursorBaseModelName(entry.id),
    ...(entry.defaultVariantParams ? { defaultVariantParams: entry.defaultVariantParams } : {}),
    ...(entry.parameters?.length ? { parameters: entry.parameters } : {}),
  };
}

export function dedupeCursorCatalogEntries(
  entries: readonly CursorModelCatalogEntry[],
): CursorModelCatalogEntry[] {
  const byId = new Map<string, CursorModelCatalogEntry>();

  for (const entry of entries) {
    const normalized = normalizeCursorCatalogListEntry(entry);
    if (!byId.has(normalized.id)) {
      byId.set(normalized.id, normalized);
    }
  }

  return Array.from(byId.values());
}

export function cursorCatalogModelIdsEquivalent(left: string, right: string): boolean {
  return normalizeCursorCatalogModelId(left) === normalizeCursorCatalogModelId(right);
}

/** @deprecated Use cursorCatalogModelIdsEquivalent */
export function cursorComposerCatalogIdsEquivalent(left: string, right: string): boolean {
  return cursorCatalogModelIdsEquivalent(left, right);
}

/** Resolve the model id sent to Cursor ACP setSessionModel. */
export function resolveCursorSessionModelId(
  model: string,
  modelOptions?: readonly { id: string; value: unknown }[],
): string {
  const withOptions = modelOptions?.length
    ? applyCursorModelOptions(model, modelOptions)
    : model;

  if (!isCursorComposerModel(withOptions)) {
    return withOptions;
  }

  if (isComposerFastExplicitlyEnabled(modelOptions)) {
    const baseName = getCursorBaseModelName(withOptions);
    if (parseCursorModelMetadata(withOptions).get("fast") === "true") {
      return withOptions;
    }
    return `${baseName}[fast=true]`;
  }

  return getCursorBaseModelName(withOptions);
}

function normalizeReasoningValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value === "extra-high") {
    return "xhigh";
  }

  if (CURSOR_REASONING_OPTIONS.some((option) => option.value === value)) {
    return value;
  }

  return null;
}

const CURSOR_REASONING_PARAM_IDS = ["thinking", "reasoning", "effort"] as const;

function findCursorCatalogParameter(
  parameters: CursorModelCapabilityHints["parameters"],
  ids: readonly string[],
) {
  return parameters?.find((parameter) => ids.includes(parameter.id));
}

function reasoningOptionsFromCatalog(
  parameters: CursorModelCapabilityHints["parameters"],
): typeof CURSOR_REASONING_OPTIONS {
  const parameter = findCursorCatalogParameter(parameters, CURSOR_REASONING_PARAM_IDS);
  if (!parameter || parameter.values.length === 0) {
    return CURSOR_REASONING_OPTIONS;
  }

  const allowed = new Set(parameter.values);
  const filtered = CURSOR_REASONING_OPTIONS.filter((option) => (
    option.value === "none" || allowed.has(option.value)
  ));
  return filtered.length > 0 ? filtered : CURSOR_REASONING_OPTIONS;
}

function defaultReasoningFromHints(
  metadata: Map<string, string>,
  defaultVariantParams?: Record<string, string>,
): string | null {
  const fromMetadata = normalizeReasoningValue(metadata.get("reasoning") ?? metadata.get("effort"));
  if (fromMetadata) {
    return fromMetadata;
  }

  if (!defaultVariantParams) {
    return null;
  }

  for (const paramId of CURSOR_REASONING_PARAM_IDS) {
    const normalized = normalizeReasoningValue(defaultVariantParams[paramId]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function catalogSupportsFastToggle(
  parameters: CursorModelCapabilityHints["parameters"],
): boolean {
  return parameters?.some((parameter) => parameter.id === "fast" && parameter.values.length > 0) ?? false;
}

function defaultFastFromHints(
  metadata: Map<string, string>,
  isComposer: boolean,
  defaultVariantParams?: Record<string, string>,
): boolean | null {
  const fastFromMetadata = metadata.get("fast");
  if (fastFromMetadata === "false") {
    return false;
  }
  if (fastFromMetadata === "true") {
    return true;
  }

  const fastFromDefault = defaultVariantParams?.fast;
  if (fastFromDefault === "false") {
    return false;
  }
  if (fastFromDefault === "true") {
    return true;
  }

  if (isComposer) {
    return true;
  }

  return null;
}

export function getCursorModelCapabilities(
  model?: string,
  catalogHints?: CursorModelCapabilityHints,
): ModelCapabilities {
  const metadata = parseCursorModelMetadata(model);
  const descriptors: ModelCapabilities["optionDescriptors"] = [];
  const baseModel = getCursorBaseModelName(model ?? "");
  const isComposer = baseModel.startsWith("composer-");
  const reasoningParameter = findCursorCatalogParameter(
    catalogHints?.parameters,
    CURSOR_REASONING_PARAM_IDS,
  );
  const reasoningValue = defaultReasoningFromHints(metadata, catalogHints?.defaultVariantParams);
  const reasoningFromMetadataOnly = normalizeReasoningValue(
    metadata.get("reasoning") ?? metadata.get("effort"),
  );

  if (reasoningFromMetadataOnly || reasoningParameter) {
    const options = reasoningOptionsFromCatalog(catalogHints?.parameters);
    const currentValue = reasoningValue ?? options.find((option) => option.value !== "none")?.value ?? "medium";
    descriptors.push({
      id: "reasoningEffort",
      label: "Effort",
      type: "select",
      currentValue,
      options,
    });
  }

  const showFast = metadata.has("fast") || isComposer || catalogSupportsFastToggle(catalogHints?.parameters);
  if (showFast) {
    const fastDefault = defaultFastFromHints(
      metadata,
      isComposer,
      catalogHints?.defaultVariantParams,
    );
    descriptors.push({
      id: "fastMode",
      label: "Fast mode",
      type: "toggle",
      currentValue: fastDefault ?? false,
    });
  }

  return { optionDescriptors: descriptors };
}

function buildCursorModelMetadataString(metadata: Map<string, string>): string {
  const entries = Array.from(metadata.entries());
  if (entries.length === 0) {
    return "";
  }

  return `[${entries.map(([k, v]) => `${k}=${v}`).join(",")}]`;
}

export function applyCursorModelOptions(
  model: string,
  options: readonly { id: string; value: unknown }[],
): string {
  const baseName = model.replace(/\[[^\]]*]$/, "").trim();
  const metadata = parseCursorModelMetadata(model);

  for (const option of options) {
    switch (option.id) {
      case "fastMode":
        if (typeof option.value === "boolean") {
          if (option.value) {
            metadata.set("fast", "true");
          } else if (metadata.size === 1 && metadata.has("fast")) {
            const baseNameOnlyFast = getCursorBaseModelName(model).startsWith("composer-");
            if (baseNameOnlyFast) {
              // Composer non-fast ids are not accepted by Cursor ACP setSessionModel.
              return model;
            }
            return baseName;
          } else {
            metadata.set("fast", "false");
          }
        }
        break;
      case "reasoningEffort":
        if (typeof option.value === "string") {
          const effort = option.value;
          if (effort === "none") {
            metadata.delete("reasoning");
            metadata.delete("effort");
          } else {
            metadata.set("reasoning", effort);
            metadata.delete("effort");
          }
        }
        break;
    }
  }

  return `${baseName}${buildCursorModelMetadataString(metadata)}`;
}

export function getClaudeModelCapabilities(): ModelCapabilities {
  return CLAUDE_MODEL_CAPABILITIES;
}

export function getCodexModelCapabilities(): ModelCapabilities {
  return CODEX_MODEL_CAPABILITIES;
}

export function getOpencodeModelCapabilities(): ModelCapabilities {
  return OPENCODE_MODEL_CAPABILITIES;
}

export function cursorCatalogCapabilityHintsFromEntry(
  entry: Pick<CursorModelCatalogEntry, "defaultVariantParams" | "parameters"> | undefined,
): CursorModelCapabilityHints | undefined {
  if (!entry?.parameters?.length && !entry?.defaultVariantParams) {
    return undefined;
  }

  return {
    defaultVariantParams: entry.defaultVariantParams,
    parameters: entry.parameters,
  };
}

export function resolveModelCapabilities(
  agent: CliAgent,
  model?: string,
  catalogHints?: CursorModelCapabilityHints,
): ModelCapabilities {
  switch (agent) {
    case "codex":
      return getCodexModelCapabilities();
    case "cursor":
      return getCursorModelCapabilities(model, catalogHints);
    case "opencode":
      return getOpencodeModelCapabilities();
    default:
      return getClaudeModelCapabilities();
  }
}
