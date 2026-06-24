import { createCollection } from "@tanstack/db";
import type { Repository, Worktree } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";
import {
  readWorkspaceStartupBootstrapQueryData,
  waitForWorkspaceStartupBootstrap,
} from "../lib/workspaceStartupBootstrap";
import { withWorkspaceCollectionPersistence } from "../lib/workspacePersistence";

function compareRepositories(left: Repository, right: Repository) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
}

function isCollectionSyncNotInitializedError(error: unknown) {
  return error instanceof Error
    && error.message === "Collection must be in 'ready' state for manual sync operations. Sync not initialized yet.";
}

function repositoryWorktreeSetsMatch(left: Repository, right: Repository) {
  if (left.worktrees.length !== right.worktrees.length) {
    return false;
  }

  const rightWorktreeIds = new Set(right.worktrees.map((worktree) => worktree.id));
  return left.worktrees.every((worktree) => rightWorktreeIds.has(worktree.id));
}

function upsertRepositoryQueryData(queryClient: QueryClient, repository: Repository) {
  const nextRepository = toPlainRepository(repository);

  queryClient.setQueryData<Repository[] | undefined>(queryKeys.repositories.all, (current) => {
    const next = [...(current ?? [])];
    const existingIndex = next.findIndex((entry) => entry.id === nextRepository.id);

    if (existingIndex === -1) {
      next.push(nextRepository);
    } else {
      next[existingIndex] = nextRepository;
    }

    return [...next].sort(compareRepositories);
  });

  return nextRepository;
}

function writeRepositoryToCollection(collection: RepositoriesCollection, repository: Repository) {
  const nextRepository = toPlainRepository(repository);
  const hasRepository = (collection.toArray as unknown as Repository[])
    .some((entry) => entry.id === nextRepository.id);

  if (hasRepository) {
    collection.utils.writeBatch(() => {
      collection.utils.writeDelete(nextRepository.id);
    });
  }

  collection.utils.writeBatch(() => {
    collection.utils.writeInsert(nextRepository);
  });
}

function replaceRepositoryInCollection(queryClient: QueryClient, repository: Repository) {
  const nextRepository = upsertRepositoryQueryData(queryClient, repository);
  const collection = getExistingRepositoriesCollection(queryClient);
  if (!collection) {
    return nextRepository;
  }

  try {
    writeRepositoryToCollection(collection, nextRepository);
  } catch (error) {
    if (!isCollectionSyncNotInitializedError(error)) {
      throw error;
    }
  }

  return nextRepository;
}

function toPlainWorktree(worktree: Worktree): Worktree {
  return {
    id: worktree.id,
    repositoryId: worktree.repositoryId,
    branch: worktree.branch,
    path: worktree.path,
    baseBranch: worktree.baseBranch,
    isAutomation: worktree.isAutomation,
    status: worktree.status,
    lastCreateError: worktree.lastCreateError ?? null,
    lastDeleteError: worktree.lastDeleteError ?? null,
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
  let readCurrentRows = (): Repository[] => [];
  let seededFromLocalState = false;
  let needsLiveRecoveryRefetch = false;
  let liveRecoveryRefetchScheduled = false;

  function scheduleLiveRecoveryRefetch() {
    if (liveRecoveryRefetchScheduled) {
      return;
    }

    liveRecoveryRefetchScheduled = true;
    void Promise.resolve().then(() => {
      liveRecoveryRefetchScheduled = false;

      if (!needsLiveRecoveryRefetch) {
        return;
      }

      void Promise.resolve(collection.utils.refetch()).catch(() => {});
    });
  }

  const collection = createCollection(
    withWorkspaceCollectionPersistence(
      queryCollectionOptions<Repository>({
        id: "repositories",
        queryKey: queryKeys.repositories.all,
        queryFn: async () => {
          await waitForWorkspaceStartupBootstrap();

          if (!seededFromLocalState) {
            seededFromLocalState = true;

            const currentRows = readCurrentRows();
            if (currentRows.length > 0) {
              needsLiveRecoveryRefetch = true;
              scheduleLiveRecoveryRefetch();
              return currentRows;
            }

            const cachedRows = readWorkspaceStartupBootstrapQueryData<Repository[] | undefined>(
              queryClient,
              queryKeys.repositories.all,
            );
            if (cachedRows !== undefined) {
              needsLiveRecoveryRefetch = true;
              scheduleLiveRecoveryRefetch();
              return cachedRows;
            }
          }

          const liveRepositories = await api.listRepositories();
          needsLiveRecoveryRefetch = false;
          return liveRepositories;
        },
        queryClient,
        getKey: (repository) => repository.id,
        compare: compareRepositories,
        staleTime: 10_000,
      }),
      { schemaVersion: 1 },
    ),
  );

  readCurrentRows = () => ((collection.toArray as unknown as Repository[]).map((repository) => toPlainRepository(repository)));

  return Object.assign(collection, {
    hasPendingSeedRecoveryRefetch: () => needsLiveRecoveryRefetch,
  });
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

export function getExistingRepositoriesCollection(queryClient: QueryClient): RepositoriesCollection | null {
  return repositoriesCollectionRegistry.get(queryClient) ?? null;
}

export function refetchRepositoriesCollection(queryClient: QueryClient) {
  return getRepositoriesCollection(queryClient).utils.refetch();
}

export async function refreshRepositoriesCollectionFromServer(queryClient: QueryClient) {
  const liveRepositories = (await api.listRepositories()).map(toPlainRepository).sort(compareRepositories);
  queryClient.setQueryData<Repository[]>(queryKeys.repositories.all, liveRepositories);

  const collection = getExistingRepositoriesCollection(queryClient);
  if (!collection) {
    return liveRepositories;
  }

  const liveRepositoryIds = new Set(liveRepositories.map((repository) => repository.id));

  const collectionRepositories = (collection.toArray as unknown as Repository[]);

  try {
    collection.utils.writeBatch(() => {
      for (const repository of collectionRepositories) {
        if (!liveRepositoryIds.has(repository.id)) {
          collection.utils.writeDelete(repository.id);
        }
      }

      for (const repository of liveRepositories) {
        const existingRepository = collectionRepositories.find((entry) => entry.id === repository.id) ?? null;
        if (existingRepository && !repositoryWorktreeSetsMatch(existingRepository, repository)) {
          collection.utils.writeDelete(repository.id);
        }
      }

      for (const repository of liveRepositories) {
        const existingRepository = collectionRepositories.find((entry) => entry.id === repository.id) ?? null;
        if (existingRepository && !repositoryWorktreeSetsMatch(existingRepository, repository)) {
          collection.utils.writeInsert(repository);
          continue;
        }

        collection.utils.writeUpsert(repository);
      }
    });
  } catch (error) {
    if (!isCollectionSyncNotInitializedError(error)) {
      throw error;
    }
  }

  await collection.utils.refetch();

  return liveRepositories;
}

export function removeWorktreeFromCollection(queryClient: QueryClient, worktreeId: string) {
  const collection = getExistingRepositoriesCollection(queryClient);
  const collectionRepositories = collection
    ? (collection.toArray as unknown as Repository[])
    : queryClient.getQueryData<Repository[]>(queryKeys.repositories.all) ?? [];

  for (const repository of collectionRepositories) {
    if (!repository.worktrees.some((worktree) => worktree.id === worktreeId)) {
      continue;
    }

    replaceRepositoryInCollection(queryClient, {
      ...repository,
      worktrees: repository.worktrees.filter((worktree) => worktree.id !== worktreeId),
    });
  }
}

export function upsertRepositoryInCollection(queryClient: QueryClient, repository: Repository) {
  const collection = getRepositoriesCollection(queryClient);
  const nextRepository = toPlainRepository(repository);
  const existingRepository = (collection.toArray as unknown as Repository[])
    .find((entry) => entry.id === nextRepository.id) ?? null;

  upsertRepositoryQueryData(queryClient, nextRepository);

  try {
    if (existingRepository && !repositoryWorktreeSetsMatch(existingRepository, nextRepository)) {
      writeRepositoryToCollection(collection, nextRepository);
      return;
    }

    collection.utils.writeUpsert(nextRepository);
  } catch (error) {
    if (!isCollectionSyncNotInitializedError(error)) {
      throw error;
    }
  }
}

export async function resetRepositoriesCollectionRegistryForTest() {
  const cleanupTasks: Promise<unknown>[] = [];
  for (const collection of repositoriesCollectionRegistry.values()) {
    cleanupTasks.push(Promise.resolve(collection.cleanup()));
  }
  repositoriesCollectionRegistry.clear();
  await Promise.allSettled(cleanupTasks);
}
