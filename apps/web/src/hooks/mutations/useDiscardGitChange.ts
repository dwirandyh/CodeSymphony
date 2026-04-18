import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { invalidateWorktreeGitQueries } from "./invalidateWorktreeGitQueries";

export function useDiscardGitChange(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (filePath: string) => api.discardGitChange(worktreeId!, filePath),
    onSuccess: () => {
      if (worktreeId) {
        invalidateWorktreeGitQueries(queryClient, worktreeId);
      }
    },
  });
}
