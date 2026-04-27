import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export const THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS = 10_000;

export type ThreadSnapshotMode = "display" | "full";

export function useThreadSnapshot(
  threadId: string | null,
  options?: {
    mode?: ThreadSnapshotMode;
    enabled?: boolean;
  },
) {
  const mode = options?.mode ?? "display";
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: queryKeys.threads.timelineSnapshot(threadId!, mode),
    queryFn: () => api.getTimelineSnapshot(threadId!, {
      includeCollections: mode === "full",
      paginated: mode === "full",
    }),
    enabled: !!threadId && enabled,
    staleTime: THREAD_TIMELINE_SNAPSHOT_STALE_TIME_MS,
  });
}
