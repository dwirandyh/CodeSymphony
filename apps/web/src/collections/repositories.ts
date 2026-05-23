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

export function upsertRepositoryInCollection(queryClient: QueryClient, repository: Repository) {
  const collection = getRepositoriesCollection(queryClient);
  const nextRepository = toPlainRepository(repository);

  collection.utils.writeUpsert(nextRepository);
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
}

export async function resetRepositoriesCollectionRegistryForTest() {
  const cleanupTasks: Promise<unknown>[] = [];
  for (const collection of repositoriesCollectionRegistry.values()) {
    cleanupTasks.push(Promise.resolve(collection.cleanup()));
  }
  repositoriesCollectionRegistry.clear();
  await Promise.allSettled(cleanupTasks);
}
