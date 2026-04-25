import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

const REPOSITORY_BRANCHES_REFETCH_MS = 60_000;

export function repositoryBranchesQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: queryKeys.repositories.branches(repositoryId),
    queryFn: () => api.listBranches(repositoryId),
    enabled: repositoryId.length > 0,
    refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : REPOSITORY_BRANCHES_REFETCH_MS,
    staleTime: REPOSITORY_BRANCHES_REFETCH_MS - 1_000,
    retry: false,
  });
}

export function useRepositoryBranches(repositoryId: string | null) {
  return useQuery({
    ...repositoryBranchesQueryOptions(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}
