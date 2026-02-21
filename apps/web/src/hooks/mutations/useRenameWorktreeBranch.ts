import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Repository, RenameWorktreeBranchInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useRenameWorktreeBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ worktreeId, input }: { worktreeId: string; input: RenameWorktreeBranchInput }) =>
      api.renameWorktreeBranch(worktreeId, input),
    onMutate: async ({ worktreeId, input }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.repositories.all });
      const previous = queryClient.getQueryData<Repository[]>(queryKeys.repositories.all);
      queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
        old?.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((wt) =>
            wt.id === worktreeId ? { ...wt, branch: input.branch } : wt,
          ),
        })),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.repositories.all, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    },
  });
}
