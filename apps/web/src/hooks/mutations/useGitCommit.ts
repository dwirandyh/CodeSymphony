import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GitCommitInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { invalidateWorktreeGitQueries } from "./invalidateWorktreeGitQueries";

export function useGitCommit(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GitCommitInput) =>
      api.gitCommit(worktreeId!, input),
    onSuccess: () => {
      if (worktreeId) {
        invalidateWorktreeGitQueries(queryClient, worktreeId);
      }
    },
  });
}
