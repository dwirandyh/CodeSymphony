import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SendChatMessageInput } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: SendChatMessageInput }) =>
      api.sendMessage(threadId, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(variables.threadId) });
    },
  });
}
