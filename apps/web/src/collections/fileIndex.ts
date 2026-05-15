import { createCollection } from "@tanstack/db";
import type { FileEntry } from "@codesymphony/shared-types";
import type { QueryClient } from "@tanstack/react-query";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { api } from "../lib/api";
import { queryKeys } from "../lib/queryKeys";

function compareFileEntries(left: FileEntry, right: FileEntry) {
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" });
}

export function toPlainFileEntry(entry: FileEntry): FileEntry {
  return {
    path: entry.path,
    type: entry.type,
  };
}

function createFileIndexCollection(queryClient: QueryClient, worktreeId: string) {
  return createCollection(
    queryCollectionOptions<FileEntry>({
      id: `file-index:${worktreeId}`,
      queryKey: queryKeys.worktrees.fileIndex(worktreeId),
      queryFn: () => api.getFileIndex(worktreeId),
      queryClient,
      getKey: (entry) => entry.path,
      compare: compareFileEntries,
      refetchInterval: 60_000,
      staleTime: 55_000,
    }),
  );
}

type FileIndexCollection = ReturnType<typeof createFileIndexCollection>;

const fileIndexCollectionRegistry = new Map<QueryClient, Map<string, FileIndexCollection>>();

function getFileIndexRegistry(queryClient: QueryClient) {
  let existing = fileIndexCollectionRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  existing = new Map<string, FileIndexCollection>();
  fileIndexCollectionRegistry.set(queryClient, existing);
  return existing;
}

export function getFileIndexCollection(queryClient: QueryClient, worktreeId: string): FileIndexCollection {
  const registry = getFileIndexRegistry(queryClient);
  const existing = registry.get(worktreeId);
  if (existing) {
    return existing;
  }

  const created = createFileIndexCollection(queryClient, worktreeId);
  registry.set(worktreeId, created);
  return created;
}

export function refetchFileIndexCollection(queryClient: QueryClient, worktreeId: string) {
  return getFileIndexCollection(queryClient, worktreeId).utils.refetch();
}

export async function resetFileIndexCollectionRegistryForTest() {
  const cleanupTasks: Promise<unknown>[] = [];
  for (const collections of fileIndexCollectionRegistry.values()) {
    for (const collection of collections.values()) {
      cleanupTasks.push(Promise.resolve(collection.cleanup()));
    }
    collections.clear();
  }
  fileIndexCollectionRegistry.clear();
  await Promise.allSettled(cleanupTasks);
}
