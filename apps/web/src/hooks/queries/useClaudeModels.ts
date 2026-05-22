import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useClaudeModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.models.claudeCatalog,
    queryFn: () => api.listClaudeModels(),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
