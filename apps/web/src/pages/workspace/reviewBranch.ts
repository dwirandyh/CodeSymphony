export function resolveReviewBranch(
  gitStatusBranch: string | null | undefined,
  worktreeBranch: string | null | undefined,
): string | null {
  const resolvedGitStatusBranch = gitStatusBranch?.trim();
  if (resolvedGitStatusBranch) {
    return resolvedGitStatusBranch;
  }

  const resolvedWorktreeBranch = worktreeBranch?.trim();
  return resolvedWorktreeBranch || null;
}

export function resolveReviewBaseBranch(
  worktreeBaseBranch: string | null | undefined,
  repositoryDefaultBranch: string | null | undefined,
): string | null {
  const resolvedWorktreeBaseBranch = worktreeBaseBranch?.trim();
  if (resolvedWorktreeBaseBranch) {
    return resolvedWorktreeBaseBranch;
  }

  const resolvedRepositoryDefaultBranch = repositoryDefaultBranch?.trim();
  return resolvedRepositoryDefaultBranch || null;
}

export function isBaseBranchSelected(
  branch: string | null | undefined,
  baseBranch: string | null | undefined,
): boolean {
  if (!branch || !baseBranch) {
    return false;
  }

  return branch === baseBranch;
}
