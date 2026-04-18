type ThreadStreamState = {
  seenEventIds: Set<string>;
  lastEventIdx: number | null;
  lastMessageSeq: number | null;
  lastAppliedSnapshotKey: string | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
};

const threadStreamStateRegistry = new Map<string, ThreadStreamState>();

function createThreadStreamState(): ThreadStreamState {
  return {
    seenEventIds: new Set<string>(),
    lastEventIdx: null,
    lastMessageSeq: null,
    lastAppliedSnapshotKey: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    disposed: false,
  };
}

export function getThreadStreamState(threadId: string) {
  const existing = threadStreamStateRegistry.get(threadId);
  if (existing) {
    existing.disposed = false;
    return existing;
  }

  const created = createThreadStreamState();
  threadStreamStateRegistry.set(threadId, created);
  return created;
}

export function hasSeenThreadEvent(threadId: string, eventId: string) {
  return getThreadStreamState(threadId).seenEventIds.has(eventId);
}

export function markThreadEventSeen(threadId: string, eventId: string) {
  getThreadStreamState(threadId).seenEventIds.add(eventId);
}

export function replaceSeenThreadEventIds(threadId: string, eventIds: Iterable<string>) {
  const state = getThreadStreamState(threadId);
  state.seenEventIds = new Set(eventIds);
}

export function getThreadLastEventIdx(threadId: string) {
  return getThreadStreamState(threadId).lastEventIdx;
}

export function setThreadLastEventIdx(threadId: string, idx: number | null) {
  const state = getThreadStreamState(threadId);
  if (idx == null) {
    state.lastEventIdx = null;
    return;
  }

  state.lastEventIdx = state.lastEventIdx == null ? idx : Math.max(state.lastEventIdx, idx);
}

export function getThreadLastMessageSeq(threadId: string) {
  return getThreadStreamState(threadId).lastMessageSeq;
}

export function setThreadLastMessageSeq(threadId: string, seq: number | null) {
  const state = getThreadStreamState(threadId);
  if (seq == null) {
    state.lastMessageSeq = null;
    return;
  }

  state.lastMessageSeq = state.lastMessageSeq == null ? seq : Math.max(state.lastMessageSeq, seq);
}

export function allocateNextThreadMessageSeq(threadId: string, fallbackLastSeq: number | null = null) {
  const state = getThreadStreamState(threadId);
  const baseSeq = state.lastMessageSeq ?? fallbackLastSeq ?? 0;
  const nextSeq = baseSeq + 1;
  state.lastMessageSeq = nextSeq;
  return nextSeq;
}

export function getThreadLastAppliedSnapshotKey(threadId: string) {
  return getThreadStreamState(threadId).lastAppliedSnapshotKey;
}

export function setThreadLastAppliedSnapshotKey(threadId: string, snapshotKey: string | null) {
  getThreadStreamState(threadId).lastAppliedSnapshotKey = snapshotKey;
}

export function resetThreadReconnectAttempts(threadId: string) {
  getThreadStreamState(threadId).reconnectAttempts = 0;
}

export function incrementThreadReconnectAttempts(threadId: string) {
  const state = getThreadStreamState(threadId);
  state.reconnectAttempts += 1;
  return state.reconnectAttempts;
}

export function getThreadReconnectAttempts(threadId: string) {
  return getThreadStreamState(threadId).reconnectAttempts;
}

export function setThreadReconnectTimer(
  threadId: string,
  reconnectTimer: ReturnType<typeof setTimeout> | null,
) {
  const state = getThreadStreamState(threadId);
  if (state.reconnectTimer && state.reconnectTimer !== reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }
  state.reconnectTimer = reconnectTimer;
}

export function clearThreadReconnectTimer(threadId: string) {
  const state = getThreadStreamState(threadId);
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

export function markThreadStreamDisposed(threadId: string, disposed: boolean) {
  getThreadStreamState(threadId).disposed = disposed;
}

export function isThreadStreamDisposed(threadId: string) {
  return getThreadStreamState(threadId).disposed;
}

export function clearThreadStreamState(threadId: string) {
  clearThreadReconnectTimer(threadId);
  threadStreamStateRegistry.delete(threadId);
}

export function clearAllThreadStreamState() {
  for (const threadId of [...threadStreamStateRegistry.keys()]) {
    clearThreadStreamState(threadId);
  }
}

export function resetThreadStreamStateRegistryForTest() {
  clearAllThreadStreamState();
}
