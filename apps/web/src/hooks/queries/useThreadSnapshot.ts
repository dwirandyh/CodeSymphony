import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { INITIAL_EVENTS_PAGE_LIMIT, INITIAL_MESSAGES_PAGE_LIMIT } from "../../pages/workspace/constants";

export function useThreadSnapshot(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.snapshot(threadId!),
    queryFn: () => api.getThreadSnapshot(threadId!, {
      messageLimit: INITIAL_MESSAGES_PAGE_LIMIT,
      eventLimit: INITIAL_EVENTS_PAGE_LIMIT,
    }),
    enabled: !!threadId,
  });
}
