import { useQuery } from "@tanstack/react-query";
import {
  BUILTIN_CHAT_MODELS_BY_AGENT,
  type OpencodeModelCatalogEntry,
} from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

function createFallbackOpencodeEntry(modelId: string): OpencodeModelCatalogEntry {
  const [providerId] = modelId.split("/", 1);

  return {
    id: modelId,
    name: modelId,
    providerId: providerId?.trim() || "opencode",
  };
}

export function useOpencodeModels() {
  return useQuery({
    queryKey: queryKeys.models.opencodeCatalog,
    queryFn: async () => {
      try {
        return await api.listOpencodeModels();
      } catch {
        return {
          models: BUILTIN_CHAT_MODELS_BY_AGENT.opencode.map(createFallbackOpencodeEntry),
          fetchedAt: new Date(0).toISOString(),
        };
      }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
