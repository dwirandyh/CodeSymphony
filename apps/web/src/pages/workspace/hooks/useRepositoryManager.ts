import { useEffect, useMemo, useState } from "react";
import type { Repository } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";
import { findRepositoryByWorktree } from "../eventUtils";

export function useRepositoryManager(onError: (msg: string | null) => void) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [submittingWorktree, setSubmittingWorktree] = useState(false);

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

  async function loadRepositories() {
    setLoadingRepos(true);
    onError(null);

    try {
      const data = await api.listRepositories();
      setRepositories(data);

      if (!selectedRepositoryId && data[0]) {
        setSelectedRepositoryId(data[0].id);
      }
      if (!selectedWorktreeId) {
        const firstWorktree = data[0]?.worktrees[0];
        if (firstWorktree) setSelectedWorktreeId(firstWorktree.id);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to load repositories");
    } finally {
      setLoadingRepos(false);
    }
  }

  async function attachRepository() {
    setSubmittingRepo(true);
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

      await api.createRepository({ path });
      await loadRepositories();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to add repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function submitWorktree(repositoryId: string) {
    setSubmittingWorktree(true);
    onError(null);

    try {
      const created = await api.createWorktree(repositoryId);
      await loadRepositories();
      setSelectedWorktreeId(created.id);
      setSelectedRepositoryId(repositoryId);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create worktree");
    } finally {
      setSubmittingWorktree(false);
    }
  }

  async function removeWorktree(worktreeId: string) {
    onError(null);

    try {
      await api.deleteWorktree(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
      }
      await loadRepositories();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete worktree");
    }
  }

  useEffect(() => {
    void loadRepositories();
  }, []);

  return {
    repositories,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedRepository,
    selectedWorktree,
    loadingRepos,
    submittingRepo,
    submittingWorktree,
    setSelectedRepositoryId,
    setSelectedWorktreeId,
    attachRepository,
    submitWorktree,
    removeWorktree,
  };
}
