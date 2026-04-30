import { useEffect } from "react";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { debugLog } from "../../../lib/debugLog";
import { queryKeys } from "../../../lib/queryKeys";
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

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 1000;

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

function revalidateWorkspaceState(queryClient: ReturnType<typeof useQueryClient>) {
  void refetchRepositoriesCollection(queryClient);
  void refetchAllThreadsCollections(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["threads"] });
  void queryClient.invalidateQueries({ queryKey: ["worktrees"] });
}

function handleWorkspaceEvent(queryClient: ReturnType<typeof useQueryClient>, event: WorkspaceSyncEvent) {
  debugLog("thread.workspace.event", event.type, event);

  if (event.repositoryId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(event.repositoryId) });
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
      event.type === "worktree.updated"
      || event.type === "worktree.deletion_started"
      || event.type === "worktree.deletion_failed"
    )
  ) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileIndex(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileTreeScope(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: ["worktrees", event.worktreeId, "slashCommands"] });
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
    let disposed = false;
    let stream: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const closeStream = () => {
      if (!stream) {
        return;
      }

      stream.onopen = null;
      stream.onmessage = null;
      stream.onerror = null;
      stream.close();
      stream = null;
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) {
        return;
      }

      const attempt = reconnectAttempts + 1;
      reconnectAttempts = attempt;

      if (attempt > MAX_RECONNECT_ATTEMPTS) {
        logWorkspaceSync("stream.reconnect.exhausted", {
          attempt,
        });
        return;
      }

      const delayMs = BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(attempt - 1, 5));
      logWorkspaceSync("stream.reconnect.scheduled", {
        attempt,
        delayMs,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startStream();
      }, delayMs);
    };

    const startStream = () => {
      if (disposed) {
        return;
      }

      closeStream();
      clearReconnectTimer();

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/workspace/events/stream`);
      const nextStream = new EventSource(streamUrl.toString());
      stream = nextStream;
      logWorkspaceSync("stream.connecting", {
        reconnectAttempts,
        url: streamUrl.toString(),
      });

      nextStream.onopen = () => {
        reconnectAttempts = 0;
        logWorkspaceSync("stream.open", {});
        revalidateWorkspaceState(queryClient);
      };

      nextStream.onmessage = (rawEvent) => {
        try {
          const payload = JSON.parse(rawEvent.data) as WorkspaceSyncEvent;
          handleWorkspaceEvent(queryClient, payload);
        } catch {
          // Ignore malformed workspace sync events.
        }
      };

      nextStream.onerror = () => {
        if (disposed) {
          return;
        }

        logWorkspaceSync("stream.error", {
          readyState: nextStream.readyState,
        });
        closeStream();
        scheduleReconnect();
      };
    };

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
      revalidateWorkspaceState(queryClient);
    };

    const handleFocus = () => {
      logWorkspaceSync("foreground.revalidate.focus", {});
      revalidateWorkspaceState(queryClient);
    };

    startStream();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus);
    }

    return () => {
      disposed = true;
      clearReconnectTimer();
      closeStream();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus);
      }
    };
  }, [queryClient]);
}
