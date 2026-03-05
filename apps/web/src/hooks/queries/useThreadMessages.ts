import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { INITIAL_MESSAGES_PAGE_LIMIT } from "../../pages/workspace/constants";

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.messages(threadId!),
    queryFn: () => api.listMessagesPage(threadId!, { limit: INITIAL_MESSAGES_PAGE_LIMIT }),
    enabled: !!threadId,
  });
}
