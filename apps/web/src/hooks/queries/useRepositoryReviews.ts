import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";

function repositoryReviewsLiveResourceKey(repositoryId: string) {
  return `repository_reviews:${repositoryId}`;
}

export function repositoryReviewsQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: queryKeys.repositories.reviews(repositoryId),
    queryFn: () => api.getRepositoryReviews(repositoryId),
    enabled: repositoryId.length > 0,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useRepositoryReviews(repositoryId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...repositoryReviewsQueryOptions(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
  const liveState = useWorkspaceLiveResource({
    queryClient,
    key: repositoryId ? repositoryReviewsLiveResourceKey(repositoryId) : "repository_reviews:__disabled__",
    enabled: !!repositoryId,
    options: {
      transport: {
        kind: "workspace_socket",
        resource: "repository_reviews",
        scopeId: repositoryId ?? "",
      },
      applySnapshot: (snapshot) => {
        if (!repositoryId) {
          return;
        }
        queryClient.setQueryData(queryKeys.repositories.reviews(repositoryId), snapshot);
      },
      fallbackRefetch: () => query.refetch(),
    },
  });

  return {
    ...query,
    connectionState: liveState.connectionState,
    error: query.error ?? (liveState.errorMessage ? new Error(liveState.errorMessage) : null),
    refetch: async () => {
      if (repositoryId) {
        requestWorkspaceLiveResourceRefresh(queryClient, repositoryReviewsLiveResourceKey(repositoryId));
      }
      return query.refetch();
    },
  };
}

export function requestRepositoryReviewsLiveRefresh(queryClient: QueryClient, repositoryId: string) {
  requestWorkspaceLiveResourceRefresh(queryClient, repositoryReviewsLiveResourceKey(repositoryId));
}
