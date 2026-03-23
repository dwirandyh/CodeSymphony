import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export const GIT_BRANCH_DIFF_SUMMARY_REFETCH_MS = 30_000;

export function gitBranchDiffSummaryQueryOptions(worktreeId: string, baseBranch: string) {
  return queryOptions({
    queryKey: queryKeys.worktrees.gitBranchDiffSummary(worktreeId, baseBranch),
    queryFn: () => api.getGitBranchDiffSummary(worktreeId),
    enabled: worktreeId.length > 0 && baseBranch.length > 0,
    refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : GIT_BRANCH_DIFF_SUMMARY_REFETCH_MS,
    staleTime: GIT_BRANCH_DIFF_SUMMARY_REFETCH_MS - 1_000,
    retry: false,
  });
}

export function useGitBranchDiffSummary(worktreeId: string | null, baseBranch: string | null) {
  return useQuery({
    ...gitBranchDiffSummaryQueryOptions(worktreeId ?? "", baseBranch ?? ""),
    enabled: !!worktreeId && !!baseBranch,
  });
}
