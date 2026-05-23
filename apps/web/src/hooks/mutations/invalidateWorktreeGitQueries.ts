import type { QueryClient } from "@tanstack/react-query";
import { markWorktreeGitStatusChanged } from "../queries/useGitStatus";

export function invalidateWorktreeGitQueries(queryClient: QueryClient, worktreeId: string) {
  markWorktreeGitStatusChanged(queryClient, worktreeId, {
    cause: "mutation",
    invalidateDiff: true,
    invalidateBranchDiffSummary: true,
  });
}
