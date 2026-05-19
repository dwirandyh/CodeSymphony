import { startTransition, useEffect, useMemo, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type {
  WorkspaceLiveConnectionState,
  WorkspaceLiveResourceEvent,
  WorkspaceLiveResourceKind,
} from "@codesymphony/shared-types";
import { api } from "./api";
import { debugLog } from "./debugLog";
import { subscribeToWorkspaceLiveResourceSocket } from "./workspaceLiveSocket";

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;
const DEFAULT_BASE_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 45_000;
const STALE_WATCH_INTERVAL_MS = 5_000;

type WorkspaceLiveResourceState = {
  connectionState: WorkspaceLiveConnectionState;
  errorMessage: string | null;
  lastSeq: number | null;
};

type WorkspaceLiveResourceTransport =
  | {
    kind?: "event_source";
    buildPath: (afterSeq?: number | null) => string;
  }
  | {
    kind: "workspace_socket";
    resource: WorkspaceLiveResourceKind;
    scopeId: string;
  };

type WorkspaceLiveResourceOptions<TSnapshot> = {
  applySnapshot: (snapshot: TSnapshot) => void;
  fallbackRefetch?: () => Promise<unknown> | void;
  maxReconnectAttempts?: number;
  shouldFallbackRefetch?: (params: {
    errorMessage: string | null;
    reason: "disconnect_exhausted" | "resource_error";
  }) => boolean;
  staleAfterMs?: number;
  transport: WorkspaceLiveResourceTransport;
};

type WorkspaceLiveResourceEntry<TSnapshot> = {
  errorMessage: string | null;
  hasReceivedSnapshot: boolean;
  key: string;
  lastActivityAtMs: number | null;
  lastSeq: number | null;
  listeners: Set<() => void>;
  options: WorkspaceLiveResourceOptions<TSnapshot>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
  snapshot: WorkspaceLiveResourceState;
  socketUnsubscribe: (() => void) | null;
  staleWatchTimer: ReturnType<typeof setInterval> | null;
  state: WorkspaceLiveConnectionState;
  stream: EventSource | null;
};

const liveResourceRegistry = new WeakMap<QueryClient, Map<string, WorkspaceLiveResourceEntry<unknown>>>();

function getRegistry(queryClient: QueryClient) {
  let existing = liveResourceRegistry.get(queryClient);
  if (existing) {
    return existing;
  }

  existing = new Map<string, WorkspaceLiveResourceEntry<unknown>>();
  liveResourceRegistry.set(queryClient, existing);
  return existing;
}

function getWorkspaceLiveBaseUrl() {
  if (typeof api.runtimeBaseUrl === "string" && api.runtimeBaseUrl.length > 0) {
    return api.runtimeBaseUrl;
  }

  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin.length > 0) {
    return window.location.origin;
  }

  return "http://127.0.0.1:4331";
}

function getTransportDebugData<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  const transport = entry.options.transport;
  if (transport.kind === "workspace_socket") {
    return {
      transportKind: transport.kind,
      resource: transport.resource,
      scopeId: transport.scopeId,
    };
  }

  return {
    transportKind: transport.kind ?? "event_source",
    resource: null,
    scopeId: null,
  };
}

function logResourceStateTransition<TSnapshot>(
  entry: WorkspaceLiveResourceEntry<TSnapshot>,
  nextState: WorkspaceLiveConnectionState,
  reason: string,
  data?: Record<string, unknown>,
) {
  if (entry.state === nextState) {
    return;
  }

  debugLog("workspace.live.resource", reason, {
    key: entry.key,
    from: entry.state,
    to: nextState,
    hasReceivedSnapshot: entry.hasReceivedSnapshot,
    lastSeq: entry.lastSeq,
    reconnectAttempts: entry.reconnectAttempts,
    errorMessage: entry.errorMessage,
    ...getTransportDebugData(entry),
    ...(data ?? {}),
  }, { force: true });
}

function setEntryState<TSnapshot>(
  entry: WorkspaceLiveResourceEntry<TSnapshot>,
  nextState: WorkspaceLiveConnectionState,
  reason: string,
  data?: Record<string, unknown>,
) {
  logResourceStateTransition(entry, nextState, reason, data);
  entry.state = nextState;
}

function syncSnapshot<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  const currentSnapshot = entry.snapshot;
  if (
    currentSnapshot.connectionState === entry.state
    && currentSnapshot.errorMessage === entry.errorMessage
    && currentSnapshot.lastSeq === entry.lastSeq
  ) {
    return;
  }

  entry.snapshot = {
    connectionState: entry.state,
    errorMessage: entry.errorMessage,
    lastSeq: entry.lastSeq,
  };
}

function notify<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  syncSnapshot(entry);
  for (const listener of [...entry.listeners]) {
    listener();
  }
}

function getStateSnapshot<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>): WorkspaceLiveResourceState {
  return entry.snapshot;
}

function touchActivity<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  entry.lastActivityAtMs = Date.now();
  if (entry.state === "stale") {
    setEntryState(entry, "healthy", "activity.touch");
    notify(entry);
  }
}

function healActiveConnection<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.state !== "connecting" && entry.state !== "reconnecting") {
    return false;
  }

  entry.reconnectAttempts = 0;
  entry.errorMessage = null;
  setEntryState(entry, "healthy", "snapshot.heal");
  notify(entry);
  return true;
}

function closeEventSource<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (!entry.stream) {
    return;
  }

  entry.stream.onopen = null;
  entry.stream.onerror = null;
  entry.stream.close();
  entry.stream = null;
}

function clearReconnectTimer<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.reconnectTimer !== null) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
}

function clearStaleWatch<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.staleWatchTimer !== null) {
    clearInterval(entry.staleWatchTimer);
    entry.staleWatchTimer = null;
  }
}

function ensureStaleWatch<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.staleWatchTimer !== null) {
    return;
  }

  entry.staleWatchTimer = setInterval(() => {
    if (
      entry.refCount <= 0
      || entry.lastActivityAtMs == null
      || (entry.stream == null && entry.socketUnsubscribe == null)
    ) {
      return;
    }

    const staleAfterMs = entry.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (Date.now() - entry.lastActivityAtMs <= staleAfterMs) {
      return;
    }

    if (entry.state === "healthy") {
      setEntryState(entry, "stale", "watchdog.stale", {
        staleAfterMs,
      });
      notify(entry);
    }
  }, STALE_WATCH_INTERVAL_MS);
}

function requestRefresh<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>, params: {
  errorMessage: string | null;
  reason: "disconnect_exhausted" | "resource_error";
}) {
  if (entry.options.shouldFallbackRefetch && !entry.options.shouldFallbackRefetch(params)) {
    return;
  }

  void entry.options.fallbackRefetch?.();
}

function handleLiveResourceEvent<TSnapshot>(
  entry: WorkspaceLiveResourceEntry<TSnapshot>,
  payload: WorkspaceLiveResourceEvent,
) {
  if (entry.lastSeq != null && payload.seq <= entry.lastSeq) {
    touchActivity(entry);
    healActiveConnection(entry);
    return;
  }

  touchActivity(entry);
  entry.lastSeq = payload.seq;
  entry.hasReceivedSnapshot = true;
  entry.reconnectAttempts = 0;
  entry.errorMessage = null;
  startTransition(() => {
    entry.options.applySnapshot(payload.snapshot as TSnapshot);
  });
  if (healActiveConnection(entry)) {
    return;
  }
  notify(entry);
}

function startWorkspaceSocketTransport<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.refCount <= 0 || entry.socketUnsubscribe) {
    return;
  }

  const transport = entry.options.transport;
  if (transport.kind !== "workspace_socket") {
    return;
  }

  clearReconnectTimer(entry);
  closeEventSource(entry);
  ensureStaleWatch(entry);

  setEntryState(entry, "connecting", "transport.start");
  notify(entry);

  entry.socketUnsubscribe = subscribeToWorkspaceLiveResourceSocket({
    resource: transport.resource,
    scopeId: transport.scopeId,
    getAfterSeq: () => entry.lastSeq,
    onOpen() {
      touchActivity(entry);
      if (!entry.hasReceivedSnapshot && entry.state !== "connecting") {
        setEntryState(entry, "connecting", "transport.open.awaiting-first-snapshot");
        notify(entry);
      }
    },
    onHeartbeat() {
      touchActivity(entry);
    },
    onError(message) {
      setEntryState(entry, "exhausted", "resource.error", {
        message,
      });
      entry.errorMessage = message;
      requestRefresh(entry, {
        errorMessage: message,
        reason: "resource_error",
      });
      notify(entry);
    },
    onDisconnect(state) {
      if (state === "exhausted") {
        setEntryState(entry, "exhausted", "socket.disconnect.exhausted");
        entry.errorMessage = "Workspace live stream exhausted";
        requestRefresh(entry, {
          errorMessage: entry.errorMessage,
          reason: "disconnect_exhausted",
        });
        notify(entry);
        return;
      }

      setEntryState(entry, "reconnecting", "socket.disconnect.reconnecting");
      notify(entry);
    },
    onEvent(event) {
      handleLiveResourceEvent(entry, event);
    },
  });
}

function startEventSourceTransport<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.refCount <= 0) {
    return;
  }

  const transport = entry.options.transport;
  if (transport.kind === "workspace_socket") {
    return;
  }

  closeEventSource(entry);
  clearReconnectTimer(entry);
  ensureStaleWatch(entry);

  setEntryState(entry, "connecting", "transport.start");
  notify(entry);

  const path = transport.buildPath(entry.lastSeq);
  const url = new URL(path, getWorkspaceLiveBaseUrl()).toString();
  const stream = new EventSource(url);
  entry.stream = stream;

  const onSnapshot = (rawEvent: MessageEvent<string>) => {
    if (entry.stream !== stream) {
      return;
    }

    const payload = JSON.parse(rawEvent.data) as WorkspaceLiveResourceEvent;
    handleLiveResourceEvent(entry, payload);
  };

  const onHeartbeat = () => {
    if (entry.stream !== stream) {
      return;
    }
    touchActivity(entry);
  };

  stream.addEventListener("snapshot", onSnapshot as EventListener);
  stream.addEventListener("heartbeat", onHeartbeat as EventListener);

  stream.onopen = () => {
    if (entry.stream !== stream) {
      return;
    }
    touchActivity(entry);
    if (!entry.hasReceivedSnapshot && entry.state !== "connecting") {
      setEntryState(entry, "connecting", "transport.open.awaiting-first-snapshot");
      notify(entry);
    }
  };

  stream.onerror = () => {
    if (entry.stream !== stream) {
      return;
    }

    if (stream.readyState !== EventSource.CLOSED) {
      return;
    }

    closeEventSource(entry);
    if (entry.refCount <= 0) {
      return;
    }

    const maxAttempts = entry.options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (entry.reconnectAttempts >= maxAttempts) {
      setEntryState(entry, "exhausted", "stream.exhausted");
      entry.errorMessage = "Workspace live stream exhausted";
      requestRefresh(entry, {
        errorMessage: entry.errorMessage,
        reason: "disconnect_exhausted",
      });
      notify(entry);
      return;
    }

    entry.reconnectAttempts += 1;
    setEntryState(entry, "reconnecting", "stream.reconnect.scheduled");
    notify(entry);

    const delayMs = DEFAULT_BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(entry.reconnectAttempts - 1, 5));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      startEventSourceTransport(entry);
    }, delayMs);
  };
}

function startTransport<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  if (entry.options.transport.kind === "workspace_socket") {
    startWorkspaceSocketTransport(entry);
    return;
  }

  startEventSourceTransport(entry);
}

function closeTransport<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  entry.socketUnsubscribe?.();
  entry.socketUnsubscribe = null;
  closeEventSource(entry);
}

function createEntry<TSnapshot>(
  key: string,
  options: WorkspaceLiveResourceOptions<TSnapshot>,
): WorkspaceLiveResourceEntry<TSnapshot> {
  return {
    errorMessage: null,
    hasReceivedSnapshot: false,
    key,
    lastActivityAtMs: null,
    lastSeq: null,
    listeners: new Set(),
    options,
    reconnectAttempts: 0,
    reconnectTimer: null,
    refCount: 0,
    snapshot: {
      connectionState: "connecting",
      errorMessage: null,
      lastSeq: null,
    },
    socketUnsubscribe: null,
    staleWatchTimer: null,
    state: "connecting",
    stream: null,
  };
}

function getOrCreateEntry<TSnapshot>(
  queryClient: QueryClient,
  key: string,
  options: WorkspaceLiveResourceOptions<TSnapshot>,
): WorkspaceLiveResourceEntry<TSnapshot> {
  const registry = getRegistry(queryClient);
  const existing = registry.get(key);
  if (existing) {
    (existing as WorkspaceLiveResourceEntry<TSnapshot>).options = options;
    return existing as WorkspaceLiveResourceEntry<TSnapshot>;
  }

  const created = createEntry(key, options);
  registry.set(key, created as WorkspaceLiveResourceEntry<unknown>);
  return created;
}

function retainEntry<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>) {
  entry.refCount += 1;
  if (entry.refCount === 1) {
    startTransport(entry);
  }

  return () => {
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) {
      return;
    }

    clearReconnectTimer(entry);
    clearStaleWatch(entry);
    closeTransport(entry);
  };
}

function subscribeToEntry<TSnapshot>(entry: WorkspaceLiveResourceEntry<TSnapshot>, listener: () => void) {
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function useWorkspaceLiveResource<TSnapshot>(params: {
  enabled: boolean;
  key: string;
  options: WorkspaceLiveResourceOptions<TSnapshot>;
  queryClient: QueryClient;
}) {
  const entry = useMemo(
    () => getOrCreateEntry(params.queryClient, params.key, params.options),
    [params.key, params.options, params.queryClient],
  );
  entry.options = params.options;

  const snapshot = useSyncExternalStore(
    (listener) => subscribeToEntry(entry, listener),
    () => getStateSnapshot(entry),
    () => getStateSnapshot(entry),
  );

  useEffect(() => {
    if (!params.enabled) {
      return;
    }
    return retainEntry(entry);
  }, [entry, params.enabled]);

  return snapshot;
}

export function requestWorkspaceLiveResourceRefresh(queryClient: QueryClient, key: string) {
  const entry = getRegistry(queryClient).get(key);
  if (!entry) {
    return;
  }

  void entry.options.fallbackRefetch?.();
}
