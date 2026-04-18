import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import type { Repository } from "@codesymphony/shared-types";
import { getRepositoriesCollection, toPlainRepository } from "../../collections/repositories";

export function useRepositories() {
  const queryClient = useQueryClient();
  const collection = useMemo(() => getRepositoriesCollection(queryClient), [queryClient]);
  const { data: liveRepositories, isLoading } = useLiveQuery(() => collection, [collection]);
  const data = useMemo(
    () => liveRepositories?.map((repository) => toPlainRepository(repository as Repository)) ?? [],
    [liveRepositories],
  );

  return {
    data,
    isLoading: isLoading || collection.utils.isLoading,
    isFetching: collection.utils.isFetching,
    error: collection.utils.lastError ?? null,
    isError: collection.utils.isError,
    refetch: () => collection.utils.refetch(),
  };
}
