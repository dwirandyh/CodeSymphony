import type { QueryClient } from "@tanstack/react-query";

export function invalidateWorktreeGitQueries(queryClient: QueryClient, worktreeId: string) {
  void queryClient.invalidateQueries({ queryKey: ["worktrees", worktreeId, "gitStatus"] });
  void queryClient.invalidateQueries({ queryKey: ["worktrees", worktreeId, "gitDiff"] });
  void queryClient.invalidateQueries({ queryKey: ["worktrees", worktreeId, "gitBranchDiffSummary"] });
}
