import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";

function repositoryBranchesLiveResourceKey(repositoryId: string) {
  return `repository_branches:${repositoryId}`;
}

export function repositoryBranchesQueryOptions(repositoryId: string) {
  return queryOptions({
    queryKey: queryKeys.repositories.branches(repositoryId),
    queryFn: () => api.listBranches(repositoryId),
    enabled: repositoryId.length > 0,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useRepositoryBranches(repositoryId: string | null, options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const enabled = (options?.enabled ?? true) && !!repositoryId;
  const query = useQuery({
    ...repositoryBranchesQueryOptions(repositoryId ?? ""),
    enabled,
  });
  const liveState = useWorkspaceLiveResource<string[]>({
    queryClient,
    key: repositoryId ? repositoryBranchesLiveResourceKey(repositoryId) : "repository_branches:__disabled__",
    enabled,
    options: {
      transport: {
        kind: "workspace_socket",
        resource: "repository_branches",
        scopeId: repositoryId ?? "",
      },
      applySnapshot: (snapshot) => {
        if (!repositoryId) {
          return;
        }
        queryClient.setQueryData(queryKeys.repositories.branches(repositoryId), snapshot);
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
        requestWorkspaceLiveResourceRefresh(queryClient, repositoryBranchesLiveResourceKey(repositoryId));
      }
      return query.refetch();
    },
  };
}

export function requestRepositoryBranchesLiveRefresh(queryClient: QueryClient, repositoryId: string) {
  requestWorkspaceLiveResourceRefresh(queryClient, repositoryBranchesLiveResourceKey(repositoryId));
}
