import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useThreads(worktreeId: string | null) {
  return useQuery({
    queryKey: queryKeys.threads.list(worktreeId!),
    queryFn: () => api.listThreads(worktreeId!),
    enabled: !!worktreeId,
  });
}
