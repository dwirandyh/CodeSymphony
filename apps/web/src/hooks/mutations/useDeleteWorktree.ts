import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { refetchRepositoriesCollection } from "../../collections/repositories";

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ worktreeId, options }: { worktreeId: string; options?: { force?: boolean } }) =>
      api.deleteWorktree(worktreeId, options),
    onSuccess: () => {
      void refetchRepositoriesCollection(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
