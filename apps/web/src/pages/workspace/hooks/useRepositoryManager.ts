import { useEffect, useMemo, useState } from "react";
import type { Repository } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { useRepositories } from "../../../hooks/queries/useRepositories";
import { useCreateRepository } from "../../../hooks/mutations/useCreateRepository";
import { useCreateWorktree } from "../../../hooks/mutations/useCreateWorktree";
import { useDeleteWorktree } from "../../../hooks/mutations/useDeleteWorktree";
import { useRenameWorktreeBranch } from "../../../hooks/mutations/useRenameWorktreeBranch";
import { findRepositoryByWorktree } from "../eventUtils";

export function useRepositoryManager(onError: (msg: string | null) => void) {
  const queryClient = useQueryClient();
  const { data: repositories = [], isLoading: loadingRepos } = useRepositories();

  const createRepoMutation = useCreateRepository();
  const createWorktreeMutation = useCreateWorktree();
  const deleteWorktreeMutation = useDeleteWorktree();
  const renameBranchMutation = useRenameWorktreeBranch();

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);

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

  // Auto-select first repo/worktree when data arrives
  useEffect(() => {
    if (repositories.length === 0) return;
    if (!selectedRepositoryId && repositories[0]) {
      setSelectedRepositoryId(repositories[0].id);
    }
    if (!selectedWorktreeId) {
      const firstWorktree = repositories[0]?.worktrees[0];
      if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
    }
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

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

  function updateWorktreeBranch(worktreeId: string, newBranch: string) {
    queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, (old) =>
      old?.map((repo) => ({
        ...repo,
        worktrees: repo.worktrees.map((wt) =>
          wt.id === worktreeId ? { ...wt, branch: newBranch } : wt,
        ),
      })),
    );
  }

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
