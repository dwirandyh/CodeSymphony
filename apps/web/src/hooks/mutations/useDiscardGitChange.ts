import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useDiscardGitChange(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (filePath: string) => api.discardGitChange(worktreeId!, filePath),
    onSuccess: () => {
      if (worktreeId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(worktreeId) });
      }
    },
  });
}
