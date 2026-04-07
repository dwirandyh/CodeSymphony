import type { WorkspaceSyncEvent, WorkspaceSyncEventType } from "@codesymphony/shared-types";
import type { WorkspaceSyncEventHub } from "../types.js";

type Listener = (event: WorkspaceSyncEvent) => void;

export function createWorkspaceEventHub(): WorkspaceSyncEventHub {
  const listeners = new Set<Listener>();
  let nextId = 0;

  function emit(
    type: WorkspaceSyncEventType,
    payload: {
      repositoryId?: string | null;
      worktreeId?: string | null;
      threadId?: string | null;
    } = {},
  ): WorkspaceSyncEvent {
    nextId += 1;

    const event: WorkspaceSyncEvent = {
      id: `workspace-${Date.now()}-${nextId}`,
      type,
      repositoryId: payload.repositoryId ?? null,
      worktreeId: payload.worktreeId ?? null,
      threadId: payload.threadId ?? null,
      createdAt: new Date().toISOString(),
    };

    for (const listener of [...listeners]) {
      listener(event);
    }

    return event;
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  return {
    emit,
    subscribe,
  };
}
