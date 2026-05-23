import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import type {
  WorkspaceLiveResourceEvent,
  WorkspaceLiveSocketClientMessage,
  WorkspaceLiveSocketSubscription,
  WorkspaceSyncEvent,
} from "@codesymphony/shared-types";

type ResourceSubscriptionHandler = {
  listEvents: (afterSeq?: number) => Promise<WorkspaceLiveResourceEvent[]>;
  subscribe: (listener: (event: WorkspaceLiveResourceEvent) => void) => () => void;
};

type SocketSubscriptionState = {
  afterSeq: number | undefined;
  bufferedEvents: WorkspaceLiveResourceEvent[];
  historyFlushed: boolean;
  subscription: WorkspaceLiveSocketSubscription;
  unsubscribe: (() => void) | null;
};

function toSubscriptionKey(subscription: WorkspaceLiveSocketSubscription) {
  if (subscription.type === "workspace_sync") {
    return "workspace_sync";
  }

  return `live_resource:${subscription.resource}:${subscription.scopeId}`;
}

function sendWorkspaceSyncEvent(socket: WebSocket, event: WorkspaceSyncEvent) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "workspace_sync",
    event,
  }));
}

function sendWorkspaceLiveResourceEvent(socket: WebSocket, event: WorkspaceLiveResourceEvent) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "live_resource",
    event,
  }));
}

function sendWorkspaceLiveResourceError(socket: WebSocket, params: {
  message: string;
  resource: Extract<WorkspaceLiveSocketSubscription, { type: "live_resource" }>["resource"];
  scopeId: string;
}) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "live_resource_error",
    resource: params.resource,
    scopeId: params.scopeId,
    message: params.message,
  }));
}

function sendHeartbeat(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: "heartbeat",
    ts: new Date().toISOString(),
  }));
}

function resolveResourceSubscriptionHandler(
  app: FastifyInstance,
  subscription: Extract<WorkspaceLiveSocketSubscription, { type: "live_resource" }>,
): ResourceSubscriptionHandler | null {
  switch (subscription.resource) {
    case "git_status":
      return {
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listGitStatusEvents(subscription.scopeId, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToGitStatus(subscription.scopeId, listener),
      };
    case "repository_branches":
      return {
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listRepositoryBranchesEvents(subscription.scopeId, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToRepositoryBranches(subscription.scopeId, listener),
      };
    case "repository_reviews":
      return {
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listRepositoryReviewsEvents(subscription.scopeId, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToRepositoryReviews(subscription.scopeId, listener),
      };
    case "automation_runs":
      return {
        listEvents: (afterSeq) => app.workspaceLiveUpdateService.listAutomationRunsEvents(subscription.scopeId, afterSeq),
        subscribe: (listener) => app.workspaceLiveUpdateService.subscribeToAutomationRuns(subscription.scopeId, listener),
      };
    default:
      return null;
  }
}

function cleanupSocketSubscription(state: SocketSubscriptionState | undefined) {
  state?.unsubscribe?.();
  if (state) {
    state.unsubscribe = null;
  }
}

async function attachLiveResourceSubscription(params: {
  app: FastifyInstance;
  socket: WebSocket;
  state: SocketSubscriptionState;
}) {
  const { app, socket, state } = params;
  if (state.subscription.type !== "live_resource") {
    return;
  }

  const handler = resolveResourceSubscriptionHandler(app, state.subscription);
  if (!handler) {
    return;
  }

  const subscriptionAfterSeq = typeof state.subscription.afterSeq === "number"
    ? state.subscription.afterSeq
    : undefined;
  state.afterSeq = subscriptionAfterSeq;
  state.bufferedEvents = [];
  state.historyFlushed = false;

  state.unsubscribe = handler.subscribe((event) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (typeof state.afterSeq === "number" && event.seq <= state.afterSeq) {
      return;
    }

    if (!state.historyFlushed) {
      state.bufferedEvents.push(event);
      return;
    }

    sendWorkspaceLiveResourceEvent(socket, event);
    state.afterSeq = event.seq;
  });

  const history = await handler.listEvents(subscriptionAfterSeq);
  const seenSeq = new Set<number>();

  for (const event of history) {
    seenSeq.add(event.seq);
    sendWorkspaceLiveResourceEvent(socket, event);
    state.afterSeq = event.seq;
  }

  for (const event of state.bufferedEvents) {
    if (seenSeq.has(event.seq)) {
      continue;
    }

    sendWorkspaceLiveResourceEvent(socket, event);
    state.afterSeq = event.seq;
  }

  state.bufferedEvents = [];
  state.historyFlushed = true;
}

export async function registerWorkspaceLiveSocketRoutes(app: FastifyInstance) {
  app.get("/workspace/live/ws", { websocket: true }, (socket) => {
    let workspaceSyncUnsubscribe: (() => void) | null = null;
    const liveResourceSubscriptions = new Map<string, SocketSubscriptionState>();

    const ensureWorkspaceSyncSubscription = () => {
      if (workspaceSyncUnsubscribe) {
        return;
      }

      workspaceSyncUnsubscribe = app.workspaceEventHub.subscribe((event) => {
        sendWorkspaceSyncEvent(socket, event);
      });
    };

    const clearWorkspaceSyncSubscription = () => {
      workspaceSyncUnsubscribe?.();
      workspaceSyncUnsubscribe = null;
    };

    const cleanupLiveResourceSubscription = (subscriptionKey: string) => {
      const state = liveResourceSubscriptions.get(subscriptionKey);
      if (!state) {
        return;
      }

      cleanupSocketSubscription(state);
      liveResourceSubscriptions.delete(subscriptionKey);
    };

    const heartbeat = setInterval(() => {
      sendHeartbeat(socket);
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      clearWorkspaceSyncSubscription();
      for (const subscriptionKey of [...liveResourceSubscriptions.keys()]) {
        cleanupLiveResourceSubscription(subscriptionKey);
      }
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }

      let message: WorkspaceLiveSocketClientMessage;
      try {
        message = JSON.parse(data.toString()) as WorkspaceLiveSocketClientMessage;
      } catch {
        return;
      }

      for (const subscription of message.subscriptions) {
        if (subscription.type === "workspace_sync") {
          if (message.type === "subscribe") {
            ensureWorkspaceSyncSubscription();
            continue;
          }

          clearWorkspaceSyncSubscription();
          continue;
        }

        const subscriptionKey = toSubscriptionKey(subscription);
        if (message.type === "unsubscribe") {
          cleanupLiveResourceSubscription(subscriptionKey);
          continue;
        }

        cleanupLiveResourceSubscription(subscriptionKey);
        const subscriptionState: SocketSubscriptionState = {
          afterSeq: undefined,
          bufferedEvents: [],
          historyFlushed: false,
          subscription,
          unsubscribe: null,
        };
        liveResourceSubscriptions.set(subscriptionKey, subscriptionState);

        void attachLiveResourceSubscription({
          app,
          socket,
          state: subscriptionState,
        }).catch((error) => {
          sendWorkspaceLiveResourceError(socket, {
            resource: subscription.resource,
            scopeId: subscription.scopeId,
            message: error instanceof Error ? error.message : "Unable to start live resource subscription",
          });
          cleanupLiveResourceSubscription(subscriptionKey);
        });
      }
    });

    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}
