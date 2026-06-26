import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GitBranchDiffSummary } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { invalidateWorktreeGitQueries } from "./invalidateWorktreeGitQueries";

export function useGitRebaseBase(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.gitRebaseBase(worktreeId!),
    onSuccess: (result) => {
      if (!worktreeId) {
        return;
      }

      queryClient.setQueriesData<GitBranchDiffSummary>(
        { queryKey: ["worktrees", worktreeId, "gitBranchDiffSummary"], exact: false },
        (cached) => {
          if (!cached) {
            return cached;
          }

          return {
            ...cached,
            baseBranch: result.baseBranch,
            ahead: result.ahead,
            behind: result.behind,
          };
        },
      );

      void queryClient.refetchQueries({
        queryKey: queryKeys.worktrees.gitBranchDiffSummary(worktreeId, "__all__"),
        exact: false,
      });

      invalidateWorktreeGitQueries(queryClient, worktreeId);
    },
  });
}