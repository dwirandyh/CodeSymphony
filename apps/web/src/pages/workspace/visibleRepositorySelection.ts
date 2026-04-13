import type { Repository } from "@codesymphony/shared-types";
import { findRootWorktree } from "../../lib/worktree";

export function resolveVisibleRepositorySelection(args: {
  visibleRepositories: Repository[];
  selectedRepositoryId: string | null;
}): { repositoryId: string; worktreeId: string | null } | null {
  const { visibleRepositories, selectedRepositoryId } = args;

  if (visibleRepositories.length === 0) {
    return null;
  }

  const selectedRepositoryVisible = selectedRepositoryId !== null
    && visibleRepositories.some((repository) => repository.id === selectedRepositoryId);
  if (selectedRepositoryVisible) {
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
