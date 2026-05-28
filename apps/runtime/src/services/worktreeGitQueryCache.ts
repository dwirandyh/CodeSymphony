import { getGitBranchDiffSummary, getGitStatus } from "./git.js";

const GIT_STATUS_CACHE_TTL_MS = 2_000;
const GIT_BRANCH_DIFF_CACHE_TTL_MS = 30_000;

type GitStatusResult = Awaited<ReturnType<typeof getGitStatus>>;
type GitBranchDiffSummaryResult = Awaited<ReturnType<typeof getGitBranchDiffSummary>>;

const cachedGitStatusByWorktreeId = new Map<string, { expiresAt: number; value: GitStatusResult }>();
const inFlightGitStatusByWorktreeId = new Map<string, Promise<GitStatusResult>>();
const cachedBranchDiffByWorktreeKey = new Map<string, { expiresAt: number; value: GitBranchDiffSummaryResult }>();
const inFlightBranchDiffByWorktreeKey = new Map<string, Promise<GitBranchDiffSummaryResult>>();

export function invalidateCachedWorktreeGitData(worktreeId: string) {
  cachedGitStatusByWorktreeId.delete(worktreeId);
  inFlightGitStatusByWorktreeId.delete(worktreeId);

  for (const key of cachedBranchDiffByWorktreeKey.keys()) {
    if (key.startsWith(`${worktreeId}:`)) {
      cachedBranchDiffByWorktreeKey.delete(key);
    }
  }

  for (const key of inFlightBranchDiffByWorktreeKey.keys()) {
    if (key.startsWith(`${worktreeId}:`)) {
      inFlightBranchDiffByWorktreeKey.delete(key);
    }
  }
}

export async function getCachedWorktreeGitStatus(
  worktreeId: string,
  worktreePath: string,
  options?: { refresh?: boolean },
): Promise<GitStatusResult> {
  const now = Date.now();
  const cached = cachedGitStatusByWorktreeId.get(worktreeId);
  if (options?.refresh !== true && cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = inFlightGitStatusByWorktreeId.get(worktreeId);
  if (options?.refresh !== true && inFlight) {
    return inFlight;
  }

  const requestPromise = getGitStatus(worktreePath)
    .then((status) => {
      cachedGitStatusByWorktreeId.set(worktreeId, {
        value: status,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
      return status;
    })
    .finally(() => {
      inFlightGitStatusByWorktreeId.delete(worktreeId);
    });

  inFlightGitStatusByWorktreeId.set(worktreeId, requestPromise);
  return requestPromise;
}

export async function getCachedWorktreeGitBranchDiffSummary(
  worktreeId: string,
  worktreePath: string,
  baseBranch: string,
): Promise<GitBranchDiffSummaryResult> {
  const cacheKey = `${worktreeId}:${baseBranch}`;
  const now = Date.now();
  const cached = cachedBranchDiffByWorktreeKey.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = inFlightBranchDiffByWorktreeKey.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = getGitBranchDiffSummary(worktreePath, baseBranch)
    .then((summary) => {
      cachedBranchDiffByWorktreeKey.set(cacheKey, {
        value: summary,
        expiresAt: Date.now() + GIT_BRANCH_DIFF_CACHE_TTL_MS,
      });
      return summary;
    })
    .finally(() => {
      inFlightBranchDiffByWorktreeKey.delete(cacheKey);
    });

  inFlightBranchDiffByWorktreeKey.set(cacheKey, requestPromise);
  return requestPromise;
}
