import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { FileEntry } from "@codesymphony/shared-types";
import { getFileIndexCollection, toPlainFileEntry } from "../../collections/fileIndex";

export function useFileIndexQuery(worktreeId: string | null) {
  const queryClient = useQueryClient();
  const collection = useMemo(
    () => worktreeId ? getFileIndexCollection(queryClient, worktreeId) : null,
    [queryClient, worktreeId],
  );
  const { data: liveEntries, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const data = useMemo(
    () => liveEntries?.map((entry) => toPlainFileEntry(entry as FileEntry)) ?? [],
    [liveEntries],
  );

  return {
    data,
    isLoading: collection ? isLoading || collection.utils.isLoading : false,
    isFetching: collection?.utils.isFetching ?? false,
    error: collection?.utils.lastError ?? null,
    isError: collection?.utils.isError ?? false,
    refetch: () => collection ? collection.utils.refetch() : Promise.resolve([]),
  };
}
