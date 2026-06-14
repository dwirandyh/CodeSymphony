import type { CliAgent } from "./workflow.js";
import type { ModelCapabilities } from "./workflow.js";

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

/** Map composer catalog ids that only expose fast=true to the bare non-fast ACP id. */
export function normalizeCursorCatalogModelId(modelId: string): string {
  if (!isCursorComposerModel(modelId)) {
    return modelId;
  }

  if (parseCursorModelMetadata(modelId).get("fast") === "true") {
    return getCursorBaseModelName(modelId);
  }

  return modelId;
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

export function getCursorModelCapabilities(model?: string): ModelCapabilities {
  const metadata = parseCursorModelMetadata(model);
  const descriptors: ModelCapabilities["optionDescriptors"] = [];
  const reasoningValue = normalizeReasoningValue(metadata.get("reasoning") ?? metadata.get("effort"));

  if (reasoningValue) {
    descriptors.push({
      id: "reasoningEffort",
      label: "Effort",
      type: "select",
      currentValue: reasoningValue,
      options: CURSOR_REASONING_OPTIONS,
    });
  }

  const isComposer = getCursorBaseModelName(model ?? "").startsWith("composer-");
  if (metadata.has("fast") || isComposer) {
    descriptors.push({
      id: "fastMode",
      label: "Fast mode",
      type: "toggle",
      currentValue: metadata.get("fast") === "true",
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

export function resolveModelCapabilities(
  agent: CliAgent,
  model?: string,
): ModelCapabilities {
  switch (agent) {
    case "codex":
      return getCodexModelCapabilities();
    case "cursor":
      return getCursorModelCapabilities(model);
    case "opencode":
      return getOpencodeModelCapabilities();
    default:
      return getClaudeModelCapabilities();
  }
}
