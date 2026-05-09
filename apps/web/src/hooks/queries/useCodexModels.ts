import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { FALLBACK_CODEX_MODELS } from "../../lib/agentModelDefaults";
import { queryKeys } from "../../lib/queryKeys";

export function useCodexModels() {
  return useQuery({
    queryKey: queryKeys.models.codexCatalog,
    queryFn: async () => {
      try {
        return await api.listCodexModels();
      } catch {
        return {
          models: [...FALLBACK_CODEX_MODELS],
          fetchedAt: new Date(0).toISOString(),
        };
      }
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
