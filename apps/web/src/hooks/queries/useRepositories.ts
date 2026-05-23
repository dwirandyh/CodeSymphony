import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { Repository } from "@codesymphony/shared-types";
import { getRepositoriesCollection, toPlainRepository } from "../../collections/repositories";
import { queryKeys } from "../../lib/queryKeys";

export function useRepositories(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const enabled = options?.enabled ?? true;
  const collection = useMemo(
    () => enabled ? getRepositoriesCollection(queryClient) : null,
    [enabled, queryClient],
  );
  const { data: liveRepositories, isLoading } = useLiveQuery(() => collection ?? undefined, [collection]);
  const { data: cachedRepositories } = useQuery<Repository[]>({
    queryKey: queryKeys.repositories.all,
    queryFn: async () => [],
    enabled: false,
  });
  const recoveryRefetchTriggeredRef = useRef(false);
  const liveData = useMemo(
    () => liveRepositories?.map((repository) => toPlainRepository(repository as Repository)) ?? [],
    [liveRepositories],
  );
  const fallbackData = useMemo(
    () => cachedRepositories?.map((repository) => toPlainRepository(repository)) ?? [],
    [cachedRepositories],
  );
  const data = liveData.length > 0 ? liveData : fallbackData;
  const shouldRecoverFromFallback = liveData.length === 0 && fallbackData.length > 0;
  const collectionStillLoading = isLoading || collection?.utils.isLoading || false;
  const collectionFetching = collection?.utils.isFetching ?? false;

  useEffect(() => {
    if (!enabled || !collection) {
      recoveryRefetchTriggeredRef.current = false;
      return;
    }

    if (!shouldRecoverFromFallback) {
      recoveryRefetchTriggeredRef.current = false;
      return;
    }

    if (collectionStillLoading || recoveryRefetchTriggeredRef.current || collectionFetching) {
      return;
    }

    recoveryRefetchTriggeredRef.current = true;
    void collection.utils.refetch().catch(() => {});
  }, [collection, collectionFetching, collectionStillLoading, enabled, shouldRecoverFromFallback]);

  return {
    data,
    isLoading: collection ? data.length === 0 && (isLoading || collection.utils.isLoading) : false,
    isFetching: collection?.utils.isFetching ?? false,
    error: collection?.utils.lastError ?? null,
    isError: collection?.utils.isError ?? false,
    refetch: () => collection ? collection.utils.refetch() : Promise.resolve([]),
  };
}
