import type { Prisma, RunEvent as DbRunEvent, RunEventType as DbRunEventType } from "@prisma/client";
import type { RunEvent, RunEventType } from "@codesymphony/shared-types";
import type { RuntimeEventHub } from "../types";
import type { PrismaClient } from "@prisma/client";

const typeToDb: Record<RunEventType, DbRunEventType> = {
  "run.status_changed": "run_status_changed",
  "run.completed": "run_completed",
  "run.failed": "run_failed",
  "step.started": "step_started",
  "step.log": "step_log",
  "step.completed": "step_completed",
  "approval.requested": "approval_requested",
  "approval.decided": "approval_decided",
};

const typeFromDb: Record<DbRunEventType, RunEventType> = {
  run_status_changed: "run.status_changed",
  run_completed: "run.completed",
  run_failed: "run.failed",
  step_started: "step.started",
  step_log: "step.log",
  step_completed: "step.completed",
  approval_requested: "approval.requested",
  approval_decided: "approval.decided",
};

function mapDbEvent(event: DbRunEvent): RunEvent {
  return {
    id: event.id,
    runId: event.runId,
    idx: event.idx,
    type: typeFromDb[event.type],
    payload: event.payload as Record<string, unknown>,
    createdAt: event.createdAt.toISOString(),
  };
}

type ListenerMap = Map<string, Set<(event: RunEvent) => void>>;

export function createEventHub(prisma: PrismaClient): RuntimeEventHub {
  const listeners: ListenerMap = new Map();

  async function nextIdx(tx: Prisma.TransactionClient, runId: string): Promise<number> {
    const result = await tx.runEvent.aggregate({
      where: { runId },
      _max: { idx: true },
    });

    return (result._max.idx ?? -1) + 1;
  }

  async function emit(runId: string, type: RunEventType, payload: Record<string, unknown>): Promise<RunEvent> {
    const dbEvent = await prisma.$transaction(async (tx) => {
      const idx = await nextIdx(tx, runId);
      return tx.runEvent.create({
        data: {
          runId,
          idx,
          type: typeToDb[type],
          payload: payload as Prisma.InputJsonValue,
        },
      });
    });

    const event = mapDbEvent(dbEvent);
    const runListeners = listeners.get(runId);
    runListeners?.forEach((listener) => listener(event));

    return event;
  }

  async function list(runId: string, afterIdx?: number): Promise<RunEvent[]> {
    const dbEvents = await prisma.runEvent.findMany({
      where: {
        runId,
        ...(typeof afterIdx === "number" ? { idx: { gt: afterIdx } } : {}),
      },
      orderBy: { idx: "asc" },
    });

    return dbEvents.map(mapDbEvent);
  }

  function subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    if (!listeners.has(runId)) {
      listeners.set(runId, new Set());
    }

    const runListeners = listeners.get(runId)!;
    runListeners.add(listener);

    return () => {
      runListeners.delete(listener);
      if (runListeners.size === 0) {
        listeners.delete(runId);
      }
    };
  }

  return {
    emit,
    list,
    subscribe,
  };
}
