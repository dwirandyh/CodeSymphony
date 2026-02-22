import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.messages(threadId!),
    queryFn: () => api.listMessages(threadId!),
    enabled: !!threadId,
  });
}
