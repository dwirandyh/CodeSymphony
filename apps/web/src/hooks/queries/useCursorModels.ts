import { useQuery } from "@tanstack/react-query";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  type CursorModelCatalogEntry,
} from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

function createFallbackCursorEntry(modelId: string): CursorModelCatalogEntry {
  return {
    id: modelId,
    name: modelId === "default[]" ? "Auto" : modelId.replace(/\[[^\]]*]$/, ""),
  };
}

export function useCursorModels() {
  return useQuery({
    queryKey: queryKeys.models.cursorCatalog,
    queryFn: async () => {
      try {
        return await api.listCursorModels();
      } catch {
        return {
          models: BUILTIN_CHAT_MODELS_BY_AGENT.cursor.map(createFallbackCursorEntry),
          fetchedAt: new Date(0).toISOString(),
        };
      }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
