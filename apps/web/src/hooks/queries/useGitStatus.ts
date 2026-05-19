import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { GitStatus } from "@codesymphony/shared-types";
import {
  getGitStatusCollection,
  replaceGitStatusCollection,
  toPlainGitStatus,
  type GitStatusRow,
} from "../../collections/gitStatus";
import { isUnavailableWorktreeErrorMessage } from "../../lib/workspaceLiveBadgeState";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";

function gitStatusLiveResourceKey(worktreeId: string) {
  return `git_status:${worktreeId}`;
}

export function useGitStatus(worktreeId: string | null) {
  const queryClient = useQueryClient();
  const collection = useMemo(
    () => worktreeId ? getGitStatusCollection(queryClient, worktreeId) : null,
    [queryClient, worktreeId],
  );
  const liveState = useWorkspaceLiveResource<GitStatus>({
    queryClient,
    key: worktreeId ? gitStatusLiveResourceKey(worktreeId) : "git_status:__disabled__",
    enabled: !!worktreeId,
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
  const data = useMemo<GitStatus | undefined>(
    () => {
      const firstRow = liveRows?.[0] as GitStatusRow | undefined;
      return firstRow ? toPlainGitStatus(firstRow) : undefined;
    },
    [liveRows],
  );

  return {
    data,
    isLoading: collection ? isLoading || collection.utils.isLoading : false,
    isFetching: collection?.utils.isFetching ?? false,
    error: collection?.utils.lastError ?? (liveState.errorMessage ? new Error(liveState.errorMessage) : null),
    isError: collection?.utils.isError ?? liveState.errorMessage != null,
    connectionState: liveState.connectionState,
    refetch: () => {
      if (!worktreeId || !collection) {
        return Promise.resolve([]);
      }
      requestWorkspaceLiveResourceRefresh(queryClient, gitStatusLiveResourceKey(worktreeId));
      return collection.utils.refetch();
    },
  };
}

export function requestGitStatusLiveRefresh(queryClient: ReturnType<typeof useQueryClient>, worktreeId: string) {
  requestWorkspaceLiveResourceRefresh(queryClient, gitStatusLiveResourceKey(worktreeId));
}
