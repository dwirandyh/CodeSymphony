import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (worktreeId: string) => api.deleteWorktree(worktreeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
