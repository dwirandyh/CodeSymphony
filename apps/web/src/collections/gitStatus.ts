import { createCollection } from "@tanstack/db";
import type { GitStatus } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

const GIT_STATUS_REFETCH_MS = 30_000;

export type GitStatusRow = GitStatus & {
  worktreeId: string;
};

export function toPlainGitStatus(row: GitStatusRow): GitStatus {
  return {
    branch: row.branch,
    upstream: row.upstream ?? null,
    ahead: row.ahead,
    behind: row.behind,
    entries: row.entries.map((entry) => ({
      path: entry.path,
      status: entry.status,
      insertions: entry.insertions,
      deletions: entry.deletions,
    })),
  };
}

function createGitStatusCollection(queryClient: QueryClient, worktreeId: string) {
  return createCollection(
    queryCollectionOptions<GitStatusRow>({
      id: `git-status:${worktreeId}`,
      queryKey: queryKeys.worktrees.gitStatus(worktreeId),
      queryFn: async () => [{ worktreeId, ...(await api.getGitStatus(worktreeId)) }],
      queryClient,
      getKey: (row) => row.worktreeId,
      refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : GIT_STATUS_REFETCH_MS,
      staleTime: GIT_STATUS_REFETCH_MS - 1_000,
      retry: false,
    }),
  );
}

type GitStatusCollection = ReturnType<typeof createGitStatusCollection>;

const gitStatusCollectionRegistry = new Map<QueryClient, Map<string, GitStatusCollection>>();

function getGitStatusRegistry(queryClient: QueryClient) {
  let existing = gitStatusCollectionRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  existing = new Map<string, GitStatusCollection>();
  gitStatusCollectionRegistry.set(queryClient, existing);
  return existing;
}

export function getGitStatusCollection(queryClient: QueryClient, worktreeId: string): GitStatusCollection {
  const registry = getGitStatusRegistry(queryClient);
  const existing = registry.get(worktreeId);
  if (existing) {
    return existing;
  }

  const created = createGitStatusCollection(queryClient, worktreeId);
  registry.set(worktreeId, created);
  return created;
}

export function getCachedGitStatus(queryClient: QueryClient, worktreeId: string): GitStatus | undefined {
  const collection = getGitStatusRegistry(queryClient).get(worktreeId);
  const cachedRow = (collection?.toArray as GitStatusRow[] | undefined)?.[0];
  if (cachedRow) {
    return toPlainGitStatus(cachedRow);
  }

  const queryRows = queryClient.getQueryData<GitStatusRow[]>(queryKeys.worktrees.gitStatus(worktreeId));
  const firstRow = queryRows?.[0];
  return firstRow ? toPlainGitStatus(firstRow) : undefined;
}

export function refetchGitStatusCollection(queryClient: QueryClient, worktreeId: string) {
  return getGitStatusCollection(queryClient, worktreeId).utils.refetch();
}

export function resetGitStatusCollectionRegistryForTest() {
  for (const collections of gitStatusCollectionRegistry.values()) {
    for (const collection of collections.values()) {
      void collection.cleanup();
    }
    collections.clear();
  }
  gitStatusCollectionRegistry.clear();
}
