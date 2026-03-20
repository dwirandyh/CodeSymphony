import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";

export const REPOSITORY_REVIEWS_REFETCH_MS = 30_000;

export function repositoryReviewsQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: queryKeys.repositories.reviews(repositoryId),
    queryFn: () => api.getRepositoryReviews(repositoryId),
    enabled: repositoryId.length > 0,
    refetchInterval: (query) => query.state.fetchStatus === "fetching" ? false : REPOSITORY_REVIEWS_REFETCH_MS,
    staleTime: REPOSITORY_REVIEWS_REFETCH_MS - 1_000,
    retry: false,
  });
}

export function useRepositoryReviews(repositoryId: string | null) {
  return useQuery({
    ...repositoryReviewsQueryOptions(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}
