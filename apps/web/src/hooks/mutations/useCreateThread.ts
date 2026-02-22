import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateChatThreadInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useCreateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ worktreeId, input }: { worktreeId: string; input?: CreateChatThreadInput }) =>
      api.createThread(worktreeId, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(variables.worktreeId) });
    },
  });
}
