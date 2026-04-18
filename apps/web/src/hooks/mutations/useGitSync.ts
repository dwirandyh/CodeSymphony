import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { invalidateWorktreeGitQueries } from "./invalidateWorktreeGitQueries";

export function useGitSync(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.gitSync(worktreeId!),
    onSuccess: () => {
      if (worktreeId) {
        invalidateWorktreeGitQueries(queryClient, worktreeId);
      }
    },
  });
}
