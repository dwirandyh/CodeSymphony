import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { GitCommitInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { invalidateWorktreeGitQueries } from "./invalidateWorktreeGitQueries";

export function useGitCommit(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ message }: GitCommitInput) =>
      api.gitCommit(worktreeId!, { message }),
    onSuccess: () => {
      if (worktreeId) {
        invalidateWorktreeGitQueries(queryClient, worktreeId);
      }
    },
  });
}
