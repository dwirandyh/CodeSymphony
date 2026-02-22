import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useThreadEvents(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.events(threadId!),
    queryFn: () => api.listEvents(threadId!),
    enabled: !!threadId,
  });
}
