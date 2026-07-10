import { useSyncExternalStore } from "react";
import type {
  TerminalAgentStatus,
  TerminalAgentStatusSnapshot,
  WorkspaceSyncEvent,
} from "@codesymphony/shared-types";

// Module-level store: terminal agent statuses arrive over the workspace SSE
// channel (no per-component subscription) and are read by every TerminalTab.
const statuses = new Map<string, TerminalAgentStatus>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeTerminalAgentStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTerminalAgentStatus(sessionId: string): TerminalAgentStatus | undefined {
  return statuses.get(sessionId);
}

function set(sessionId: string, status: TerminalAgentStatus): void {
  if (statuses.get(sessionId) === status) {
    return;
  }
  statuses.set(sessionId, status);
  notify();
}

export function setTerminalAgentStatuses(snapshots: TerminalAgentStatusSnapshot[]): void {
  let changed = false;
  for (const { sessionId, status } of snapshots) {
    if (statuses.get(sessionId) !== status) {
      statuses.set(sessionId, status);
      changed = true;
    }
  }
  if (changed) {
    notify();
  }
}

export function applyTerminalAgentStatusEvent(event: WorkspaceSyncEvent): void {
  if (event.type !== "terminal.agent.status") {
    return;
  }
  if (!event.terminalSessionId || !event.terminalAgentStatus) {
    return;
  }
  set(event.terminalSessionId, event.terminalAgentStatus);
}

interface TerminalAgentStatusApi {
  getTerminalAgentStatuses: () => Promise<TerminalAgentStatusSnapshot[]>;
}

export async function hydrateTerminalAgentStatuses(api: TerminalAgentStatusApi): Promise<void> {
  try {
    setTerminalAgentStatuses(await api.getTerminalAgentStatuses());
  } catch {
    // best-effort; live events will still populate the store
  }
}

export function useTerminalAgentStatus(sessionId: string): TerminalAgentStatus | undefined {
  return useSyncExternalStore(
    subscribeTerminalAgentStatus,
    () => statuses.get(sessionId),
  );
}

export function __resetTerminalAgentStatusStoreForTest(): void {
  statuses.clear();
  listeners.clear();
}
