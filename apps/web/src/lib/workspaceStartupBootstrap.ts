import type {
  GitStatus,
  Repository,
  ChatThread,
  WorkspaceStartupBootstrapData,
} from "@codesymphony/shared-types";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { api } from "./api";
import { queryKeys } from "./queryKeys";
import {
  loadStartupShellSnapshot,
  resolveStartupWorkspaceSelection,
  type StartupShellSnapshot,
} from "./startupShellSnapshot";

export type WorkspaceStartupBootstrapSelection = {
  repositoryId?: string;
  worktreeId?: string;
  threadId?: string;
};

const STARTUP_BOOTSTRAP_QUERY_WAIT_MS = 1_000;

let startupBootstrapPromise: Promise<WorkspaceStartupBootstrapData | null> | null = null;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeOptionalId(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function resolveBootstrapWorktreeId(data: WorkspaceStartupBootstrapData) {
  return data.worktree?.id ?? data.thread?.worktreeId ?? data.selection.worktreeId ?? null;
}

function compareRepositories(left: Repository, right: Repository) {
  return right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt);
}

function mergeBootstrapRepositories(
  current: Repository[] | undefined,
  repositories: Repository[],
): Repository[] {
  const next = [...(current ?? [])];

  for (const repository of repositories) {
    const existingIndex = next.findIndex((entry) => entry.id === repository.id);

    if (existingIndex === -1) {
      next.push(repository);
      continue;
    }

    next[existingIndex] = repository;
  }

  return [...next].sort(compareRepositories);
}

function mergeBootstrapThreads(threads: ChatThread[], selectedThread: ChatThread | null): ChatThread[] {
  if (!selectedThread || threads.some((thread) => thread.id === selectedThread.id)) {
    return threads;
  }

  return [...threads, selectedThread].sort((left: ChatThread, right: ChatThread) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

export function resolveWorkspaceStartupBootstrapSelection(params?: {
  search?: string;
  snapshot?: StartupShellSnapshot | null;
}): WorkspaceStartupBootstrapSelection {
  const snapshot = params?.snapshot ?? (
    typeof window === "undefined"
      ? null
      : loadStartupShellSnapshot()
  );
  const search = params?.search ?? (
    typeof window === "undefined"
      ? ""
      : window.location.search
  );
  const query = new URLSearchParams(search);
  const selection = resolveStartupWorkspaceSelection({
    repoId: normalizeOptionalId(query.get("repoId")),
    worktreeId: normalizeOptionalId(query.get("worktreeId")),
    threadId: normalizeOptionalId(query.get("threadId")),
    snapshot,
  });

  return {
    repositoryId: selection.repoId,
    worktreeId: selection.worktreeId,
    threadId: selection.threadId,
  };
}

export function hasWorkspaceStartupBootstrapSelection(selection: WorkspaceStartupBootstrapSelection) {
  return !!(selection.repositoryId || selection.worktreeId || selection.threadId);
}

export async function waitForWorkspaceStartupBootstrap() {
  if (!startupBootstrapPromise) {
    return null;
  }

  return await Promise.race([
    startupBootstrapPromise.catch(() => null),
    wait(STARTUP_BOOTSTRAP_QUERY_WAIT_MS).then(() => null),
  ]);
}

export function readWorkspaceStartupBootstrapQueryData<TQueryData>(
  queryClient: Pick<QueryClient, "getQueryData">,
  queryKey: QueryKey,
) {
  return queryClient.getQueryData<TQueryData>(queryKey);
}

export function applyWorkspaceStartupBootstrap(
  queryClient: QueryClient,
  data: WorkspaceStartupBootstrapData,
) {
  const bootstrapRepositories = data.repositories
    ?? (data.repository ? [data.repository] : []);

  if (bootstrapRepositories.length > 0) {
    queryClient.setQueryData<Repository[] | undefined>(queryKeys.repositories.all, (current) => {
      return mergeBootstrapRepositories(current, bootstrapRepositories);
    });

    // When the repositories live collection already mounted during a delayed desktop startup,
    // seed it from the bootstrap payload and trigger a live refetch so it recovers from
    // any initial runtime-connection failure.
    void import("../collections/repositories")
      .then(({ getExistingRepositoriesCollection, refetchRepositoriesCollection }) => {
        const collection = getExistingRepositoriesCollection(queryClient);
        if (!collection) {
          return;
        }

        for (const repository of bootstrapRepositories) {
          collection.utils.writeUpsert(repository);
        }

        if (collection.utils.isLoading || collection.utils.isError || collection.toArray.length === 0) {
          void refetchRepositoriesCollection(queryClient);
        }
      })
      .catch(() => {});
  }

  const worktreeId = resolveBootstrapWorktreeId(data);
  if (!worktreeId) {
    return;
  }

  const mergedThreads = mergeBootstrapThreads(data.threads, data.thread);
  queryClient.setQueryData<ChatThread[]>(queryKeys.threads.list(worktreeId), mergedThreads);

  void import("../collections/threads")
    .then(({ getExistingThreadsCollection, replaceThreadsCollection }) => {
      if (!getExistingThreadsCollection(queryClient, worktreeId)) {
        return;
      }

      replaceThreadsCollection(queryClient, worktreeId, mergedThreads);
    })
    .catch(() => {});

  if (data.gitStatus) {
    queryClient.setQueryData<Array<GitStatus & { worktreeId: string }>>(
      queryKeys.worktrees.gitStatus(worktreeId),
      [{
        worktreeId,
        ...data.gitStatus,
      }],
    );
  }
}

export async function startWorkspaceStartupBootstrap(
  queryClient: QueryClient,
  options?: {
    selection?: WorkspaceStartupBootstrapSelection;
  },
) {
  const selection = options?.selection ?? resolveWorkspaceStartupBootstrapSelection();
  if (!hasWorkspaceStartupBootstrapSelection(selection)) {
    return null;
  }

  if (!startupBootstrapPromise) {
    startupBootstrapPromise = api.getWorkspaceBootstrap(selection)
      .then((data) => {
        applyWorkspaceStartupBootstrap(queryClient, data);
        return data;
      })
      .finally(() => {
        startupBootstrapPromise = null;
      });
  }

  return await startupBootstrapPromise;
}

export function resetWorkspaceStartupBootstrapForTest() {
  startupBootstrapPromise = null;
}
