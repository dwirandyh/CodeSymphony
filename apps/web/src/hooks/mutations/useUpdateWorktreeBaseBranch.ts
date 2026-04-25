import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Repository, UpdateWorktreeBaseBranchInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useUpdateWorktreeBaseBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ worktreeId, input }: { worktreeId: string; input: UpdateWorktreeBaseBranchInput }) =>
      api.updateWorktreeBaseBranch(worktreeId, input),
    onMutate: async ({ worktreeId, input }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.repositories.all });
      const previous = queryClient.getQueryData<Repository[]>(queryKeys.repositories.all);
      queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
        old?.map((repo) => ({
          ...repo,
          worktrees: repo.worktrees.map((wt) =>
            wt.id === worktreeId ? { ...wt, baseBranch: input.baseBranch } : wt,
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
