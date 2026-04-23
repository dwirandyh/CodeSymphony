import { queryOptions, useQuery } from "@tanstack/react-query";
import { api, type RuntimeInfo } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

const RUNTIME_INFO_REFETCH_MS = 60_000;

export function runtimeInfoQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.runtime.info,
    queryFn: async (): Promise<RuntimeInfo | null> => {
      try {
        return await api.getRuntimeInfo();
      } catch {
        return null;
      }
    },
    refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : RUNTIME_INFO_REFETCH_MS,
    staleTime: RUNTIME_INFO_REFETCH_MS - 1_000,
    retry: false,
  });
}

export function useRuntimeInfo() {
  return useQuery(runtimeInfoQueryOptions());
}
