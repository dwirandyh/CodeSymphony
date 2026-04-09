import { useEffect } from "react";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";

function handleWorkspaceEvent(queryClient: ReturnType<typeof useQueryClient>, event: WorkspaceSyncEvent) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });

  if (event.repositoryId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(event.repositoryId) });
  }

  if (event.worktreeId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileIndex(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.slashCommands(event.worktreeId) });
  }

  if (!event.threadId) {
    return;
  }

  if (event.type === "thread.deleted") {
    queryClient.removeQueries({ queryKey: queryKeys.threads.timelineSnapshot(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.statusSnapshot(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.messages(event.threadId) });
    queryClient.removeQueries({ queryKey: queryKeys.threads.events(event.threadId) });
    return;
  }

  void queryClient.invalidateQueries({ queryKey: queryKeys.threads.timelineSnapshot(event.threadId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.threads.statusSnapshot(event.threadId) });
}

export function useWorkspaceSyncStream() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const streamUrl = new URL(`${api.runtimeBaseUrl}/api/workspace/events/stream`);
    const stream = new EventSource(streamUrl.toString());

    stream.onmessage = (rawEvent) => {
      try {
        const payload = JSON.parse(rawEvent.data) as WorkspaceSyncEvent;
        handleWorkspaceEvent(queryClient, payload);
      } catch {
        // Ignore malformed workspace sync events.
      }
    };

    return () => {
      stream.close();
    };
  }, [queryClient]);
}
