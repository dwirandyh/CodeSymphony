import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function fileContentsQueryOptions(worktreeId: string, filePath: string) {
  return queryOptions({
    queryKey: queryKeys.worktrees.fileContents(worktreeId, filePath),
    queryFn: () => api.getFileContents(worktreeId, filePath),
    retry: false,
  });
}

export function useFileContents(worktreeId: string | null, filePath: string | null) {
  return useQuery({
    ...fileContentsQueryOptions(worktreeId ?? "", filePath ?? ""),
    enabled: !!worktreeId && !!filePath,
  });
}
