import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useDeleteThread(worktreeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => api.deleteThread(threadId),
    onSuccess: () => {
      if (worktreeId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(worktreeId) });
      }
    },
  });
}
