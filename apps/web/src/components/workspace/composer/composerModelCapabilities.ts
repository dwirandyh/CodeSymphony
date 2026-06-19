import {
  type CliAgent,
  type CursorModelCatalogEntry,
  type ModelCapabilities,
  cursorCatalogCapabilityHintsFromEntry,
  normalizeCursorCatalogModelId,
  resolveModelCapabilities,
} from "@codesymphony/shared-types";

export type ModelOptionsTarget = {
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
};

export function findCursorCatalogEntry(
  cursorModels: readonly CursorModelCatalogEntry[] | undefined,
  modelId: string,
): CursorModelCatalogEntry | undefined {
  if (!cursorModels?.length) {
    return undefined;
  }

  const normalizedId = normalizeCursorCatalogModelId(modelId);
  return cursorModels.find((entry) => (
    normalizeCursorCatalogModelId(entry.id) === normalizedId
  ));
}

export function resolveBuiltinModelCapabilities(
  target: ModelOptionsTarget,
  cursorModels?: readonly CursorModelCatalogEntry[],
): ModelCapabilities {
  if (target.modelProviderId !== null) {
    return { optionDescriptors: [] };
  }

  const catalogHints = target.agent === "cursor"
    ? cursorCatalogCapabilityHintsFromEntry(findCursorCatalogEntry(cursorModels, target.model))
    : undefined;

  return resolveModelCapabilities(target.agent, target.model, catalogHints);
}