import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useGitDiff(worktreeId: string | null, opts?: { filePath?: string }) {
  return useQuery({
    queryKey: queryKeys.worktrees.gitDiff(worktreeId!, opts?.filePath),
    queryFn: () => api.getGitDiff(worktreeId!, opts),
    enabled: !!worktreeId,
  });
}
