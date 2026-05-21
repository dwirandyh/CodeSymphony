import type { Repository } from "@codesymphony/shared-types";
import { findRootWorktree, isSelectableWorktreeStatus } from "../../lib/worktree";

function repositoryContainsWorktree(repositories: Repository[], worktreeId: string | null): boolean {
  return worktreeId !== null
    && repositories.some((repository) => repository.worktrees.some((worktree) => worktree.id === worktreeId));
}

function resolveSelectableWorktreeId(repository: Repository, excludedWorktreeId?: string | null): string | null {
  const selectableWorktrees = repository.worktrees.filter((worktree) => (
    worktree.id !== excludedWorktreeId && isSelectableWorktreeStatus(worktree.status)
  ));
  const rootWorktree = findRootWorktree({
    ...repository,
    worktrees: selectableWorktrees,
  });

  return rootWorktree?.id ?? selectableWorktrees[0]?.id ?? null;
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

export function resolveUnavailableWorktreeSelection(args: {
  visibleRepositories: Repository[];
  selectedRepositoryId: string | null;
  selectedWorktreeId: string | null;
}): { repositoryId: string; worktreeId: string } | null {
  const { visibleRepositories, selectedRepositoryId, selectedWorktreeId } = args;
  if (visibleRepositories.length === 0 || selectedWorktreeId === null) {
    return null;
  }

  const selectedRepository = visibleRepositories.find((repository) => (
    repository.id === selectedRepositoryId
    || repository.worktrees.some((worktree) => worktree.id === selectedWorktreeId)
  )) ?? null;

  if (selectedRepository) {
    const replacementInSelectedRepository = resolveSelectableWorktreeId(selectedRepository, selectedWorktreeId);
    if (replacementInSelectedRepository) {
      return {
        repositoryId: selectedRepository.id,
        worktreeId: replacementInSelectedRepository,
      };
    }
  }

  for (const repository of visibleRepositories) {
    if (repository.id === selectedRepository?.id) {
      continue;
    }

    const replacementWorktreeId = resolveSelectableWorktreeId(repository);
    if (replacementWorktreeId) {
      return {
        repositoryId: repository.id,
        worktreeId: replacementWorktreeId,
      };
    }
  }

  return null;
}
