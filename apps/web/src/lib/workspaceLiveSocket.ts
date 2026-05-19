import type {
  WorkspaceLiveResourceEvent,
  WorkspaceLiveSocketClientMessage,
  WorkspaceLiveSocketServerMessage,
  WorkspaceLiveSocketSubscription,
  WorkspaceSyncEvent,
} from "@codesymphony/shared-types";
import { api } from "./api";
import { debugLog } from "./debugLog";

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 1_000;

type WorkspaceLiveSocketDisconnectState = "reconnecting" | "exhausted";

type WorkspaceLiveSocketObserver = {
  getSubscriptions: () => WorkspaceLiveSocketSubscription[];
  onDisconnect?: (state: WorkspaceLiveSocketDisconnectState) => void;
  onHeartbeat?: () => void;
  onLiveResourceError?: (error: {
    message: string;
    resource: WorkspaceLiveResourceEvent["resource"];
    scopeId: string;
  }) => void;
  onLiveResourceEvent?: (event: WorkspaceLiveResourceEvent) => void;
  onOpen?: () => void;
  onWorkspaceSyncEvent?: (event: WorkspaceSyncEvent) => void;
};

type WorkspaceLiveSocketState = {
  activeSubscriptions: Map<string, WorkspaceLiveSocketSubscription>;
  observers: Set<WorkspaceLiveSocketObserver>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  socket: WebSocket | null;
};

const workspaceLiveSocketState: WorkspaceLiveSocketState = {
  activeSubscriptions: new Map(),
  observers: new Set(),
  reconnectAttempts: 0,
  reconnectTimer: null,
  socket: null,
};

function getWorkspaceLiveBaseUrl() {
  if (typeof api.runtimeBaseUrl === "string" && api.runtimeBaseUrl.length > 0) {
    return api.runtimeBaseUrl;
  }

  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin.length > 0) {
    return window.location.origin;
  }

  return "http://127.0.0.1:4331";
}

function buildWorkspaceLiveWebSocketUrl() {
  const socketUrl = new URL("/api/workspace/live/ws", getWorkspaceLiveBaseUrl());
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  return socketUrl.toString();
}

function summarizeSubscriptions(subscriptions: Iterable<WorkspaceLiveSocketSubscription>) {
  return [...subscriptions].map((subscription) => {
    if (subscription.type === "workspace_sync") {
      return "workspace_sync";
    }

    return `${subscription.resource}:${subscription.scopeId}:${subscription.afterSeq ?? "none"}`;
  });
}

function toSubscriptionKey(subscription: WorkspaceLiveSocketSubscription) {
  if (subscription.type === "workspace_sync") {
    return "workspace_sync";
  }

  return `live_resource:${subscription.resource}:${subscription.scopeId}`;
}

function mergeSubscriptions() {
  const merged = new Map<string, WorkspaceLiveSocketSubscription>();

  for (const observer of workspaceLiveSocketState.observers) {
    for (const subscription of observer.getSubscriptions()) {
      const key = toSubscriptionKey(subscription);
      const existing = merged.get(key);
      if (!existing || existing.type !== "live_resource" || subscription.type !== "live_resource") {
        merged.set(key, subscription);
        continue;
      }

      const existingAfterSeq = existing.afterSeq;
      const nextAfterSeq = subscription.afterSeq;
      merged.set(key, {
        ...existing,
        afterSeq: typeof existingAfterSeq === "number" && typeof nextAfterSeq === "number"
          ? Math.max(existingAfterSeq, nextAfterSeq)
          : existingAfterSeq ?? nextAfterSeq,
      });
    }
  }

  return merged;
}

function clearReconnectTimer() {
  if (workspaceLiveSocketState.reconnectTimer !== null) {
    clearTimeout(workspaceLiveSocketState.reconnectTimer);
    workspaceLiveSocketState.reconnectTimer = null;
  }
}

function closeSocket() {
  if (!workspaceLiveSocketState.socket) {
    return;
  }

  workspaceLiveSocketState.socket.onopen = null;
  workspaceLiveSocketState.socket.onmessage = null;
  workspaceLiveSocketState.socket.onclose = null;
  workspaceLiveSocketState.socket.onerror = null;
  workspaceLiveSocketState.socket.close();
  workspaceLiveSocketState.socket = null;
  workspaceLiveSocketState.activeSubscriptions.clear();
}

function notifyOpen() {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onOpen?.();
  }
}

function notifyDisconnect(state: WorkspaceLiveSocketDisconnectState) {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onDisconnect?.(state);
  }
}

function notifyHeartbeat() {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onHeartbeat?.();
  }
}

function emitWorkspaceSyncEvent(event: WorkspaceSyncEvent) {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onWorkspaceSyncEvent?.(event);
  }
}

function emitLiveResourceEvent(event: WorkspaceLiveResourceEvent) {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onLiveResourceEvent?.(event);
  }
}

function emitLiveResourceError(error: {
  message: string;
  resource: WorkspaceLiveResourceEvent["resource"];
  scopeId: string;
}) {
  for (const observer of [...workspaceLiveSocketState.observers]) {
    observer.onLiveResourceError?.(error);
  }
}

function sendSocketMessage(message: WorkspaceLiveSocketClientMessage) {
  if (workspaceLiveSocketState.socket?.readyState !== WebSocket.OPEN || message.subscriptions.length === 0) {
    return;
  }

  workspaceLiveSocketState.socket.send(JSON.stringify(message));
}

function syncServerSubscriptions() {
  if (workspaceLiveSocketState.socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  const desiredSubscriptions = mergeSubscriptions();
  const subscriptionsToAdd = [...desiredSubscriptions.entries()]
    .filter(([key]) => !workspaceLiveSocketState.activeSubscriptions.has(key))
    .map(([, subscription]) => subscription);
  const subscriptionsToRemove = [...workspaceLiveSocketState.activeSubscriptions.entries()]
    .filter(([key]) => !desiredSubscriptions.has(key))
    .map(([, subscription]) => subscription);

  sendSocketMessage({
    type: "unsubscribe",
    subscriptions: subscriptionsToRemove,
  });
  sendSocketMessage({
    type: "subscribe",
    subscriptions: subscriptionsToAdd,
  });

  if (subscriptionsToAdd.length > 0 || subscriptionsToRemove.length > 0) {
    debugLog("workspace.live.socket", "subscriptions.sync", {
      add: summarizeSubscriptions(subscriptionsToAdd),
      remove: summarizeSubscriptions(subscriptionsToRemove),
      desired: summarizeSubscriptions(desiredSubscriptions.values()),
      observers: workspaceLiveSocketState.observers.size,
    }, { force: true });
  }

  workspaceLiveSocketState.activeSubscriptions = desiredSubscriptions;
}

function scheduleReconnect() {
  if (
    workspaceLiveSocketState.observers.size === 0
    || workspaceLiveSocketState.reconnectTimer !== null
  ) {
    return;
  }

  const nextAttempt = workspaceLiveSocketState.reconnectAttempts + 1;
  workspaceLiveSocketState.reconnectAttempts = nextAttempt;

  if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
    debugLog("workspace.live.socket", "reconnect.exhausted", {
      attempts: nextAttempt,
      observers: workspaceLiveSocketState.observers.size,
    }, { force: true });
    notifyDisconnect("exhausted");
    return;
  }

  debugLog("workspace.live.socket", "reconnect.scheduled", {
    attempt: nextAttempt,
    observers: workspaceLiveSocketState.observers.size,
  }, { force: true });
  notifyDisconnect("reconnecting");
  const delayMs = BASE_RECONNECT_DELAY_MS * Math.pow(2, Math.min(nextAttempt - 1, 5));
  workspaceLiveSocketState.reconnectTimer = setTimeout(() => {
    workspaceLiveSocketState.reconnectTimer = null;
    connectWorkspaceLiveSocket();
  }, delayMs);
}

function connectWorkspaceLiveSocket() {
  if (
    workspaceLiveSocketState.observers.size === 0
    || (
      workspaceLiveSocketState.socket
      && (
        workspaceLiveSocketState.socket.readyState === WebSocket.OPEN
        || workspaceLiveSocketState.socket.readyState === WebSocket.CONNECTING
      )
    )
  ) {
    return;
  }

  clearReconnectTimer();
  closeSocket();

  debugLog("workspace.live.socket", "connect.start", {
    observers: workspaceLiveSocketState.observers.size,
    reconnectAttempts: workspaceLiveSocketState.reconnectAttempts,
    url: buildWorkspaceLiveWebSocketUrl(),
  }, { force: true });
  const socket = new WebSocket(buildWorkspaceLiveWebSocketUrl());
  workspaceLiveSocketState.socket = socket;

  socket.onopen = () => {
    if (workspaceLiveSocketState.socket !== socket) {
      socket.close();
      return;
    }

    workspaceLiveSocketState.reconnectAttempts = 0;
    workspaceLiveSocketState.activeSubscriptions.clear();
    debugLog("workspace.live.socket", "connect.open", {
      observers: workspaceLiveSocketState.observers.size,
    }, { force: true });
    syncServerSubscriptions();
    notifyOpen();
  };

  socket.onmessage = (event) => {
    if (workspaceLiveSocketState.socket !== socket) {
      return;
    }

    let payload: WorkspaceLiveSocketServerMessage;
    try {
      payload = JSON.parse(event.data as string) as WorkspaceLiveSocketServerMessage;
    } catch {
      return;
    }

    if (payload.type === "heartbeat") {
      notifyHeartbeat();
      return;
    }

    if (payload.type === "workspace_sync") {
      emitWorkspaceSyncEvent(payload.event);
      return;
    }

    if (payload.type === "live_resource_error") {
      debugLog("workspace.live.socket", "resource.error", {
        resource: payload.resource,
        scopeId: payload.scopeId,
        message: payload.message,
      }, { force: true });
      emitLiveResourceError({
        resource: payload.resource,
        scopeId: payload.scopeId,
        message: payload.message,
      });
      return;
    }

    emitLiveResourceEvent(payload.event);
  };

  socket.onclose = (event) => {
    debugLog("workspace.live.socket", "connect.closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      observers: workspaceLiveSocketState.observers.size,
    }, { force: true });
    if (workspaceLiveSocketState.socket === socket) {
      workspaceLiveSocketState.socket = null;
      workspaceLiveSocketState.activeSubscriptions.clear();
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    debugLog("workspace.live.socket", "connect.error", {
      observers: workspaceLiveSocketState.observers.size,
    }, { force: true });
    socket.close();
  };
}

function subscribeToWorkspaceLiveSocket(observer: WorkspaceLiveSocketObserver) {
  workspaceLiveSocketState.observers.add(observer);
  connectWorkspaceLiveSocket();
  syncServerSubscriptions();

  return () => {
    workspaceLiveSocketState.observers.delete(observer);
    if (workspaceLiveSocketState.observers.size > 0) {
      syncServerSubscriptions();
      return;
    }

    clearReconnectTimer();
    workspaceLiveSocketState.reconnectAttempts = 0;
    closeSocket();
  };
}

export function subscribeToWorkspaceSyncSocket(observer: {
  onEvent: (event: WorkspaceSyncEvent) => void;
  onOpen?: () => void;
}) {
  return subscribeToWorkspaceLiveSocket({
    getSubscriptions: () => [{ type: "workspace_sync" }],
    onOpen: observer.onOpen,
    onWorkspaceSyncEvent: observer.onEvent,
  });
}

export function subscribeToWorkspaceLiveResourceSocket(observer: {
  getAfterSeq?: () => number | null;
  onDisconnect?: (state: WorkspaceLiveSocketDisconnectState) => void;
  onEvent: (event: WorkspaceLiveResourceEvent) => void;
  onError?: (message: string) => void;
  onHeartbeat?: () => void;
  onOpen?: () => void;
  resource: WorkspaceLiveResourceEvent["resource"];
  scopeId: string;
}) {
  return subscribeToWorkspaceLiveSocket({
    getSubscriptions: () => {
      const afterSeq = observer.getAfterSeq?.();
      return [{
        type: "live_resource",
        resource: observer.resource,
        scopeId: observer.scopeId,
        ...(typeof afterSeq === "number" ? { afterSeq } : {}),
      }];
    },
    onDisconnect: observer.onDisconnect,
    onHeartbeat: observer.onHeartbeat,
    onLiveResourceError: (error) => {
      if (error.resource !== observer.resource || error.scopeId !== observer.scopeId) {
        return;
      }
      observer.onError?.(error.message);
    },
    onLiveResourceEvent: (event) => {
      if (event.resource !== observer.resource || event.scopeId !== observer.scopeId) {
        return;
      }
      observer.onEvent(event);
    },
    onOpen: observer.onOpen,
  });
}
