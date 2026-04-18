import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function gitDiffQueryOptions(worktreeId: string, opts?: { filePath?: string }) {
  return queryOptions({
    queryKey: queryKeys.worktrees.gitDiffRaw(worktreeId, opts?.filePath),
    queryFn: () => api.getGitDiff(worktreeId, opts),
    retry: false,
  });
}

export function useGitDiff(worktreeId: string | null, opts?: { filePath?: string }) {
  return useQuery({
    ...gitDiffQueryOptions(worktreeId ?? "", opts),
    enabled: !!worktreeId,
  });
}
