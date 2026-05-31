import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { isOptimisticThreadId } from "../../lib/threadIds";

export const THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS = 10_000;

export function useThreadSnapshot(
  threadId: string | null,
  options?: {
    enabled?: boolean;
    mode?: "full" | "compact";
  },
) {
  const enabled = options?.enabled ?? true;
  const mode = options?.mode ?? "full";
  return useQuery({
    queryKey: queryKeys.threads.timelineSnapshot(threadId!, mode),
    queryFn: () => api.getTimelineSnapshot(threadId!, { mode }),
    enabled: !!threadId && !isOptimisticThreadId(threadId) && enabled,
    staleTime: THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS,
  });
}
