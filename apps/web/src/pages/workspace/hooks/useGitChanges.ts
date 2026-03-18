import { useCallback, useMemo } from "react";
import type { GitChangeStatus } from "@codesymphony/shared-types";
import { useGitStatus } from "../../../hooks/queries/useGitStatus";
import { useGitCommit } from "../../../hooks/mutations/useGitCommit";
import { useDiscardGitChange } from "../../../hooks/mutations/useDiscardGitChange";
import { api } from "../../../lib/api";

const STATUS_PRIORITY: Record<GitChangeStatus, number> = {
  modified: 0,
  added: 1,
  renamed: 2,
  deleted: 3,
  untracked: 4,
};

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

  const entries = useMemo(
    () => (data?.entries ?? [])
      .filter((entry) => !entry.path.endsWith("/"))
      .toSorted((left, right) => {
        const statusDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
        if (statusDiff !== 0) {
          return statusDiff;
        }
        return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
      }),
    [data?.entries],
  );

  return {
    entries,
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
