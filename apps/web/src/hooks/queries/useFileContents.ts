import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export function useFileContents(worktreeId: string | null, filePath: string | null) {
  return useQuery({
    queryKey: queryKeys.worktrees.fileContents(worktreeId!, filePath!),
    queryFn: () => api.getFileContents(worktreeId!, filePath!),
    enabled: !!worktreeId && !!filePath,
  });
}
