import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export const THREAD_STATUS_SNAPSHOT_STALE_TIME_MS = 10_000;

export function useThreadStatusSnapshot(
  threadId: string | null,
  options?: {
    enabled?: boolean;
  },
) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: queryKeys.threads.statusSnapshot(threadId!),
    queryFn: () => api.getThreadStatusSnapshot(threadId!),
    enabled: !!threadId && enabled,
    staleTime: THREAD_STATUS_SNAPSHOT_STALE_TIME_MS,
  });
}
