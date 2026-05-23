import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { GitStatus } from "@codesymphony/shared-types";
import {
  getGitStatusCollection,
  getCachedGitStatus,
  replaceGitStatusCollection,
  toPlainGitStatus,
  type GitStatusRow,
} from "../../collections/gitStatus";
import { queryKeys } from "../../lib/queryKeys";
import { isUnavailableWorktreeErrorMessage } from "../../lib/workspaceLiveBadgeState";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";

function gitStatusLiveResourceKey(worktreeId: string) {
  return `git_status:${worktreeId}`;
}

type UseGitStatusOptions = {
  enabled?: boolean;
};

export type WorktreeGitStatusChangeCause =
  | "manual_refresh"
  | "file_saved"
  | "thread_activity"
  | "background_thread_activity"
  | "repository_script_activity"
  | "mutation"
  | "workspace_sync"
  | "unknown";

function readGitStatusRows(queryClient: QueryClient, worktreeId: string) {
  return queryClient.getQueryData<GitStatusRow[]>(queryKeys.worktrees.gitStatus(worktreeId));
}

function matchesQueryKey(left: readonly unknown[] | null, right: readonly unknown[] | null) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((segment, index) => segment === right[index]);
}

export function refreshWorktreeGitStatus(queryClient: QueryClient, worktreeId: string) {
  requestWorkspaceLiveResourceRefresh(queryClient, gitStatusLiveResourceKey(worktreeId));
  return getGitStatusCollection(queryClient, worktreeId).utils.refetch();
}

export function markWorktreeGitStatusChanged(
  queryClient: QueryClient,
  worktreeId: string,
  options?: {
    cause?: WorktreeGitStatusChangeCause;
    invalidateDiff?: boolean;
    invalidateBranchDiffSummary?: boolean;
  },
) {
  void options?.cause;
  void refreshWorktreeGitStatus(queryClient, worktreeId);

  if (options?.invalidateDiff) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitDiffScope(worktreeId) });
  }

  if (options?.invalidateBranchDiffSummary) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.worktrees.gitBranchDiffSummary(worktreeId, "__all__"),
      exact: false,
    });
  }
}

export function useGitStatus(worktreeId: string | null, options?: UseGitStatusOptions) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && !!worktreeId;
  const gitStatusQueryKey = useMemo(
    () => worktreeId ? queryKeys.worktrees.gitStatus(worktreeId) : null,
    [worktreeId],
  );
  const collection = useMemo(
    () => enabled && worktreeId ? getGitStatusCollection(queryClient, worktreeId) : null,
    [enabled, queryClient, worktreeId],
  );
  const cachedRows = useSyncExternalStore<GitStatusRow[] | undefined>(
    useCallback(
      (onStoreChange) => {
        if (!gitStatusQueryKey) {
          return () => {};
        }

        return queryClient.getQueryCache().subscribe((event) => {
          const nextQueryKey = event?.query?.queryKey;
          if (!Array.isArray(nextQueryKey) || !matchesQueryKey(gitStatusQueryKey, nextQueryKey)) {
            return;
          }

          onStoreChange();
        });
      },
      [gitStatusQueryKey, queryClient],
    ),
    () => worktreeId ? readGitStatusRows(queryClient, worktreeId) : undefined,
    () => undefined,
  );
  const cachedData = useMemo(
    () => {
      if (!worktreeId) {
        return undefined;
      }

      const firstCachedRow = cachedRows?.[0];
      if (firstCachedRow) {
        return toPlainGitStatus(firstCachedRow);
      }

      return getCachedGitStatus(queryClient, worktreeId);
    },
    [cachedRows, queryClient, worktreeId],
  );
  const liveState = useWorkspaceLiveResource<GitStatus>({
    queryClient,
    key: worktreeId ? gitStatusLiveResourceKey(worktreeId) : "git_status:__disabled__",
    enabled,
    options: {
      transport: {
        kind: "workspace_socket",
        resource: "git_status",
        scopeId: worktreeId ?? "",
      },
      applySnapshot: (snapshot) => {
        if (!worktreeId) {
          return;
        }
        replaceGitStatusCollection(queryClient, worktreeId, snapshot);
      },
      fallbackRefetch: () => worktreeId ? getGitStatusCollection(queryClient, worktreeId).utils.refetch() : undefined,
      shouldFallbackRefetch: ({ errorMessage, reason }) => (
        reason !== "resource_error" || !isUnavailableWorktreeErrorMessage(errorMessage)
      ),
    },
  });
  const { data: liveRows, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const liveData = useMemo<GitStatus | undefined>(
    () => {
      const firstRow = liveRows?.[0] as GitStatusRow | undefined;
      return firstRow ? toPlainGitStatus(firstRow) : undefined;
    },
    [liveRows],
  );
  const data = enabled ? (liveData ?? cachedData) : cachedData;

  return {
    data,
    isLoading: enabled ? data == null && !!collection && (isLoading || collection.utils.isLoading) : false,
    isFetching: enabled ? collection?.utils.isFetching ?? false : false,
    error: enabled
      ? collection?.utils.lastError ?? (liveState.errorMessage ? new Error(liveState.errorMessage) : null)
      : null,
    isError: enabled ? collection?.utils.isError ?? liveState.errorMessage != null : false,
    connectionState: enabled ? liveState.connectionState : "healthy",
    refetch: () => {
      if (!worktreeId) {
        return Promise.resolve([]);
      }
      return refreshWorktreeGitStatus(queryClient, worktreeId);
    },
  };
}

export function requestGitStatusLiveRefresh(queryClient: QueryClient, worktreeId: string) {
  void refreshWorktreeGitStatus(queryClient, worktreeId);
}
