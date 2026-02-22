import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useGitStatus(worktreeId: string | null) {
  return useQuery({
    queryKey: queryKeys.worktrees.gitStatus(worktreeId!),
    queryFn: () => api.getGitStatus(worktreeId!),
    enabled: !!worktreeId,
    refetchInterval: 5_000,
    staleTime: 4_000,
  });
}
