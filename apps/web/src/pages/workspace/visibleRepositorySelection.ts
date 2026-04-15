import type { Repository } from "@codesymphony/shared-types";
import { findRootWorktree } from "../../lib/worktree";

function repositoryContainsWorktree(repositories: Repository[], worktreeId: string | null): boolean {
  return worktreeId !== null
    && repositories.some((repository) => repository.worktrees.some((worktree) => worktree.id === worktreeId));
}

export function resolveVisibleRepositorySelection(args: {
  allRepositories?: Repository[];
  visibleRepositories: Repository[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
  desiredRepositoryId?: string | null;
  desiredWorktreeId?: string | null;
}): { repositoryId: string; worktreeId: string | null } | null {
  const {
    visibleRepositories,
    selectedRepositoryId,
    selectedWorktreeId,
    desiredRepositoryId = null,
    desiredWorktreeId = null,
  } = args;
  const allRepositories = args.allRepositories ?? visibleRepositories;

  if (visibleRepositories.length === 0) {
    return null;
  }

  const selectedRepositoryVisible = selectedRepositoryId !== null
    && visibleRepositories.some((repository) => repository.id === selectedRepositoryId);
  const selectedWorktreeVisible = repositoryContainsWorktree(visibleRepositories, selectedWorktreeId);
  const desiredRepositoryVisible = desiredRepositoryId !== null
    && visibleRepositories.some((repository) => repository.id === desiredRepositoryId);
  const desiredWorktreeVisible = repositoryContainsWorktree(visibleRepositories, desiredWorktreeId);
  const desiredRepositoryExists = desiredRepositoryId !== null
    && allRepositories.some((repository) => repository.id === desiredRepositoryId);
  const desiredWorktreeExists = repositoryContainsWorktree(allRepositories, desiredWorktreeId);

  if (
    selectedRepositoryVisible
    || selectedWorktreeVisible
    || desiredRepositoryVisible
    || desiredWorktreeVisible
    || desiredRepositoryExists
    || desiredWorktreeExists
  ) {
    return null;
  }

  const nextRepository = visibleRepositories[0];
  if (!nextRepository) {
    return null;
  }

  const nextRootWorktree = findRootWorktree(nextRepository);
  return {
    repositoryId: nextRepository.id,
    worktreeId: nextRootWorktree?.id ?? nextRepository.worktrees[0]?.id ?? null,
  };
}
