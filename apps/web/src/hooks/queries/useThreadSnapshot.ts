import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useThreadSnapshot(threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.timelineSnapshot(threadId!),
    queryFn: () => api.getTimelineSnapshot(threadId!),
    enabled: !!threadId,
  });
}
