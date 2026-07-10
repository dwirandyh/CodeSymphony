import { useSyncExternalStore } from "react";
import type {
  TerminalAgentStatus,
  TerminalAgentStatusSnapshot,
  WorkspaceSyncEvent,
} from "@codesymphony/shared-types";
import type { WorktreeStatusSummary } from "./worktreeThreadStatus";

// Module-level store: terminal agent statuses arrive over the workspace SSE
// channel (no per-component subscription) and are read by every TerminalTab
// plus the worktree list (rollup for sidebar braille).
const statuses = new Map<string, TerminalAgentStatus>();
const listeners = new Set<() => void>();
let storeVersion = 0;

// Same priority order as worktree thread aggregation (lower index wins).
const STATUS_PRIORITY: TerminalAgentStatus[] = [
  "waiting_approval",
  "review_plan",
  "running",
  "idle",
];

function notify(): void {
  storeVersion += 1;
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

export function getTerminalAgentStatusStoreVersion(): number {
  return storeVersion;
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

/**
 * Highest-priority non-idle agent status across every terminal session that
 * belongs to the worktree (`${worktreeId}:terminal:...`). Used so the sidebar
 * braille matches chat-thread status when an agent CLI runs in a terminal.
 */
export function getWorktreeTerminalAgentStatus(worktreeId: string): TerminalAgentStatus | undefined {
  const prefix = `${worktreeId}:`;
  let best: TerminalAgentStatus | undefined;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (const [sessionId, status] of statuses) {
    if (!sessionId.startsWith(prefix) || status === "idle") {
      continue;
    }
    const priority = STATUS_PRIORITY.indexOf(status);
    if (priority >= 0 && priority < bestPriority) {
      best = status;
      bestPriority = priority;
    }
  }

  return best;
}

/** Merge thread-derived worktree status with any live terminal agent status. */
export function mergeWorktreeStatusWithTerminalAgent(
  threadSummary: WorktreeStatusSummary,
  terminalStatus: TerminalAgentStatus | undefined,
): WorktreeStatusSummary {
  if (!terminalStatus || terminalStatus === "idle") {
    return threadSummary;
  }

  const threadPriority = STATUS_PRIORITY.indexOf(threadSummary.kind);
  const terminalPriority = STATUS_PRIORITY.indexOf(terminalStatus);
  if (terminalPriority >= 0 && terminalPriority < threadPriority) {
    return { kind: terminalStatus, threadId: threadSummary.threadId };
  }

  return threadSummary;
}

interface TerminalAgentStatusApi {
  getTerminalAgentStatuses: () => Promise<TerminalAgentStatusSnapshot[]>;
}

export async function hydrateTerminalAgentStatuses(api: TerminalAgentStatusApi): Promise<void> {
  try {
    const snapshots = await api.getTerminalAgentStatuses();
    if (Array.isArray(snapshots)) {
      setTerminalAgentStatuses(snapshots);
    }
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
  storeVersion = 0;
}
