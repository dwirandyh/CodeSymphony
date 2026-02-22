import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateWorktreeInput, ScriptResult, Worktree } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useCreateWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repositoryId, input }: { repositoryId: string; input?: CreateWorktreeInput }): Promise<{ worktree: Worktree; scriptResult?: ScriptResult }> =>
      api.createWorktree(repositoryId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
