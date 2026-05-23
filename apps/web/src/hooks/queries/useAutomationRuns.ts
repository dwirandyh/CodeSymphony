import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { queryKeys } from "../../lib/queryKeys";
import { requestWorkspaceLiveResourceRefresh, useWorkspaceLiveResource } from "../../lib/workspaceLiveResource";

function automationRunsLiveResourceKey(automationId: string) {
  return `automation_runs:${automationId}`;
}

export function automationRunsQueryOptions(automationId: string) {
  return queryOptions({
    queryKey: queryKeys.automations.runs(automationId),
    queryFn: () => api.listAutomationRuns(automationId),
    enabled: automationId.length > 0,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useAutomationRuns(automationId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...automationRunsQueryOptions(automationId ?? ""),
    enabled: !!automationId,
  });
  const liveState = useWorkspaceLiveResource({
    queryClient,
    key: automationId ? automationRunsLiveResourceKey(automationId) : "automation_runs:__disabled__",
    enabled: !!automationId,
    options: {
      transport: {
        kind: "event_source",
        buildPath: (afterSeq) => `/api/live/automations/${encodeURIComponent(automationId ?? "")}/runs/stream${typeof afterSeq === "number" ? `?afterSeq=${afterSeq}` : ""}`,
      },
      applySnapshot: (snapshot) => {
        if (!automationId) {
          return;
        }
        queryClient.setQueryData(queryKeys.automations.runs(automationId), snapshot);
      },
      fallbackRefetch: () => query.refetch(),
    },
  });

  return {
    ...query,
    connectionState: liveState.connectionState,
    error: query.error ?? (liveState.errorMessage ? new Error(liveState.errorMessage) : null),
    refetch: async () => {
      if (automationId) {
        requestWorkspaceLiveResourceRefresh(queryClient, automationRunsLiveResourceKey(automationId));
      }
      return query.refetch();
    },
  };
}

export function requestAutomationRunsLiveRefresh(queryClient: QueryClient, automationId: string) {
  requestWorkspaceLiveResourceRefresh(queryClient, automationRunsLiveResourceKey(automationId));
}
