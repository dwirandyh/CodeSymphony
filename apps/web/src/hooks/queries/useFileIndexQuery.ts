import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useFileIndexQuery(worktreeId: string | null) {
  return useQuery({
    queryKey: queryKeys.worktrees.fileIndex(worktreeId!),
    queryFn: () => api.getFileIndex(worktreeId!),
    enabled: !!worktreeId,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
}
