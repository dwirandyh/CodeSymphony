import { queryOptions, replaceEqualDeep, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RepositoryReviewState } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { mergeRepositoryReviewSnapshots } from "../../lib/repositoryReviewSnapshot";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";
import { debugLog } from "../../lib/debugLog";

function reviewBranchCount(state: RepositoryReviewState | undefined): number {
  return state ? Object.keys(state.reviewsByBranch).length : 0;
}

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
    // The REST query path (initial load + refetch) bypasses the live-socket
    // merge in `applySnapshot`. Without this, a fetch that comes back
    // unavailable (transient gh/glab failure) would overwrite previously known
    // reviews and make PR/MR badges vanish. Preserve cached reviews the same
    // way the live snapshot path does.
    structuralSharing: (prev, next) => {
      const prevState = prev as RepositoryReviewState | undefined;
      const nextState = next as RepositoryReviewState;
      const merged = mergeRepositoryReviewSnapshots(prevState, nextState);
      const prevCount = reviewBranchCount(prevState);
      const mergedCount = reviewBranchCount(merged);
      if (prevCount !== mergedCount || prevState?.available !== merged.available) {
        debugLog("workspace.reviews", "query.result", {
          repositoryId,
          incomingAvailable: nextState.available,
          incomingCount: reviewBranchCount(nextState),
          prevCount,
          mergedCount,
          preserved: !nextState.available && reviewBranchCount(nextState) === 0 && prevCount > 0,
        });
      }
      return replaceEqualDeep(prev, merged);
    },
  });
}

export function useRepositoryReviews(repositoryId: string | null, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && !!repositoryId;
  const query = useQuery({
    ...repositoryReviewsQueryOptions(repositoryId ?? ""),
    enabled,
  });
  const liveState = useWorkspaceLiveResource<RepositoryReviewState>({
    queryClient,
    key: repositoryId ? repositoryReviewsLiveResourceKey(repositoryId) : "repository_reviews:__disabled__",
    enabled,
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
        const current = queryClient.getQueryData<RepositoryReviewState>(
          queryKeys.repositories.reviews(repositoryId),
        );
        const merged = mergeRepositoryReviewSnapshots(current, snapshot);
        const prevCount = reviewBranchCount(current);
        const mergedCount = reviewBranchCount(merged);
        if (prevCount !== mergedCount || current?.available !== merged.available) {
          debugLog("workspace.reviews", "live.snapshot", {
            repositoryId,
            incomingAvailable: snapshot.available,
            incomingCount: reviewBranchCount(snapshot),
            prevCount,
            mergedCount,
            preserved: !snapshot.available && reviewBranchCount(snapshot) === 0 && prevCount > 0,
          });
        }
        queryClient.setQueryData(
          queryKeys.repositories.reviews(repositoryId),
          merged,
        );
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
