import { useCallback, useMemo } from "react";
import type { GitChangeEntry, GitChangeStatus } from "@codesymphony/shared-types";
import { useGitStatus } from "../../../hooks/queries/useGitStatus";
import { useGitCommit } from "../../../hooks/mutations/useGitCommit";
import { useDiscardGitChange } from "../../../hooks/mutations/useDiscardGitChange";
import { useGitSync } from "../../../hooks/mutations/useGitSync";
import { api } from "../../../lib/api";
import { loadAgentDefaults } from "../agentDefaults";

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
  const syncMutation = useGitSync(worktreeId);

  const commit = useCallback(
    async (message: string) => {
      if (!worktreeId) return;
      const commitDefaults = loadAgentDefaults().commit;
      await commitMutation.mutateAsync({
        message,
        agent: commitDefaults.agent,
        model: commitDefaults.model,
        modelProviderId: commitDefaults.modelProviderId,
      });
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

  const sync = useCallback(async () => {
    if (!worktreeId) return;
    await syncMutation.mutateAsync();
  }, [worktreeId, syncMutation]);

  const getDiff = useCallback(async () => {
    if (!worktreeId) return { diff: "", summary: "" };
    return api.getGitDiff(worktreeId);
  }, [worktreeId]);

  const entries = useMemo(() => {
    const filteredEntries = (data?.entries ?? []).filter((entry) => !entry.path.endsWith("/"));
    return [...filteredEntries].sort((left: GitChangeEntry, right: GitChangeEntry) => {
      const statusDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [data?.entries]);

  const ahead = data?.ahead ?? 0;
  const behind = data?.behind ?? 0;
  const canSync = entries.length === 0 && !!data?.upstream && (ahead > 0 || behind > 0);

  return {
    entries,
    branch: data?.branch ?? "",
    upstream: data?.upstream ?? null,
    ahead,
    behind,
    canSync,
    loading: isLoading,
    committing: commitMutation.isPending,
    syncing: syncMutation.isPending,
    error: commitMutation.error?.message ?? syncMutation.error?.message ?? discardMutation.error?.message ?? null,
    commit,
    sync,
    discardChange,
    getDiff,
    refresh: () => void refetch(),
  };
}
