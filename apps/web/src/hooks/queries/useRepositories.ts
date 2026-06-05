import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { Repository } from "@codesymphony/shared-types";
import { getRepositoriesCollection, toPlainRepository } from "../../collections/repositories";
import { queryKeys } from "../../lib/queryKeys";
import { readPersistedStartupShellSnapshot, type StartupShellSnapshot } from "../../lib/startupShellSnapshot";

const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";

function repositoriesFromStartupShellSnapshot(snapshot: StartupShellSnapshot | null): Repository[] {
  if (!snapshot?.repositories?.length) {
    return [];
  }

  const timestamp = snapshot.capturedAt || FALLBACK_TIMESTAMP;
  return snapshot.repositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    rootPath: repository.rootPath,
    defaultBranch: repository.defaultBranch,
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    worktrees: repository.worktrees.map((worktree) => ({
      id: worktree.id,
      repositoryId: worktree.repositoryId,
      branch: worktree.branch,
      path: worktree.path,
      baseBranch: worktree.baseBranch,
      status: worktree.status,
      branchRenamed: worktree.branchRenamed,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  }));
}

function readStartupShellRepositoryFallback(): Repository[] {
  if (typeof window === "undefined") {
    return [];
  }

  return repositoriesFromStartupShellSnapshot(readPersistedStartupShellSnapshot());
}

export function useRepositories(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const collection = useMemo(
    () => enabled ? getRepositoriesCollection(queryClient) : null,
    [enabled, queryClient],
  );
  const { data: liveRepositories, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const { data: cachedRepositories } = useQuery<Repository[]>({
    queryKey: queryKeys.repositories.all,
    queryFn: async () => [],
    enabled: false,
  });
  const recoveryRefetchTriggeredRef = useRef(false);
  const lastNonEmptyDataRef = useRef<Repository[]>([]);
  const startupShellFallbackDataRef = useRef<Repository[]>([]);
  if (!enabled) {
    lastNonEmptyDataRef.current = [];
    startupShellFallbackDataRef.current = [];
  } else if (startupShellFallbackDataRef.current.length === 0) {
    startupShellFallbackDataRef.current = readStartupShellRepositoryFallback();
  }
  const liveData = useMemo(
    () => liveRepositories?.map((repository) => toPlainRepository(repository as Repository)) ?? [],
    [liveRepositories],
  );
  const fallbackData = useMemo(
    () => cachedRepositories?.map((repository) => toPlainRepository(repository)) ?? [],
    [cachedRepositories],
  );
  const shouldRecoverFromFallback = liveData.length === 0 && fallbackData.length > 0;
  const collectionStillLoading = isLoading || collection?.utils.isLoading || false;
  const collectionFetching = collection?.utils.isFetching ?? false;
  const collectionTransientlyEmpty = collectionStillLoading
    || collectionFetching
    || collection?.utils.isError
    || collection?.hasPendingSeedRecoveryRefetch?.()
    || false;
  const primaryData = liveData.length > 0 ? liveData : fallbackData;
  if (primaryData.length > 0) {
    lastNonEmptyDataRef.current = primaryData;
  }
  const transientFallbackData = lastNonEmptyDataRef.current.length > 0
    ? lastNonEmptyDataRef.current
    : startupShellFallbackDataRef.current;
  const data = primaryData.length > 0
    ? primaryData
    : collectionTransientlyEmpty
      ? transientFallbackData
      : [];

  useEffect(() => {
    if (!enabled || !collection) {
      recoveryRefetchTriggeredRef.current = false;
      return;
    }

    if (!shouldRecoverFromFallback) {
      recoveryRefetchTriggeredRef.current = false;
      return;
    }

    if (collectionStillLoading || recoveryRefetchTriggeredRef.current || collectionFetching) {
      return;
    }

    recoveryRefetchTriggeredRef.current = true;
    void collection.utils.refetch().catch(() => {});
  }, [collection, collectionFetching, collectionStillLoading, enabled, shouldRecoverFromFallback]);

  return {
    data,
    isLoading: collection ? data.length === 0 && (isLoading || collection.utils.isLoading) : false,
    isFetching: collection?.utils.isFetching ?? false,
    error: collection?.utils.lastError ?? null,
    isError: collection?.utils.isError ?? false,
    refetch: () => collection ? collection.utils.refetch() : Promise.resolve([]),
  };
}
