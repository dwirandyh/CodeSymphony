import { useEffect } from "react";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { debugLog } from "../../../lib/debugLog";
import { queryKeys } from "../../../lib/queryKeys";
import { isOptimisticThreadId } from "../../../lib/threadIds";
import { measureStartupMetricSinceBoot } from "../../../lib/startupPerf";
import { startWorkspaceStartupBootstrap } from "../../../lib/workspaceStartupBootstrap";
import { subscribeToWorkspaceSyncSocket } from "../../../lib/workspaceLiveSocket";
import { refetchRepositoriesCollection } from "../../../collections/repositories";
import {
  disposeThreadCollections,
  getThreadCollectionCounts,
} from "../../../collections/threadCollections";
import {
  refetchAllThreadsCollections,
  refetchThreadsCollection,
  removeThreadFromCollection,
} from "../../../collections/threads";
import { clearThreadStreamState } from "../../../collections/threadStreamState";
function isDocumentForegrounded() {
  if (typeof document === "undefined") {
    return true;
  }

  if (document.visibilityState === "visible") {
    return true;
  }

  return typeof document.hasFocus === "function" && document.hasFocus();
}

function logWorkspaceSync(message: string, data?: unknown) {
  debugLog("thread.workspace.stream", message, data);
}

function shouldRefreshKnownThreadCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  threadId: string,
) {
  if (isOptimisticThreadId(threadId)) {
    return false;
  }

  return getThreadCollectionCounts(threadId) != null
    || queryClient.getQueryData(queryKeys.threads.timelineSnapshot(threadId)) !== undefined
    || queryClient.getQueryData(queryKeys.threads.statusSnapshot(threadId)) !== undefined;
}

async function refreshKnownThreadCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  threadId: string,
) {
  if (!shouldRefreshKnownThreadCaches(queryClient, threadId)) {
    return;
  }

  logWorkspaceSync("thread.refresh.started", { threadId });
  const [timelineResult, statusResult] = await Promise.allSettled([
    api.getTimelineSnapshot(threadId),
    api.getThreadStatusSnapshot(threadId),
  ]);

  if (timelineResult.status === "fulfilled") {
    queryClient.setQueryData(queryKeys.threads.timelineSnapshot(threadId), timelineResult.value);
  }

  if (statusResult.status === "fulfilled") {
    queryClient.setQueryData(queryKeys.threads.statusSnapshot(threadId), statusResult.value);
  }

  logWorkspaceSync("thread.refresh.completed", {
    threadId,
    timelineRefreshed: timelineResult.status === "fulfilled",
    statusRefreshed: statusResult.status === "fulfilled",
    timelineError: timelineResult.status === "rejected"
      ? timelineResult.reason instanceof Error
        ? timelineResult.reason.message
        : String(timelineResult.reason)
      : null,
    statusError: statusResult.status === "rejected"
      ? statusResult.reason instanceof Error
        ? statusResult.reason.message
        : String(statusResult.reason)
      : null,
  });
}

async function revalidateWorkspaceState(queryClient: ReturnType<typeof useQueryClient>) {
  void startWorkspaceStartupBootstrap(queryClient).catch(() => {
    // Recovery revalidation should still continue even when startup bootstrap cannot be refreshed.
  });

  void refetchRepositoriesCollection(queryClient);
  void refetchAllThreadsCollections(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["automations"] });
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
}

function handleAutomationWorkspaceEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  event: WorkspaceSyncEvent,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.automations.lists });

  if (!event.automationId) {
    return;
  }

  if (event.type === "automation.deleted") {
    queryClient.removeQueries({ queryKey: queryKeys.automations.detail(event.automationId) });
    queryClient.removeQueries({ queryKey: queryKeys.automations.runs(event.automationId) });
    queryClient.removeQueries({ queryKey: queryKeys.automations.versions(event.automationId) });
    return;
  }

  void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(event.automationId) });

  if (event.type === "automation.updated") {
    void queryClient.invalidateQueries({ queryKey: queryKeys.automations.versions(event.automationId) });
    return;
  }

  if (event.type === "automation.run.updated") {
    return;
  }
}

function invalidateWorktreeFileQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  worktreeId: string,
) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileIndex(worktreeId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileTreeScope(worktreeId) });
  void queryClient.invalidateQueries({ queryKey: ["worktrees", worktreeId, "slashCommands"] });
}

function handleWorkspaceEvent(queryClient: ReturnType<typeof useQueryClient>, event: WorkspaceSyncEvent) {
  debugLog("thread.workspace.event", event.type, event);
  // Hot domains with dedicated live owners refresh from their own streams.
  // This coarse sync hook only maintains metadata and non-live derived queries.

  if (
    event.type === "automation.created"
    || event.type === "automation.updated"
    || event.type === "automation.deleted"
    || event.type === "automation.run.updated"
  ) {
    handleAutomationWorkspaceEvent(queryClient, event);
  }

  if (event.type === "repository.created" || event.type === "repository.updated" || event.type === "repository.deleted") {
    void refetchRepositoriesCollection(queryClient);
  }

  if (
    event.type === "worktree.created"
    || event.type === "worktree.updated"
    || event.type === "worktree.deletion_started"
    || event.type === "worktree.deletion_failed"
    || event.type === "worktree.deleted"
  ) {
    void refetchRepositoriesCollection(queryClient);
  }

  if (event.worktreeId && (event.type === "thread.created" || event.type === "thread.updated")) {
    void refetchThreadsCollection(queryClient, event.worktreeId);
  }

  if (
    event.worktreeId
    && (
      event.type === "worktree.git.updated"
      || event.type === "worktree.files.updated"
    )
  ) {
    if (event.type === "worktree.git.updated") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitDiffScope(event.worktreeId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitBranchDiffSummary(event.worktreeId, "__all__"), exact: false });
    }
  }

  if (
    event.worktreeId
    && (
      event.type === "worktree.updated"
      || event.type === "worktree.files.updated"
      || event.type === "worktree.deletion_started"
      || event.type === "worktree.deletion_failed"
    )
  ) {
    invalidateWorktreeFileQueries(queryClient, event.worktreeId);
  }

  if (
    event.worktreeId
    && (
      event.type === "worktree.updated"
      || event.type === "worktree.deletion_started"
      || event.type === "worktree.deletion_failed"
    )
  ) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitDiffScope(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitBranchDiffSummary(event.worktreeId, "__all__"), exact: false });
  }

  if (!event.threadId) {
    return;
  }

  if (event.type === "thread.deleted") {
    if (event.worktreeId) {
      removeThreadFromCollection(queryClient, event.worktreeId, event.threadId);
    }
    queryClient.removeQueries({ queryKey: queryKeys.threads.timelineSnapshot(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.statusSnapshot(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.messages(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.events(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.queue(event.threadId) });
    disposeThreadCollections(event.threadId);
    clearThreadStreamState(event.threadId);
    return;
  }

  void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(event.threadId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(event.threadId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.threads.queue(event.threadId) });

  if (event.type === "thread.updated") {
    void refreshKnownThreadCaches(queryClient, event.threadId);
  }
}

export function useWorkspaceSyncStream() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = subscribeToWorkspaceSyncSocket({
      onOpen() {
        measureStartupMetricSinceBoot("startup.live_connected_ms", {
          source: "workspace-sync-socket",
        });
        logWorkspaceSync("stream.open", {});
        void revalidateWorkspaceState(queryClient);
      },
      onEvent(payload) {
        handleWorkspaceEvent(queryClient, payload);
      },
    });

    const handleVisibilityChange = () => {
      if (!isDocumentForegrounded()) {
        return;
      }

      logWorkspaceSync("foreground.revalidate.visibility", {
        visibilityState: typeof document === "undefined" ? null : document.visibilityState,
        hasFocus: typeof document === "undefined" || typeof document.hasFocus !== "function"
          ? null
          : document.hasFocus(),
      });
      void revalidateWorkspaceState(queryClient);
    };

    const handleFocus = () => {
      logWorkspaceSync("foreground.revalidate.focus", {});
      void revalidateWorkspaceState(queryClient);
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      unsubscribe();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus);
      }
    };
  }, [queryClient]);
}
