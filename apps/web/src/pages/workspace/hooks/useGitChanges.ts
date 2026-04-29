import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GitChangeEntry, GitChangeStatus, GitStatus, Repository } from "@codesymphony/shared-types";
import { useGitStatus } from "../../../hooks/queries/useGitStatus";
import { useGitCommit } from "../../../hooks/mutations/useGitCommit";
import { useDiscardGitChange } from "../../../hooks/mutations/useDiscardGitChange";
import { useGitSync } from "../../../hooks/mutations/useGitSync";
import { api } from "../../../lib/api";
import { loadAgentDefaults } from "../agentDefaults";
import { getCachedGitStatus } from "../../../collections/gitStatus";
import { queryKeys } from "../../../lib/queryKeys";

const STATUS_PRIORITY: Record<GitChangeStatus, number> = {
  modified: 0,
  added: 1,
  renamed: 2,
  deleted: 3,
  untracked: 4,
};

export function useGitChanges(worktreeId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useGitStatus(enabled ? worktreeId : null);
  const commitMutation = useGitCommit(worktreeId);
  const discardMutation = useDiscardGitChange(worktreeId);
  const syncMutation = useGitSync(worktreeId);
  const lastKnownStatusByWorktreeRef = useRef<Map<string, GitStatus>>(new Map());
  const cachedData = useMemo(
    () => worktreeId ? getCachedGitStatus(queryClient, worktreeId) : undefined,
    [queryClient, worktreeId],
  );
  const effectiveData = useMemo(
    () => {
      if (!worktreeId) {
        return data;
      }

      if (!enabled) {
        return cachedData;
      }

      return data ?? cachedData;
    },
    [cachedData, data, enabled, worktreeId],
  );
  if (worktreeId && effectiveData) {
    lastKnownStatusByWorktreeRef.current.set(worktreeId, effectiveData);
  }
  const stableData = useMemo(
    () => worktreeId ? (effectiveData ?? lastKnownStatusByWorktreeRef.current.get(worktreeId)) : effectiveData,
    [effectiveData, worktreeId],
  );

  useEffect(() => {
    if (!worktreeId) {
      return;
    }

    const nextBranch = stableData?.branch?.trim();
    if (!nextBranch) {
      return;
    }

    queryClient.setQueryData<Repository[] | undefined>(queryKeys.repositories.all, (current) => {
      if (!current) {
        return current;
      }

      let changed = false;
      const updated = current.map((repository) => {
        let repositoryChanged = false;
        const nextWorktrees = repository.worktrees.map((worktree) => {
          if (worktree.id !== worktreeId || worktree.branch === nextBranch) {
            return worktree;
          }

          changed = true;
          repositoryChanged = true;
          return {
            ...worktree,
            branch: nextBranch,
          };
        });

        return repositoryChanged
          ? {
            ...repository,
            worktrees: nextWorktrees,
          }
          : repository;
      });

      return changed ? updated : current;
    });
  }, [queryClient, stableData?.branch, worktreeId]);

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
    const filteredEntries = (stableData?.entries ?? []).filter((entry) => !entry.path.endsWith("/"));
    return [...filteredEntries].sort((left: GitChangeEntry, right: GitChangeEntry) => {
      const statusDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [stableData?.entries]);

  const ahead = stableData?.ahead ?? 0;
  const behind = stableData?.behind ?? 0;
  const canSync = entries.length === 0 && !!stableData?.upstream && (ahead > 0 || behind > 0);

  return {
    entries,
    branch: stableData?.branch ?? "",
    upstream: stableData?.upstream ?? null,
    ahead,
    behind,
    canSync,
    loading: enabled ? isLoading && stableData == null : false,
    committing: commitMutation.isPending,
    syncing: syncMutation.isPending,
    error: commitMutation.error?.message ?? syncMutation.error?.message ?? discardMutation.error?.message ?? null,
    commit,
    sync,
    discardChange,
    getDiff,
    refresh: () => {
      if (!enabled) {
        return;
      }
      void refetch();
    },
  };
}
