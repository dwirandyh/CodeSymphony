import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repository, ScriptResult, Worktree } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { markWorktreeGitStatusChanged } from "../../../hooks/queries/useGitStatus";
import { api } from "../../../lib/api";
import { debugLog } from "../../../lib/debugLog";
import { queryKeys } from "../../../lib/queryKeys";
import { measureStartupMetricSinceBoot } from "../../../lib/startupPerf";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useDeleteRepository } from "../../../hooks/mutations/useDeleteRepository";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { useUpdateWorktreeBaseBranch } from "../../../hooks/mutations/useUpdateWorktreeBaseBranch";
import { refetchRepositoriesCollection, upsertRepositoryInCollection } from "../../../collections/repositories";
import {
  isPendingWorktreeStatus,
  isRootWorktree,
  isSelectableWorktreeStatus,
} from "../../../lib/worktree";
import { buildRepositoryWorktreeIndex } from "../../../collections/worktrees";

export interface ScriptUpdateEvent {
  worktreeId: string;
  worktreeName: string;
  type: "setup" | "teardown" | "run";
  status: "running" | "completed";
  result?: ScriptResult;
}

interface UseRepositoryManagerOptions {
  desiredRepoId?: string;
  desiredWorktreeId?: string;
  preserveMissingDesiredWorktree?: boolean;
  repositoriesEnabled?: boolean;
  onSelectionChange?: (selection: { repoId: string | null; worktreeId: string | null }) => void;
  onScriptUpdate?: (event: ScriptUpdateEvent) => void;
  onScriptOutputChunk?: (event: { worktreeId: string; chunk: string }) => void;
}

interface SubmitWorktreeOptions {
  select?: boolean;
}

function isSelectableWorktree(worktree: Pick<Worktree, "status"> | null | undefined): boolean {
  return !!worktree && isSelectableWorktreeStatus(worktree.status);
}

function resolveAvailableWorktreeId(repository: Repository, excludedWorktreeId?: string | null): string | null {
  const selectableWorktrees = repository.worktrees.filter((worktree) =>
    isSelectableWorktree(worktree) && worktree.id !== excludedWorktreeId,
  );
  const rootWorktree = selectableWorktrees.find((worktree) => isRootWorktree(worktree, repository)) ?? null;
  return rootWorktree?.id ?? selectableWorktrees[0]?.id ?? null;
}

function markWorktreeDeletionRequested(repositories: Repository[], worktreeId: string): Repository[] {
  return repositories.map((repository) => ({
    ...repository,
    worktrees: repository.worktrees.map((worktree) =>
      worktree.id === worktreeId
        ? {
            ...worktree,
            status: "deleting",
            lastDeleteError: null,
          }
        : worktree,
    ),
  }));
}

function upsertPendingWorktree(
  repositories: Repository[],
  repositoryId: string,
  nextWorktree: Worktree,
): Repository[] {
  return repositories.map((repository) => {
    if (repository.id !== repositoryId) {
      return repository;
    }

    const existingIndex = repository.worktrees.findIndex((worktree) => worktree.id === nextWorktree.id);
    if (existingIndex === -1) {
      return {
        ...repository,
        worktrees: [nextWorktree, ...repository.worktrees],
      };
    }

    const updatedWorktrees = [...repository.worktrees];
    updatedWorktrees[existingIndex] = nextWorktree;
    return {
      ...repository,
      worktrees: updatedWorktrees,
    };
  });
}

function isCollectionSyncNotInitializedError(error: unknown) {
  return error instanceof Error
    && error.message === "Collection must be in 'ready' state for manual sync operations. Sync not initialized yet.";
}

export function useRepositoryManager(
  onError: (msg: string | null) => void,
  options?: UseRepositoryManagerOptions,
) {
  const queryClient = useQueryClient();
  const invalidateGitStatus = (worktreeId: string) => {
    markWorktreeGitStatusChanged(queryClient, worktreeId, {
      cause: "repository_script_activity",
    });
  };
  const {
    data: repositories = [],
    isLoading: loadingRepos,
    error: repositoriesError,
  } = useRepositories({
    enabled: options?.repositoriesEnabled ?? true,
  });
  const repositoryWorktreeIndex = useMemo(
    () => buildRepositoryWorktreeIndex(repositories),
    [repositories],
  );

  const createRepoMutation = useCreateRepository();
  const createWorktreeMutation = useCreateWorktree();
  const deleteWorktreeMutation = useDeleteWorktree();
  const deleteRepoMutation = useDeleteRepository();
  const renameBranchMutation = useRenameWorktreeBranch();
  const updateWorktreeBaseBranchMutation = useUpdateWorktreeBaseBranch();

  const activeStreamRef = useRef<{ worktreeId: string; eventSource: EventSource } | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);

  function runSetupStreaming(worktreeId: string, worktreeName: string) {
    options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "running" });

    const es = api.runSetupStream(worktreeId);
    activeStreamRef.current = { worktreeId, eventSource: es };
    setSetupRunning(true);

    es.addEventListener("output", (e) => {
      const { chunk } = JSON.parse(e.data);
      options?.onScriptOutputChunk?.({ worktreeId, chunk });
    });

    es.addEventListener("done", (e) => {
      const { success } = JSON.parse(e.data);
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "completed", result: { success, output: "" } });
      invalidateGitStatus(worktreeId);
      es.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    });

    es.onerror = () => {
      options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "setup", status: "completed", result: { success: false, output: "Connection lost" } });
      invalidateGitStatus(worktreeId);
      es.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    };
  }

  async function stopSetup() {
    const stream = activeStreamRef.current;
    if (stream) {
      await api.stopSetupScript(stream.worktreeId);
      invalidateGitStatus(stream.worktreeId);
      stream.eventSource.close();
      activeStreamRef.current = null;
      setSetupRunning(false);
    }
  }

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(() => options?.desiredRepoId ?? null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(() => options?.desiredWorktreeId ?? null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [updatingTargetBranchWorktreeId, setUpdatingTargetBranchWorktreeId] = useState<string | null>(null);

  const previousRepositoryCountRef = useRef(0);
  const previousRepositoriesRef = useRef(repositories);
  const prevSelectionRef = useRef<{ repoId: string | null; worktreeId: string | null }>({
    repoId: null,
    worktreeId: null,
  });
  const prevRequestedSelectionRef = useRef<{ repoId: string | null; worktreeId: string | null }>({
    repoId: null,
    worktreeId: null,
  });
  const repositorySelectionDebugSignatureRef = useRef<string | null>(null);
  const rapidSelectionDebugSignatureRef = useRef<string | null>(null);
  const selectionTransitionHistoryRef = useRef<Array<{
    atMs: number;
    repoId: string | null;
    worktreeId: string | null;
    desiredRepoId: string | null;
    desiredWorktreeId: string | null;
  }>>([]);
  const pendingCreatedWorktreesRef = useRef<Map<string, { previousSelection: { repositoryId: string | null; worktreeId: string | null } }>>(new Map());
  const pendingSetupWorktreeIdsRef = useRef<Set<string>>(new Set());
  const pendingWorktreeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedRepository = useMemo(() => {
    if (selectedRepositoryId) {
      return repositoryWorktreeIndex.repositoryById.get(selectedRepositoryId) ?? null;
    }
    return selectedWorktreeId
      ? repositoryWorktreeIndex.worktreeById.get(selectedWorktreeId)?.repository ?? null
      : null;
  }, [repositoryWorktreeIndex, selectedRepositoryId, selectedWorktreeId]);

  const selectedWorktree = useMemo(() => {
    return selectedWorktreeId
      ? repositoryWorktreeIndex.worktreeById.get(selectedWorktreeId) ?? null
      : null;
  }, [repositoryWorktreeIndex, selectedWorktreeId]);

  function findWorktreeName(worktreeId: string): string {
    return repositoryWorktreeIndex.worktreeById.get(worktreeId)?.branch ?? worktreeId;
  }

  useEffect(() => {
    return () => {
      if (pendingWorktreeRefreshTimerRef.current) {
        clearTimeout(pendingWorktreeRefreshTimerRef.current);
        pendingWorktreeRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const pendingCreatedWorktrees = pendingCreatedWorktreesRef.current;
    const pendingSetupWorktreeIds = pendingSetupWorktreeIdsRef.current;
    let hasPendingCreatedWorktree = false;

    for (const [worktreeId, pendingState] of pendingCreatedWorktrees) {
      const worktree = repositoryWorktreeIndex.worktreeById.get(worktreeId) ?? null;
      if (!worktree) {
        pendingCreatedWorktrees.delete(worktreeId);
        pendingSetupWorktreeIds.delete(worktreeId);
        continue;
      }

      if (isPendingWorktreeStatus(worktree.status)) {
        hasPendingCreatedWorktree = true;
        continue;
      }

      pendingCreatedWorktrees.delete(worktreeId);

      if (worktree.status === "create_failed") {
        pendingSetupWorktreeIds.delete(worktreeId);
        if (selectedWorktreeId === worktreeId) {
          const fallbackRepositoryId = pendingState.previousSelection.repositoryId ?? worktree.repository.id;
          const fallbackRepository = repositoryWorktreeIndex.repositoryById.get(fallbackRepositoryId)
            ?? repositories[0]
            ?? null;
          const fallbackWorktreeId = fallbackRepository
            ? resolveAvailableWorktreeId(fallbackRepository, worktreeId)
            : null;
          setSelectedRepositoryId(fallbackRepository?.id ?? null);
          setSelectedWorktreeId(fallbackWorktreeId);
        }
        onError(worktree.lastCreateError ?? "Failed to create worktree");
        continue;
      }

      if (worktree.repository.setupScript && worktree.repository.setupScript.length > 0) {
        pendingSetupWorktreeIds.add(worktreeId);
      }
    }

    if (hasPendingCreatedWorktree) {
      if (!pendingWorktreeRefreshTimerRef.current) {
        pendingWorktreeRefreshTimerRef.current = setTimeout(() => {
          pendingWorktreeRefreshTimerRef.current = null;
          void refetchRepositoriesCollection(queryClient);
        }, 1_000);
      }
    } else if (pendingWorktreeRefreshTimerRef.current) {
      clearTimeout(pendingWorktreeRefreshTimerRef.current);
      pendingWorktreeRefreshTimerRef.current = null;
    }

    if (activeStreamRef.current || pendingSetupWorktreeIds.size === 0) {
      return;
    }

    const nextSetupWorktreeId = Array.from(pendingSetupWorktreeIds).find((worktreeId) => {
      const worktree = repositoryWorktreeIndex.worktreeById.get(worktreeId);
      return worktree?.repository.setupScript != null && worktree.repository.setupScript.length > 0;
    }) ?? null;

    if (!nextSetupWorktreeId) {
      pendingSetupWorktreeIds.clear();
      return;
    }

    const nextSetupWorktree = repositoryWorktreeIndex.worktreeById.get(nextSetupWorktreeId);
    if (!nextSetupWorktree) {
      pendingSetupWorktreeIds.delete(nextSetupWorktreeId);
      return;
    }

    pendingSetupWorktreeIds.delete(nextSetupWorktreeId);
    runSetupStreaming(nextSetupWorktreeId, nextSetupWorktree.branch);
  }, [onError, queryClient, repositories, repositoryWorktreeIndex, selectedWorktreeId, setupRunning]);

  function applyRequestedSelection(requestedRepoId: string | null, requestedWorktreeId: string | null): boolean {
    if (requestedWorktreeId) {
      const worktree = repositoryWorktreeIndex.worktreeById.get(requestedWorktreeId);
      const selectableWorktree = worktree && isSelectableWorktree(worktree) ? worktree : null;
      if (selectableWorktree) {
        const repositoryWillChange = selectedRepositoryId !== selectableWorktree.repository.id;
        const worktreeWillChange = selectedWorktreeId !== requestedWorktreeId;
        if (repositoryWillChange || worktreeWillChange) {
          debugLog("workspace.selection.repository", "requestedSelection.apply", {
            reason: "requested-worktree",
            requestedRepoId,
            requestedWorktreeId,
            previousRepositoryId: selectedRepositoryId,
            previousWorktreeId: selectedWorktreeId,
            nextRepositoryId: selectableWorktree.repository.id,
            nextWorktreeId: requestedWorktreeId,
            repositoryWillChange,
            worktreeWillChange,
            worktreeStatus: selectableWorktree.status,
          }, { worktreeId: requestedWorktreeId });
        }
        if (selectedRepositoryId !== selectableWorktree.repository.id) {
          setSelectedRepositoryId(selectableWorktree.repository.id);
        }
        if (selectedWorktreeId !== requestedWorktreeId) {
          setSelectedWorktreeId(requestedWorktreeId);
        }
        return true;
      }

      debugLog("workspace.selection.repository", "requestedSelection.unresolved", {
        reason: worktree ? "unselectable-worktree" : "missing-worktree",
        requestedRepoId,
        requestedWorktreeId,
        previousRepositoryId: selectedRepositoryId,
        previousWorktreeId: selectedWorktreeId,
        worktreeStatus: worktree?.status ?? null,
        availableWorktreeIds: requestedRepoId
          ? repositoryWorktreeIndex.repositoryById.get(requestedRepoId)?.worktrees
            .filter((candidate) => isSelectableWorktree(candidate))
            .map((candidate) => candidate.id) ?? []
          : [],
      }, { worktreeId: requestedWorktreeId });
      return false;
    }

    if (requestedRepoId) {
      const repo = repositoryWorktreeIndex.repositoryById.get(requestedRepoId);
      if (!repo) {
        debugLog("workspace.selection.repository", "requestedSelection.unresolved", {
          reason: "missing-repository",
          requestedRepoId,
          requestedWorktreeId,
          previousRepositoryId: selectedRepositoryId,
          previousWorktreeId: selectedWorktreeId,
        });
        return false;
      }

      const fallbackWorktreeId = resolveAvailableWorktreeId(repo);
      const repositoryWillChange = selectedRepositoryId !== repo.id;
      const worktreeWillChange = selectedWorktreeId !== fallbackWorktreeId;
      if (repositoryWillChange || worktreeWillChange) {
        debugLog("workspace.selection.repository", "requestedSelection.apply", {
          reason: "requested-repository-fallback-worktree",
          requestedRepoId,
          requestedWorktreeId,
          previousRepositoryId: selectedRepositoryId,
          previousWorktreeId: selectedWorktreeId,
          nextRepositoryId: repo.id,
          nextWorktreeId: fallbackWorktreeId,
          repositoryWillChange,
          worktreeWillChange,
          availableWorktreeIds: repo.worktrees.filter((worktree) => isSelectableWorktree(worktree)).map((worktree) => worktree.id),
        }, { worktreeId: fallbackWorktreeId });
      }
      if (selectedRepositoryId !== repo.id) {
        setSelectedRepositoryId(repo.id);
      }
      if (selectedWorktreeId !== fallbackWorktreeId) {
        setSelectedWorktreeId(fallbackWorktreeId);
      }
      return true;
    }

    return false;
  }

  function keepRequestedSelection(requestedRepoId: string | null, requestedWorktreeId: string | null): boolean {
    if (requestedRepoId == null && requestedWorktreeId == null) {
      return false;
    }

    if (requestedRepoId != null && selectedRepositoryId !== requestedRepoId) {
      setSelectedRepositoryId(requestedRepoId);
    }
    if (requestedWorktreeId != null && selectedWorktreeId !== requestedWorktreeId) {
      setSelectedWorktreeId(requestedWorktreeId);
    }
    return true;
  }

  useEffect(() => {
    const requestedRepoId = options?.desiredRepoId ?? null;
    const requestedWorktreeId = options?.desiredWorktreeId ?? null;

    if (repositories.length === 0) {
      const hadRepositories = previousRepositoryCountRef.current > 0;
      previousRepositoryCountRef.current = 0;
      if (hadRepositories) {
        queryClient.removeQueries({ queryKey: ["threads"] });
        queryClient.removeQueries({ queryKey: ["worktrees"] });
        onError(null);
      }

      const shouldPreserveRequestedSelection = requestedRepoId != null || requestedWorktreeId != null;
      if (shouldPreserveRequestedSelection) {
        const nextRepositoryId = requestedRepoId ?? selectedRepositoryId;
        const nextWorktreeId = requestedWorktreeId ?? selectedWorktreeId;
        debugLog("workspace.selection.repository", "empty-repositories.preserve-requested", {
          hadRepositories,
          selectedRepositoryId,
          selectedWorktreeId,
          requestedRepoId,
          requestedWorktreeId,
          nextRepositoryId,
          nextWorktreeId,
        }, { worktreeId: nextWorktreeId, force: true });
        if (selectedRepositoryId !== nextRepositoryId) {
          setSelectedRepositoryId(nextRepositoryId);
        }
        if (selectedWorktreeId !== nextWorktreeId) {
          setSelectedWorktreeId(nextWorktreeId);
        }
        return;
      }

      if (selectedRepositoryId !== null) {
        debugLog("workspace.selection.repository", "empty-repositories.clear-repository", {
          hadRepositories,
          selectedRepositoryId,
          selectedWorktreeId,
          requestedRepoId,
          requestedWorktreeId,
        }, { worktreeId: selectedWorktreeId, force: true });
        setSelectedRepositoryId(null);
      }
      if (selectedWorktreeId !== null) {
        debugLog("workspace.selection.repository", "empty-repositories.clear-worktree", {
          hadRepositories,
          selectedRepositoryId,
          selectedWorktreeId,
          requestedRepoId,
          requestedWorktreeId,
        }, { worktreeId: selectedWorktreeId, force: true });
        setSelectedWorktreeId(null);
      }
      return;
    }

    const previousRepositories = previousRepositoriesRef.current;
    previousRepositoryCountRef.current = repositories.length;
    previousRepositoriesRef.current = repositories;

    const previousRequestedSelection = prevRequestedSelectionRef.current;
    const requestedSelectionChanged =
      previousRequestedSelection.repoId !== requestedRepoId
      || previousRequestedSelection.worktreeId !== requestedWorktreeId;

    if (requestedSelectionChanged) {
      prevRequestedSelectionRef.current = {
        repoId: requestedRepoId,
        worktreeId: requestedWorktreeId,
      };
    }

    const shouldApplyRequestedSelection =
      requestedSelectionChanged
      || (
        requestedWorktreeId != null
          ? selectedWorktreeId === requestedWorktreeId
          : requestedRepoId != null && selectedRepositoryId === requestedRepoId
      );
    const requestedSelectionApplied = shouldApplyRequestedSelection
      ? applyRequestedSelection(requestedRepoId, requestedWorktreeId)
      : false;
    const repositorySelectionDebugState = {
      requestedRepoId,
      requestedWorktreeId,
      selectedRepositoryId,
      selectedWorktreeId,
      previousRequestedRepoId: previousRequestedSelection.repoId,
      previousRequestedWorktreeId: previousRequestedSelection.worktreeId,
      requestedSelectionChanged,
      shouldApplyRequestedSelection,
      requestedSelectionApplied,
      repositoryCount: repositories.length,
      selectedWorktreeKnown: selectedWorktreeId == null || repositoryWorktreeIndex.worktreeById.has(selectedWorktreeId),
      requestedWorktreeKnown: requestedWorktreeId == null || repositoryWorktreeIndex.worktreeById.has(requestedWorktreeId),
    };
    const repositorySelectionDebugSignature = JSON.stringify(repositorySelectionDebugState);
    if (repositorySelectionDebugSignatureRef.current !== repositorySelectionDebugSignature) {
      repositorySelectionDebugSignatureRef.current = repositorySelectionDebugSignature;
      debugLog("workspace.selection.repository", "requestedSelection.evaluated", repositorySelectionDebugState, {
        worktreeId: selectedWorktreeId ?? requestedWorktreeId,
        force: requestedSelectionChanged || requestedSelectionApplied,
      });
    }
    if (requestedSelectionChanged && requestedSelectionApplied) {
      return;
    }

    const requestedWorktreeRecord = requestedWorktreeId != null
      ? repositoryWorktreeIndex.worktreeById.get(requestedWorktreeId) ?? null
      : null;
    const requestedWorktreeExistedPreviously = requestedWorktreeId != null
      && previousRepositories.some((repository) =>
        repository.worktrees.some((worktree) => worktree.id === requestedWorktreeId)
      );
    const requestedSelectionUnresolved =
      (requestedWorktreeId != null && requestedWorktreeRecord == null)
      || (requestedWorktreeId == null && requestedRepoId != null && !repositoryWorktreeIndex.repositoryById.has(requestedRepoId));
    const preserveMissingDesiredWorktree = options?.preserveMissingDesiredWorktree ?? true;
    const requestedSelectionPending = !requestedSelectionApplied
      && requestedSelectionUnresolved
      && preserveMissingDesiredWorktree
      && !requestedWorktreeExistedPreviously
      && keepRequestedSelection(requestedRepoId, requestedWorktreeId);
    const shouldFallbackFromMissingDesiredWorktree = requestedWorktreeId != null
      && selectedWorktreeId === requestedWorktreeId
      && requestedSelectionUnresolved
      && !preserveMissingDesiredWorktree;

    if (requestedSelectionPending) {
      return;
    }

    if (shouldFallbackFromMissingDesiredWorktree) {
      const fallbackRepository = requestedRepoId != null
        ? repositoryWorktreeIndex.repositoryById.get(requestedRepoId) ?? null
        : selectedRepositoryId != null
          ? repositoryWorktreeIndex.repositoryById.get(selectedRepositoryId) ?? null
          : repositories[0] ?? null;
      const fallbackWorktreeId = fallbackRepository
        ? resolveAvailableWorktreeId(fallbackRepository, requestedWorktreeId)
        : null;

      if (selectedRepositoryId !== (fallbackRepository?.id ?? null)) {
        setSelectedRepositoryId(fallbackRepository?.id ?? null);
      }
      if (selectedWorktreeId !== fallbackWorktreeId) {
        setSelectedWorktreeId(fallbackWorktreeId);
      }
      return;
    }

    const selectedRepositoryStillExists =
      selectedRepositoryId == null || repositoryWorktreeIndex.repositoryById.has(selectedRepositoryId);
    const selectedWorktree = selectedWorktreeId == null
      ? null
      : repositoryWorktreeIndex.worktreeById.get(selectedWorktreeId) ?? null;
    const selectedWorktreeStillExists = selectedWorktreeId == null || selectedWorktree != null;
    const selectedWorktreeStillSelectable = selectedWorktreeId == null || isSelectableWorktree(selectedWorktree);
    const pendingCreatedSelection = selectedWorktreeId != null
      ? pendingCreatedWorktreesRef.current.get(selectedWorktreeId) ?? null
      : null;
    const unavailableSelectedWorktree = selectedWorktree != null && !isSelectableWorktree(selectedWorktree) && pendingCreatedSelection == null
      ? selectedWorktree
      : null;
    const selectedRepositoryExistedPreviously =
      selectedRepositoryId != null && previousRepositories.some((repository) => repository.id === selectedRepositoryId);
    const selectedWorktreeExistedPreviously =
      selectedWorktreeId != null && previousRepositories.some((repository) => repository.worktrees.some((worktree) => worktree.id === selectedWorktreeId));

    if (!selectedRepositoryStillExists && selectedRepositoryExistedPreviously) {
      debugLog("workspace.selection.repository", "selected-repository-missing.clear", {
        selectedRepositoryId,
        selectedWorktreeId,
        requestedRepoId,
        requestedWorktreeId,
        repositoryIds: repositories.map((repository) => repository.id),
      }, { worktreeId: selectedWorktreeId, force: true });
      setSelectedRepositoryId(null);
      return;
    }
    if (!selectedWorktreeStillExists && selectedWorktreeExistedPreviously) {
      debugLog("workspace.selection.repository", "selected-worktree-missing.clear", {
        selectedRepositoryId,
        selectedWorktreeId,
        requestedRepoId,
        requestedWorktreeId,
        knownWorktreeIds: repositories.flatMap((repository) => repository.worktrees.map((worktree) => worktree.id)),
      }, { worktreeId: selectedWorktreeId, force: true });
      setSelectedWorktreeId(null);
      return;
    }
    if (unavailableSelectedWorktree) {
      const fallbackWorktreeId = resolveAvailableWorktreeId(
        unavailableSelectedWorktree.repository,
        unavailableSelectedWorktree.id,
      );
      debugLog("workspace.selection.repository", "unavailable-worktree.fallback", {
        selectedRepositoryId,
        selectedWorktreeId,
        requestedRepoId,
        requestedWorktreeId,
        unavailableWorktreeStatus: unavailableSelectedWorktree.status,
        nextRepositoryId: unavailableSelectedWorktree.repository.id,
        nextWorktreeId: fallbackWorktreeId,
      }, { worktreeId: selectedWorktreeId, force: true });
      if (selectedRepositoryId !== unavailableSelectedWorktree.repository.id) {
        setSelectedRepositoryId(unavailableSelectedWorktree.repository.id);
      }
      if (selectedWorktreeId !== fallbackWorktreeId) {
        setSelectedWorktreeId(fallbackWorktreeId);
      }
      return;
    }

    if (!selectedRepositoryId && repositories[0]) {
      debugLog("workspace.selection.repository", "empty-repository.default", {
        requestedRepoId,
        requestedWorktreeId,
        nextRepositoryId: repositories[0].id,
        repositoryCount: repositories.length,
      }, { force: true });
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstRepo = repositories[0];
      if (firstRepo) {
        const fallbackWorktreeId = resolveAvailableWorktreeId(firstRepo);
        if (fallbackWorktreeId) {
          debugLog("workspace.selection.repository", "empty-worktree.default", {
            requestedRepoId,
            requestedWorktreeId,
            selectedRepositoryId,
            nextWorktreeId: fallbackWorktreeId,
            availableWorktreeIds: firstRepo.worktrees.filter((worktree) => isSelectableWorktree(worktree)).map((worktree) => worktree.id),
          }, { worktreeId: fallbackWorktreeId, force: true });
          setSelectedWorktreeId(fallbackWorktreeId);
        }
      }
    }
  }, [
    onError,
    options?.desiredRepoId,
    options?.desiredWorktreeId,
    options?.preserveMissingDesiredWorktree,
    queryClient,
    repositoryWorktreeIndex,
    repositories,
    selectedRepositoryId,
    selectedWorktreeId,
  ]);

  // Notify parent when selection changes
  useEffect(() => {
    const prev = prevSelectionRef.current;
    const willFire = prev.repoId !== selectedRepositoryId || prev.worktreeId !== selectedWorktreeId;
    if (willFire) {
      prevSelectionRef.current = { repoId: selectedRepositoryId, worktreeId: selectedWorktreeId };
      debugLog("workspace.selection.repository", "selectionChange.notify", {
        previousRepositoryId: prev.repoId,
        previousWorktreeId: prev.worktreeId,
        selectedRepositoryId,
        selectedWorktreeId,
        desiredRepoId: options?.desiredRepoId ?? null,
        desiredWorktreeId: options?.desiredWorktreeId ?? null,
      }, { worktreeId: selectedWorktreeId, force: true });

      const atMs = typeof performance !== "undefined" && typeof performance.now === "function"
        ? Math.round(performance.now() * 10) / 10
        : Date.now();
      const history = selectionTransitionHistoryRef.current;
      history.push({
        atMs,
        repoId: selectedRepositoryId,
        worktreeId: selectedWorktreeId,
        desiredRepoId: options?.desiredRepoId ?? null,
        desiredWorktreeId: options?.desiredWorktreeId ?? null,
      });
      selectionTransitionHistoryRef.current = history
        .filter((entry) => atMs - entry.atMs <= 3_000)
        .slice(-10);

      const recent = selectionTransitionHistoryRef.current;
      const uniqueWorktreeIds = new Set(recent.map((entry) => entry.worktreeId ?? "null"));
      if (recent.length >= 4 && uniqueWorktreeIds.size >= 2) {
        const signature = recent.map((entry) => `${entry.repoId ?? "null"}:${entry.worktreeId ?? "null"}`).join("|");
        if (rapidSelectionDebugSignatureRef.current !== signature) {
          rapidSelectionDebugSignatureRef.current = signature;
          debugLog("workspace.selection.repository", "rapid-selection-transitions", {
            history: recent,
            selectedRepositoryId,
            selectedWorktreeId,
            desiredRepoId: options?.desiredRepoId ?? null,
            desiredWorktreeId: options?.desiredWorktreeId ?? null,
            loadingRepos,
            repositoryCount: repositories.length,
          }, { worktreeId: selectedWorktreeId, force: true });
        }
      }
      options?.onSelectionChange?.({ repoId: selectedRepositoryId, worktreeId: selectedWorktreeId });
    }
  }, [loadingRepos, options?.desiredRepoId, options?.desiredWorktreeId, repositories.length, selectedRepositoryId, selectedWorktreeId]);

  useEffect(() => {
    if (
      loadingRepos
      || !selectedRepositoryId
      || !selectedWorktreeId
      || !repositoryWorktreeIndex.repositoryById.has(selectedRepositoryId)
      || !repositoryWorktreeIndex.worktreeById.has(selectedWorktreeId)
    ) {
      return;
    }

    measureStartupMetricSinceBoot("startup.selected_workspace_ready_ms", {
      source: "useRepositoryManager",
      repositoryId: selectedRepositoryId,
      worktreeId: selectedWorktreeId,
    });
  }, [
    loadingRepos,
    repositoryWorktreeIndex,
    selectedRepositoryId,
    selectedWorktreeId,
  ]);

  async function attachRepository() {
    onError(null);
    try {
      let path = "";
      try {
        const picked = await api.pickDirectory();
        path = picked.path.trim();
      } catch {
        const manualPath =
          typeof window === "undefined"
            ? null
            : window.prompt("Enter the repository path on the runtime machine", "");
        path = manualPath?.trim() ?? "";
      }
      if (!path) return;
      await createRepoMutation.mutateAsync({ path });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add repository");
    }
  }

  function openFileBrowser() {
    setFileBrowserOpen(true);
  }

  async function attachRepositoryFromPath(path: string) {
    onError(null);
    try {
      await createRepoMutation.mutateAsync({ path });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add repository");
    }
  }

  async function submitWorktree(repositoryId: string, options?: SubmitWorktreeOptions): Promise<Worktree | null> {
    onError(null);
    try {
      const previousSelection = {
        repositoryId: selectedRepositoryId,
        worktreeId: selectedWorktreeId,
      };
      const { worktree } = await createWorktreeMutation.mutateAsync({ repositoryId });
      const nextRepositories = upsertPendingWorktree(
        queryClient.getQueryData<Repository[]>(queryKeys.repositories.all) ?? repositories,
        repositoryId,
        worktree,
      );
      const nextRepository = nextRepositories.find((repository) => repository.id === repositoryId) ?? null;
      if (nextRepository) {
        try {
          upsertRepositoryInCollection(queryClient, nextRepository);
        } catch (error) {
          if (!isCollectionSyncNotInitializedError(error)) {
            throw error;
          }

          queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, nextRepositories);
        }
      } else {
        queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, nextRepositories);
      }
      pendingCreatedWorktreesRef.current.set(worktree.id, { previousSelection });
      if (options?.select !== false) {
        setSelectedWorktreeId(worktree.id);
        setSelectedRepositoryId(repositoryId);
      }
      return worktree;
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create worktree");
      return null;
    }
  }

  async function removeWorktree(worktreeId: string, options?: { force?: boolean }) {
    onError(null);
    const repositoriesSnapshot = queryClient.getQueryData<Repository[]>(queryKeys.repositories.all) ?? repositories;
    const targetWorktree = repositoryWorktreeIndex.worktreeById.get(worktreeId) ?? null;
    const targetRepository = targetWorktree?.repository ?? null;
    const previousSelection = {
      repositoryId: selectedRepositoryId,
      worktreeId: selectedWorktreeId,
    };
    const fallbackWorktreeId =
      selectedWorktreeId === worktreeId && targetRepository
        ? resolveAvailableWorktreeId(targetRepository, worktreeId)
        : selectedWorktreeId;

    const deletingRepositories = markWorktreeDeletionRequested(repositoriesSnapshot, worktreeId);
    const deletingRepository = targetRepository
      ? deletingRepositories.find((repository) => repository.id === targetRepository.id) ?? null
      : null;
    if (deletingRepository) {
      upsertRepositoryInCollection(queryClient, deletingRepository);
    } else {
      queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, deletingRepositories);
    }

    if (selectedWorktreeId === worktreeId) {
      setSelectedRepositoryId(targetRepository?.id ?? previousSelection.repositoryId);
      setSelectedWorktreeId(fallbackWorktreeId ?? null);
    }

    try {
      await deleteWorktreeMutation.mutateAsync({
        worktreeId,
        options: { force: options?.force },
      });
      void refetchRepositoriesCollection(queryClient);
    } catch (e) {
      if (targetRepository) {
        upsertRepositoryInCollection(queryClient, targetRepository);
      } else {
        queryClient.setQueryData(queryKeys.repositories.all, repositoriesSnapshot);
      }
      if (selectedWorktreeId === worktreeId) {
        setSelectedRepositoryId(previousSelection.repositoryId);
        setSelectedWorktreeId(previousSelection.worktreeId);
      }
      onError(e instanceof Error ? e.message : "Failed to delete worktree");
    }
  }

  async function removeRepository(repositoryId: string) {
    onError(null);
    try {
      await deleteRepoMutation.mutateAsync(repositoryId);
      if (selectedRepositoryId === repositoryId) {
        setSelectedRepositoryId(null);
        setSelectedWorktreeId(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete repository");
    }
  }

  async function renameWorktreeBranch(worktreeId: string, newBranch: string) {
    onError(null);
    try {
      await renameBranchMutation.mutateAsync({ worktreeId, input: { branch: newBranch } });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to rename branch");
    }
  }

  async function rerunSetup(worktreeId: string) {
    onError(null);
    runSetupStreaming(worktreeId, findWorktreeName(worktreeId));
  }

  const updateWorktreeBranch = useCallback((worktreeId: string, newBranch: string) => {
    queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
      (old ?? repositories).map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((wt) =>
          wt.id === worktreeId ? { ...wt, branch: newBranch } : wt,
        ),
      })),
    );
  }, [queryClient, repositories]);

  async function updateWorktreeTargetBranch(worktreeId: string, newBaseBranch: string) {
    onError(null);
    const worktree = repositoryWorktreeIndex.worktreeById.get(worktreeId);

    if (!worktree) {
      onError("Worktree not found");
      return;
    }

    const trimmedBaseBranch = newBaseBranch.trim();
    if (!trimmedBaseBranch) {
      onError("Target branch is required");
      return;
    }

    const isRoot = isRootWorktree(worktree, worktree.repository);
    const currentTargetBranch = isRoot ? worktree.repository.defaultBranch : worktree.baseBranch;
    if (currentTargetBranch === trimmedBaseBranch) {
      return;
    }

    setUpdatingTargetBranchWorktreeId(worktreeId);

    try {
      if (isRoot) {
        const updatedRepository = await api.updateRepositoryScripts(worktree.repository.id, {
          defaultBranch: trimmedBaseBranch,
        });

        queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
          (old ?? repositories).map((repo) => repo.id === updatedRepository.id ? updatedRepository : repo),
        );
        return;
      }

      await updateWorktreeBaseBranchMutation.mutateAsync({
        worktreeId,
        input: { baseBranch: trimmedBaseBranch },
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update target branch");
    } finally {
      setUpdatingTargetBranchWorktreeId((current) => current === worktreeId ? null : current);
    }
  }

  return {
    repositories,
    repositoriesError,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedRepository,
    selectedWorktree,
    loadingRepos,
    submittingRepo: createRepoMutation.isPending,
    submittingWorktree: createWorktreeMutation.isPending,
    setSelectedRepositoryId,
    setSelectedWorktreeId,
    attachRepository,
    openFileBrowser,
    attachRepositoryFromPath,
    fileBrowserOpen,
    setFileBrowserOpen,
    submitWorktree,
    removeWorktree,
    removeRepository,
    rerunSetup,
    stopSetup,
    setupRunning,
    renameWorktreeBranch,
    updateWorktreeTargetBranch,
    updatingTargetBranchWorktreeId,
    updateWorktreeBranch,
  };
}
