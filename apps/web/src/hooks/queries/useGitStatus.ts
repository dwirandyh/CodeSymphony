import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

const GIT_STATUS_REFETCH_MS = 30_000;

function gitStatusQueryOptions(worktreeId: string) {
  return queryOptions({
    queryKey: queryKeys.worktrees.gitStatus(worktreeId),
    queryFn: () => api.getGitStatus(worktreeId),
    enabled: worktreeId.length > 0,
    refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : GIT_STATUS_REFETCH_MS,
    staleTime: GIT_STATUS_REFETCH_MS - 1_000,
    retry: false,
  });
}

export function useGitStatus(worktreeId: string | null) {
  return useQuery({
    ...gitStatusQueryOptions(worktreeId ?? ""),
    enabled: !!worktreeId,
  });
}
