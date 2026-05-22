import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useCursorModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.models.cursorCatalog,
    queryFn: () => api.listCursorModels(),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
