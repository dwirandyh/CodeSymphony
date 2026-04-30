import type { Repository, Worktree } from "@codesymphony/shared-types";
import { findRootWorktree, isOperationalWorktreeStatus } from "../lib/worktree";

export type WorktreeWithRepository = Worktree & {
  repository: Repository;
};

export type RepositoryWorktreeIndex = {
  activeWorktreeIds: string[];
  repositoryById: Map<string, Repository>;
  repositoryIdByWorktreeId: Map<string, string>;
  worktreeById: Map<string, WorktreeWithRepository>;
};

export function buildRepositoryWorktreeIndex(repositories: Repository[]): RepositoryWorktreeIndex {
  const repositoryById = new Map<string, Repository>();
  const repositoryIdByWorktreeId = new Map<string, string>();
  const worktreeById = new Map<string, WorktreeWithRepository>();
  const activeWorktreeIds: string[] = [];

  for (const repository of repositories) {
    repositoryById.set(repository.id, repository);

    for (const worktree of repository.worktrees) {
      repositoryIdByWorktreeId.set(worktree.id, repository.id);
      worktreeById.set(worktree.id, {
        ...worktree,
        repository,
      });

      if (isOperationalWorktreeStatus(worktree.status)) {
        activeWorktreeIds.push(worktree.id);
      }
    }
  }

  return {
    activeWorktreeIds,
    repositoryById,
    repositoryIdByWorktreeId,
    worktreeById,
  };
}

export function findPrimaryWorktreeId(repository: Repository): string | null {
  return findRootWorktree(repository)?.id ?? null;
}

export function resolveFallbackWorktreeId(repository: Repository): string | null {
  return findPrimaryWorktreeId(repository) ?? repository.worktrees[0]?.id ?? null;
}
