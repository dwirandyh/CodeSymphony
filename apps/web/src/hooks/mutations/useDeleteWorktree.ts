import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import {
  refreshRepositoriesCollectionFromServer,
  removeWorktreeFromCollection,
} from "../../collections/repositories";

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ worktreeId, options }: { worktreeId: string; options?: { force?: boolean } }) =>
      api.deleteWorktree(worktreeId, options),
    onSuccess: (_data, { worktreeId }) => {
      removeWorktreeFromCollection(queryClient, worktreeId);
      void refreshRepositoriesCollectionFromServer(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
