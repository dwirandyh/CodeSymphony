import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repository, ScriptResult } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api, TeardownFailedError } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useDeleteRepository } from "../../../hooks/mutations/useDeleteRepository";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { findRepositoryByWorktree } from "../eventUtils";
import { findRootWorktree } from "../../../lib/worktree";

export interface TeardownErrorState {
  worktreeId: string;
  worktreeName: string;
  output: string;
}

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
  onTeardownError?: (state: TeardownErrorState) => void;
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

  const createRepoMutation = useCreateRepository();
  const createWorktreeMutation = useCreateWorktree();
  const deleteWorktreeMutation = useDeleteWorktree();
  const deleteRepoMutation = useDeleteRepository();
  const renameBranchMutation = useRenameWorktreeBranch();

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
      return repositories.find((r) => r.id === selectedRepositoryId) ?? null;
    }
    return findRepositoryByWorktree(repositories, selectedWorktreeId);
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) return null;
    for (const repo of repositories) {
      const found = repo.worktrees.find((w) => w.id === selectedWorktreeId);
      if (found) return found;
    }
    return null;
  }, [repositories, selectedWorktreeId]);

  function findWorktreeName(worktreeId: string): string {
    for (const repo of repositories) {
      const worktree = repo.worktrees.find((candidate) => candidate.id === worktreeId);
      if (worktree) {
        return worktree.branch;
      }
    }
    return worktreeId;
  }

  function findPrimaryWorktreeId(repository: Repository): string | null {
    const primary = findRootWorktree(repository);
    return primary?.id ?? null;
  }

  function resolveFallbackWorktreeId(repository: Repository): string | null {
    const primaryWorktreeId = findPrimaryWorktreeId(repository);
    if (primaryWorktreeId) {
      return primaryWorktreeId;
    }

    return repository.worktrees[0]?.id ?? null;
  }

  function applyRequestedSelection(requestedRepoId: string | null, requestedWorktreeId: string | null): boolean {
    if (requestedWorktreeId) {
      for (const repo of repositories) {
        if (repo.worktrees.some((worktree) => worktree.id === requestedWorktreeId)) {
          if (selectedRepositoryId !== repo.id) {
            setSelectedRepositoryId(repo.id);
          }
          if (selectedWorktreeId !== requestedWorktreeId) {
            setSelectedWorktreeId(requestedWorktreeId);
          }
          return true;
        }
      }
    }

    if (requestedRepoId) {
      const repo = repositories.find((candidate) => candidate.id === requestedRepoId);
      if (!repo) {
        return false;
      }

      const fallbackWorktreeId = resolveFallbackWorktreeId(repo);
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
      selectedRepositoryId == null || repositories.some((repository) => repository.id === selectedRepositoryId);
    const selectedWorktreeStillExists =
      selectedWorktreeId == null || repositories.some((repository) => repository.worktrees.some((worktree) => worktree.id === selectedWorktreeId));
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

    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstRepo = repositories[0];
      if (firstRepo) {
        const fallbackWorktreeId = resolveFallbackWorktreeId(firstRepo);
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

  async function removeWorktree(worktreeId: string) {
    onError(null);
    const worktreeName = findWorktreeName(worktreeId);
    try {
      await deleteWorktreeMutation.mutateAsync(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
      }
    } catch (e) {
      if (e instanceof TeardownFailedError) {
        options?.onScriptUpdate?.({ worktreeId, worktreeName, type: "teardown", status: "completed", result: { success: false, output: e.output } });
        options?.onTeardownError?.({ worktreeId, worktreeName, output: e.output });
      } else {
        onError(e instanceof Error ? e.message : "Failed to delete worktree");
      }
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
      old?.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((wt) =>
          wt.id === worktreeId ? { ...wt, branch: newBranch } : wt,
        ),
      })),
    );
  }, [queryClient]);

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
    updateWorktreeBranch,
  };
}
