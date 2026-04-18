import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { GitStatus } from "@codesymphony/shared-types";
import { getGitStatusCollection, toPlainGitStatus, type GitStatusRow } from "../../collections/gitStatus";

export function useGitStatus(worktreeId: string | null) {
  const queryClient = useQueryClient();
  const collection = useMemo(
    () => worktreeId ? getGitStatusCollection(queryClient, worktreeId) : null,
    [queryClient, worktreeId],
  );
  const { data: liveRows, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const data = useMemo<GitStatus | undefined>(
    () => {
      const firstRow = liveRows?.[0] as GitStatusRow | undefined;
      return firstRow ? toPlainGitStatus(firstRow) : undefined;
    },
    [liveRows],
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
