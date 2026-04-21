import { Prisma } from "@prisma/client";
import type { ChatEvent as DbChatEvent, ChatEventType as DbChatEventType, PrismaClient } from "@prisma/client";
import type { ChatEvent, ChatEventType } from "@codesymphony/shared-types";
import type { RuntimeEventHub } from "../types.js";

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
    payload: event.payload as Record<string, unknown>,
    createdAt: event.createdAt.toISOString(),
  };
}


type ListenerMap = Map<string, Set<(event: ChatEvent) => void>>;

export function createEventHub(prisma: PrismaClient): RuntimeEventHub {
  const listeners: ListenerMap = new Map();

  // Per-thread serial queue to prevent concurrent nextIdx collisions (P2002)
  const threadQueues = new Map<string, Promise<unknown>>();

  function enqueueForThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = threadQueues.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    threadQueues.set(threadId, next);
    next.then(
      () => { if (threadQueues.get(threadId) === next) threadQueues.delete(threadId); },
      () => { if (threadQueues.get(threadId) === next) threadQueues.delete(threadId); },
    );
    return next;
  }

  async function nextIdx(tx: Prisma.TransactionClient, threadId: string): Promise<number> {
    const result = await tx.chatEvent.aggregate({
      where: { threadId },
      _max: { idx: true },
    });

    return (result._max.idx ?? -1) + 1;
  }

  async function emit(threadId: string, type: ChatEventType, payload: Record<string, unknown>): Promise<ChatEvent> {
    return enqueueForThread(threadId, async () => {
      const dbEvent = await prisma.$transaction(async (tx) => {
        const idx = await nextIdx(tx, threadId);
        return tx.chatEvent.create({
          data: {
            threadId,
            idx,
            type: typeToDb[type],
            payload: payload as Prisma.InputJsonValue,
          },
        });
      });

      const event = mapDbEvent(dbEvent);
      if (!event) {
        throw new Error(`Failed to map chat event type: ${dbEvent.type}`);
      }
      const threadListeners = listeners.get(threadId);
      threadListeners?.forEach((listener) => listener(event));

      return event;
    });
  }

  async function list(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
    try {
      const dbEvents = await prisma.chatEvent.findMany({
        where: {
          threadId,
          ...(typeof afterIdx === "number" ? { idx: { gt: afterIdx } } : {}),
        },
        orderBy: { idx: "asc" },
      });

      return dbEvents.flatMap((event) => {
        const mapped = mapDbEvent(event);
        return mapped ? [mapped] : [];
      });
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
