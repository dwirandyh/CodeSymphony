import { useEffect } from "react";
import type { WorkspaceSyncEvent } from "@codesymphony/shared-types";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { queryKeys } from "../../../lib/queryKeys";
import { refetchRepositoriesCollection } from "../../../collections/repositories";
import { refetchThreadsCollection, removeThreadFromCollection } from "../../../collections/threads";
import { disposeThreadCollections } from "../../../collections/threadCollections";
import { clearThreadStreamState } from "../../../collections/threadStreamState";

function handleWorkspaceEvent(queryClient: ReturnType<typeof useQueryClient>, event: WorkspaceSyncEvent) {
  if (event.repositoryId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.repositories.reviews(event.repositoryId) });
  }

  if (event.type === "repository.created" || event.type === "repository.updated" || event.type === "repository.deleted") {
    void refetchRepositoriesCollection(queryClient);
  }

  if (event.type === "worktree.created" || event.type === "worktree.updated" || event.type === "worktree.deleted") {
    void refetchRepositoriesCollection(queryClient);
  }

  if (event.worktreeId && (event.type === "thread.created" || event.type === "thread.updated")) {
    void refetchThreadsCollection(queryClient, event.worktreeId);
  }

  if (event.worktreeId && event.type === "worktree.updated") {
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.gitStatus(event.worktreeId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees.fileIndex(event.worktreeId) });
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
    disposeThreadCollections(event.threadId);
    clearThreadStreamState(event.threadId);
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
