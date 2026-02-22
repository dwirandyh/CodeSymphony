import { useCallback } from "react";
import { useGitStatus } from "../../../hooks/queries/useGitStatus";
import { useGitCommit } from "../../../hooks/mutations/useGitCommit";
import { useDiscardGitChange } from "../../../hooks/mutations/useDiscardGitChange";
import { api } from "../../../lib/api";

export function useGitChanges(worktreeId: string | null, enabled: boolean) {
  const { data, isLoading, refetch } = useGitStatus(enabled ? worktreeId : null);
  const commitMutation = useGitCommit(worktreeId);
  const discardMutation = useDiscardGitChange(worktreeId);

  const commit = useCallback(
    async (message: string) => {
      if (!worktreeId) return;
      await commitMutation.mutateAsync({ message });
    },
    [worktreeId, commitMutation],
  );

  const discardChange = useCallback(
    async (filePath: string) => {
      if (!worktreeId) return;
      await discardMutation.mutateAsync(filePath);
    },
    [worktreeId, discardMutation],
  );

  const getDiff = useCallback(async () => {
    if (!worktreeId) return { diff: "", summary: "" };
    return api.getGitDiff(worktreeId);
  }, [worktreeId]);

  return {
    entries: data?.entries ?? [],
    branch: data?.branch ?? "",
    loading: isLoading,
    committing: commitMutation.isPending,
    error: commitMutation.error?.message ?? discardMutation.error?.message ?? null,
    commit,
    discardChange,
    getDiff,
    refresh: () => void refetch(),
  };
}
