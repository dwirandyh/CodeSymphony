import { randomUUID } from "node:crypto";
import prismaClientPkg from "@prisma/client";
import type {
  ChatEvent as DbChatEvent,
  ChatEventType as DbChatEventType,
  Prisma as PrismaNamespace,
  PrismaClient,
} from "@prisma/client";
import type { ChatEvent, ChatEventType } from "@codesymphony/shared-types";
import type { RuntimeEventHub } from "../types.js";
import { listPersistedChatEventRows } from "../services/chat/chatEventQuery.js";
import { normalizeChatEventPayload } from "../services/chat/chatEventPayloadNormalization.js";

const { Prisma } = prismaClientPkg as { Prisma: typeof import("@prisma/client").Prisma };

const typeToDb: Record<ChatEventType, DbChatEventType> = {
  "message.delta": "message_delta",
  "tool.started": "tool_started",
  "tool.output": "tool_output",
  "tool.finished": "tool_finished",
  "permission.requested": "permission_requested",
  "permission.resolved": "permission_resolved",
  "question.requested": "question_requested",
  "question.answered": "question_answered",
  "question.dismissed": "question_dismissed",
  "plan.created": "plan_created",
  "todo.updated": "todo_updated",
  "plan.approved": "plan_approved",
  "plan.dismissed": "plan_dismissed",
  "plan.revision_requested": "plan_revision_requested",
  "subagent.started": "subagent_started",
  "subagent.finished": "subagent_finished",
  "chat.completed": "chat_completed",
  "chat.failed": "chat_failed",
};

const typeFromDb: Partial<Record<DbChatEventType, ChatEventType>> = {
  message_delta: "message.delta",
  tool_started: "tool.started",
  tool_output: "tool.output",
  tool_finished: "tool.finished",
  permission_requested: "permission.requested",
  permission_resolved: "permission.resolved",
  question_requested: "question.requested",
  question_answered: "question.answered",
  question_dismissed: "question.dismissed",
  plan_created: "plan.created",
  todo_updated: "todo.updated",
  plan_approved: "plan.approved",
  plan_dismissed: "plan.dismissed",
  plan_revision_requested: "plan.revision_requested",
  subagent_started: "subagent.started",
  subagent_finished: "subagent.finished",
  chat_completed: "chat.completed",
  chat_failed: "chat.failed",
};

function mapDbEvent(event: DbChatEvent): ChatEvent | null {
  const type = typeFromDb[event.type];
  if (!type) {
    return null;
  }

  return {
    id: event.id,
    threadId: event.threadId,
    idx: event.idx,
    type,
    payload: normalizeChatEventPayload(type, event.payload),
    createdAt: event.createdAt.toISOString(),
  };
}


type ListenerMap = Map<string, Set<(event: ChatEvent) => void>>;
type ThreadState = {
  nextIdx: number | null;
  nextIdxPromise: Promise<number> | null;
};

export function createEventHub(prisma: PrismaClient): RuntimeEventHub {
  const listeners: ListenerMap = new Map();
  const threadStates = new Map<string, ThreadState>();

  // Per-thread serial queue for idx allocation + listener delivery.
  const dispatchQueues = new Map<string, Promise<unknown>>();
  function enqueueForThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = dispatchQueues.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    dispatchQueues.set(threadId, next);
    next.then(
      () => { if (dispatchQueues.get(threadId) === next) dispatchQueues.delete(threadId); },
      () => { if (dispatchQueues.get(threadId) === next) dispatchQueues.delete(threadId); },
    );
    return next;
  }

  function getThreadState(threadId: string): ThreadState {
    let state = threadStates.get(threadId);
    if (!state) {
      state = {
        nextIdx: null,
        nextIdxPromise: null,
      };
      threadStates.set(threadId, state);
    }
    return state;
  }

  async function resolveInitialNextIdx(threadId: string): Promise<number> {
    const result = await prisma.chatEvent.aggregate({
      where: { threadId },
      _max: { idx: true },
    });
    return (result._max.idx ?? -1) + 1;
  }

  async function allocateNextIdx(threadId: string): Promise<number> {
    const state = getThreadState(threadId);
    if (state.nextIdx === null) {
      state.nextIdxPromise ??= resolveInitialNextIdx(threadId).then((nextIdx) => {
        state.nextIdx = nextIdx;
        return nextIdx;
      }).finally(() => {
        state.nextIdxPromise = null;
      });
      await state.nextIdxPromise;
    }

    const idx = state.nextIdx ?? 0;
    state.nextIdx = idx + 1;
    return idx;
  }

  function isThreadIdxCollision(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      return false;
    }

    const target = error.meta?.target;
    return Array.isArray(target) && target.includes("threadId") && target.includes("idx");
  }

  async function persistEvent(threadId: string, event: ChatEvent): Promise<void> {
    await prisma.chatEvent.create({
      data: {
        id: event.id,
        threadId,
        idx: event.idx,
        type: typeToDb[event.type],
        payload: event.payload as PrismaNamespace.InputJsonValue,
        createdAt: new Date(event.createdAt),
      },
    });
  }

  async function persistEventWithIdxRetry(threadId: string, event: ChatEvent): Promise<void> {
    const state = getThreadState(threadId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await persistEvent(threadId, event);
        return;
      } catch (error) {
        if (!isThreadIdxCollision(error)) {
          throw error;
        }

        const nextIdx = await resolveInitialNextIdx(threadId);
        state.nextIdx = nextIdx + 1;
        event.idx = nextIdx;
      }
    }

    await persistEvent(threadId, event);
  }

  async function emit(threadId: string, type: ChatEventType, payload: Record<string, unknown>): Promise<ChatEvent> {
    return enqueueForThread(threadId, async () => {
      const idx = await allocateNextIdx(threadId);
      const event: ChatEvent = {
        id: randomUUID(),
        threadId,
        idx,
        type,
        payload,
        createdAt: new Date().toISOString(),
      };

      await persistEventWithIdxRetry(threadId, event);

      const threadListeners = listeners.get(threadId);
      threadListeners?.forEach((listener) => listener(event));
      return event;
    });
  }

  async function list(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
    try {
      const dbEvents = await listPersistedChatEventRows(prisma, threadId, afterIdx);

      const mappedDbEvents = dbEvents.flatMap((event) => {
        const mapped = mapDbEvent(event);
        return mapped ? [mapped] : [];
      });

      return mappedDbEvents;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        return [];
      }
      throw error;
    }
  }

  function subscribe(threadId: string, listener: (event: ChatEvent) => void): () => void {
    if (!listeners.has(threadId)) {
      listeners.set(threadId, new Set());
    }

    const threadListeners = listeners.get(threadId)!;
    threadListeners.add(listener);

    return () => {
      threadListeners.delete(listener);
      if (threadListeners.size === 0) {
        listeners.delete(threadId);
      }
    };
  }

  return {
    emit,
    list,
    subscribe,
  };
}
