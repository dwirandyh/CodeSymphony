import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export const THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS = 10_000;

export function useThreadSnapshot(
  threadId: string | null,
  options?: {
    enabled?: boolean;
  },
) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: queryKeys.threads.timelineSnapshot(threadId!),
    queryFn: () => api.getTimelineSnapshot(threadId!),
    enabled: !!threadId && enabled,
    staleTime: THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS,
  });
}
