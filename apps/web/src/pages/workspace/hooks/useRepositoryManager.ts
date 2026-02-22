import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Repository } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { debugLog } from "../../../lib/debugLog";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { findRepositoryByWorktree } from "../eventUtils";

interface UseRepositoryManagerOptions {
  initialRepoId?: string;
  initialWorktreeId?: string;
  onSelectionChange?: (selection: { repoId: string | null; worktreeId: string | null }) => void;
}

export function useRepositoryManager(
  onError: (msg: string | null) => void,
  options?: UseRepositoryManagerOptions,
) {
  const queryClient = useQueryClient();
  const { data: repositories = [], isLoading: loadingRepos } = useRepositories();

  const createRepoMutation = useCreateRepository();
  const createWorktreeMutation = useCreateWorktree();
  const deleteWorktreeMutation = useDeleteWorktree();
  const renameBranchMutation = useRenameWorktreeBranch();

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);

  const initialAppliedRef = useRef(false);
  const prevSelectionRef = useRef<{ repoId: string | null; worktreeId: string | null }>({
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

  // Auto-select first repo/worktree when data arrives, respecting initial URL IDs
  useEffect(() => {
    debugLog("useRepositoryManager", "auto-select effect", {
      reposLength: repositories.length,
      selectedRepositoryId,
      selectedWorktreeId,
      initialApplied: initialAppliedRef.current,
    });
    if (repositories.length === 0) return;

    if (!initialAppliedRef.current && (options?.initialWorktreeId || options?.initialRepoId)) {
      initialAppliedRef.current = true;

      // Validate initialWorktreeId against fetched data
      if (options.initialWorktreeId) {
        let foundRepo: Repository | undefined;
        for (const repo of repositories) {
          if (repo.worktrees.some((w) => w.id === options.initialWorktreeId)) {
            foundRepo = repo;
            break;
          }
        }
        if (foundRepo) {
          setSelectedRepositoryId(foundRepo.id);
          setSelectedWorktreeId(options.initialWorktreeId);
          return;
        }
      }

      // Validate initialRepoId against fetched data
      if (options.initialRepoId) {
        const repo = repositories.find((r) => r.id === options.initialRepoId);
        if (repo) {
          setSelectedRepositoryId(repo.id);
          const firstWorktree = repo.worktrees[0];
          if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
          return;
        }
      }
      // Fall through to auto-select if URL IDs were invalid
    }

    if (!initialAppliedRef.current) {
      initialAppliedRef.current = true;
    }

    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstWorktree = repositories[0]?.worktrees[0];
      if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
    }
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

  // Notify parent when selection changes
  useEffect(() => {
    const prev = prevSelectionRef.current;
    const willFire = prev.repoId !== selectedRepositoryId || prev.worktreeId !== selectedWorktreeId;
    debugLog("useRepositoryManager", "notification effect", {
      prevRepoId: prev.repoId,
      prevWorktreeId: prev.worktreeId,
      selectedRepositoryId,
      selectedWorktreeId,
      willFire,
    });
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
      const created = await createWorktreeMutation.mutateAsync({ repositoryId });
      setSelectedWorktreeId(created.id);
      setSelectedRepositoryId(repositoryId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create worktree");
    }
  }

  async function removeWorktree(worktreeId: string) {
    onError(null);
    try {
      await deleteWorktreeMutation.mutateAsync(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete worktree");
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
    renameWorktreeBranch,
    updateWorktreeBranch,
  };
}
