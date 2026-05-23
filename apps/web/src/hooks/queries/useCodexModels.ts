import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useCodexModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.models.codexCatalog,
    queryFn: () => api.listCodexModels(),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
