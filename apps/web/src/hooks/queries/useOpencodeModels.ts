import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useOpencodeModels(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.models.opencodeCatalog,
    queryFn: () => api.listOpencodeModels(),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
}
