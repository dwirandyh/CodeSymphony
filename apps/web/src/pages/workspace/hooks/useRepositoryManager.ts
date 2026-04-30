import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repository, ScriptResult, Worktree } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useDeleteRepository } from "../../../hooks/mutations/useDeleteRepository";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { useUpdateWorktreeBaseBranch } from "../../../hooks/mutations/useUpdateWorktreeBaseBranch";
import { isRootWorktree } from "../../../lib/worktree";
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
  onSelectionChange?: (selection: { repoId: string | null; worktreeId: string | null }) => void;
  onScriptUpdate?: (event: ScriptUpdateEvent) => void;
  onScriptOutputChunk?: (event: { worktreeId: string; chunk: string }) => void;
}

const SELECTABLE_WORKTREE_STATUSES = new Set<Worktree["status"]>(["active", "delete_failed"]);

function isSelectableWorktreeStatus(status: Worktree["status"]): boolean {
  return SELECTABLE_WORKTREE_STATUSES.has(status);
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

export function useRepositoryManager(
  onError: (msg: string | null) => void,
  options?: UseRepositoryManagerOptions,
) {
  const queryClient = useQueryClient();
  const invalidateGitStatus = (worktreeId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(worktreeId) });
  };
  const {
    data: repositories = [],
    isLoading: loadingRepos,
    error: repositoriesError,
  } = useRepositories();
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

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
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

  function applyRequestedSelection(requestedRepoId: string | null, requestedWorktreeId: string | null): boolean {
    if (requestedWorktreeId) {
      const worktree = repositoryWorktreeIndex.worktreeById.get(requestedWorktreeId);
      const selectableWorktree = worktree && isSelectableWorktree(worktree) ? worktree : null;
      if (selectableWorktree) {
        if (selectedRepositoryId !== selectableWorktree.repository.id) {
          setSelectedRepositoryId(selectableWorktree.repository.id);
        }
        if (selectedWorktreeId !== requestedWorktreeId) {
          setSelectedWorktreeId(requestedWorktreeId);
        }
        return true;
      }
    }

    if (requestedRepoId) {
      const repo = repositoryWorktreeIndex.repositoryById.get(requestedRepoId);
      if (!repo) {
        return false;
      }

      const fallbackWorktreeId = resolveAvailableWorktreeId(repo);
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

  useEffect(() => {
    if (repositories.length === 0) {
      const hadRepositories = previousRepositoryCountRef.current > 0;
      previousRepositoryCountRef.current = 0;
      if (hadRepositories) {
        queryClient.removeQueries({ queryKey: ["threads"] });
        queryClient.removeQueries({ queryKey: ["worktrees"] });
        onError(null);
      }
      if (selectedRepositoryId !== null) {
        setSelectedRepositoryId(null);
      }
      if (selectedWorktreeId !== null) {
        setSelectedWorktreeId(null);
      }
      return;
    }

    const previousRepositories = previousRepositoriesRef.current;
    previousRepositoryCountRef.current = repositories.length;
    previousRepositoriesRef.current = repositories;

    const requestedRepoId = options?.desiredRepoId ?? null;
    const requestedWorktreeId = options?.desiredWorktreeId ?? null;
    const requestedSelectionChanged =
      prevRequestedSelectionRef.current.repoId !== requestedRepoId
      || prevRequestedSelectionRef.current.worktreeId !== requestedWorktreeId;

    if (requestedSelectionChanged) {
      prevRequestedSelectionRef.current = {
        repoId: requestedRepoId,
        worktreeId: requestedWorktreeId,
      };

      if (applyRequestedSelection(requestedRepoId, requestedWorktreeId)) {
        return;
      }
    }

    const selectedRepositoryStillExists =
      selectedRepositoryId == null || repositoryWorktreeIndex.repositoryById.has(selectedRepositoryId);
    const selectedWorktree = selectedWorktreeId == null
      ? null
      : repositoryWorktreeIndex.worktreeById.get(selectedWorktreeId) ?? null;
    const selectedWorktreeStillExists = selectedWorktreeId == null || selectedWorktree != null;
    const selectedWorktreeStillSelectable = selectedWorktreeId == null || isSelectableWorktree(selectedWorktree);
    const unavailableSelectedWorktree = selectedWorktree != null && !isSelectableWorktree(selectedWorktree)
      ? selectedWorktree
      : null;
    const selectedRepositoryExistedPreviously =
      selectedRepositoryId != null && previousRepositories.some((repository) => repository.id === selectedRepositoryId);
    const selectedWorktreeExistedPreviously =
      selectedWorktreeId != null && previousRepositories.some((repository) => repository.worktrees.some((worktree) => worktree.id === selectedWorktreeId));

    if (!selectedRepositoryStillExists && selectedRepositoryExistedPreviously) {
      setSelectedRepositoryId(null);
      return;
    }
    if (!selectedWorktreeStillExists && selectedWorktreeExistedPreviously) {
      setSelectedWorktreeId(null);
      return;
    }
    if (unavailableSelectedWorktree) {
      const fallbackWorktreeId = resolveAvailableWorktreeId(
        unavailableSelectedWorktree.repository,
        unavailableSelectedWorktree.id,
      );
      if (selectedRepositoryId !== unavailableSelectedWorktree.repository.id) {
        setSelectedRepositoryId(unavailableSelectedWorktree.repository.id);
      }
      if (selectedWorktreeId !== fallbackWorktreeId) {
        setSelectedWorktreeId(fallbackWorktreeId);
      }
      return;
    }

    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstRepo = repositories[0];
      if (firstRepo) {
        const fallbackWorktreeId = resolveAvailableWorktreeId(firstRepo);
        if (fallbackWorktreeId) {
          setSelectedWorktreeId(fallbackWorktreeId);
        }
      }
    }
  }, [
    onError,
    options?.desiredRepoId,
    options?.desiredWorktreeId,
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
      options?.onSelectionChange?.({ repoId: selectedRepositoryId, worktreeId: selectedWorktreeId });
    }
  }, [selectedRepositoryId, selectedWorktreeId]);

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

  async function submitWorktree(repositoryId: string) {
    onError(null);
    try {
      const { worktree } = await createWorktreeMutation.mutateAsync({ repositoryId });
      setSelectedWorktreeId(worktree.id);
      setSelectedRepositoryId(repositoryId);
      // Fire setup scripts in background — does not block worktree creation
      runSetupStreaming(worktree.id, worktree.branch);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create worktree");
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

    queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
      markWorktreeDeletionRequested(old ?? repositoriesSnapshot, worktreeId),
    );

    if (selectedWorktreeId === worktreeId) {
      setSelectedRepositoryId(targetRepository?.id ?? previousSelection.repositoryId);
      setSelectedWorktreeId(fallbackWorktreeId ?? null);
    }

    try {
      await deleteWorktreeMutation.mutateAsync({
        worktreeId,
        options: { force: options?.force },
      });
    } catch (e) {
      queryClient.setQueryData(queryKeys.repositories.all, repositoriesSnapshot);
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
