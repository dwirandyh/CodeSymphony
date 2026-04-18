import { createCollection } from "@tanstack/db";
import type { Repository, Worktree } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

function compareRepositories(left: Repository, right: Repository) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
}

function toPlainWorktree(worktree: Worktree): Worktree {
  return {
    id: worktree.id,
    repositoryId: worktree.repositoryId,
    branch: worktree.branch,
    path: worktree.path,
    baseBranch: worktree.baseBranch,
    status: worktree.status,
    branchRenamed: worktree.branchRenamed,
    createdAt: worktree.createdAt,
    updatedAt: worktree.updatedAt,
  };
}

export function toPlainRepository(repository: Repository): Repository {
  return {
    id: repository.id,
    name: repository.name,
    rootPath: repository.rootPath,
    defaultBranch: repository.defaultBranch,
    setupScript: repository.setupScript ?? null,
    teardownScript: repository.teardownScript ?? null,
    runScript: repository.runScript ?? null,
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
    worktrees: repository.worktrees.map(toPlainWorktree),
  };
}

function createRepositoriesCollection(queryClient: QueryClient) {
  return createCollection(
    queryCollectionOptions<Repository>({
      id: "repositories",
      queryKey: queryKeys.repositories.all,
      queryFn: () => api.listRepositories(),
      queryClient,
      getKey: (repository) => repository.id,
      compare: compareRepositories,
      staleTime: 10_000,
    }),
  );
}

type RepositoriesCollection = ReturnType<typeof createRepositoriesCollection>;

const repositoriesCollectionRegistry = new Map<QueryClient, RepositoriesCollection>();

export function getRepositoriesCollection(queryClient: QueryClient): RepositoriesCollection {
  const existing = repositoriesCollectionRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  const created = createRepositoriesCollection(queryClient);
  repositoriesCollectionRegistry.set(queryClient, created);
  return created;
}

export function refetchRepositoriesCollection(queryClient: QueryClient) {
  return getRepositoriesCollection(queryClient).utils.refetch();
}

export function resetRepositoriesCollectionRegistryForTest() {
  for (const collection of repositoriesCollectionRegistry.values()) {
    void collection.cleanup();
  }
  repositoriesCollectionRegistry.clear();
}
