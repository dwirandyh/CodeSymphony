import {
  cursorCatalogCapabilityHintsFromEntry,
  normalizeCursorCatalogModelId,
  type CursorModelCapabilityHints,
} from "@codesymphony/shared-types";
import { appendRuntimeDebugLog } from "../routes/debug.js";
import { listCursorModels } from "./sessionRunner.js";

export async function resolveCursorCatalogHintsForModel(
  model: string,
): Promise<CursorModelCapabilityHints | undefined> {
  const normalizedModel = normalizeCursorCatalogModelId(model);
  const catalog = await listCursorModels({ cwd: process.cwd() });
  const entry = catalog.find((candidate) => (
    normalizeCursorCatalogModelId(candidate.id) === normalizedModel
  ));
  const hints = cursorCatalogCapabilityHintsFromEntry(entry);
  appendRuntimeDebugLog({
    source: "model.selection",
    message: "cursor.catalogHints",
    data: {
      requestedModel: model,
      normalizedModel,
      catalogEntryFound: entry != null,
      entryId: entry?.id ?? null,
      defaultVariantParams: entry?.defaultVariantParams ?? null,
      parameterIds: entry?.parameters?.map((p) => p.id) ?? null,
      hintsPresent: hints != null,
    },
  });
  return hints;
}