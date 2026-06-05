import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateWorktreeInput, CreateWorktreeResult } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { refetchRepositoriesCollection } from "../../collections/repositories";

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repositoryId, input }: { repositoryId: string; input?: CreateWorktreeInput }): Promise<CreateWorktreeResult> =>
      api.createWorktree(repositoryId, input),
    onSuccess: () => {
      void refetchRepositoriesCollection(queryClient);
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
