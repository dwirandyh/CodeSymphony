import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  CreateAutomationInputSchema,
  UpdateAutomationInputSchema,
  type ChatEventType,
} from "@codesymphony/shared-types";
import type { RuntimeEventHub, WorkspaceSyncEventHub } from "../types.js";
type AutomationCreateInput = z.infer<typeof CreateAutomationInputSchema>;
type AutomationUpdateInput = z.infer<typeof UpdateAutomationInputSchema>;

type ParsedRrule = {
  freq: "DAILY" | "WEEKLY" | "HOURLY";
  byHour: number;
  byMinute: number;
  byDay: string[] | null;
};

type AutomationRecord = Awaited<ReturnType<PrismaClient["automation"]["findUnique"]>>;

type AutomationWithLatestRun = NonNullable<Awaited<ReturnType<PrismaClient["automation"]["findMany"]>>[number]> & {
  runs: Array<{
    id: string;
    automationId: string;
    repositoryId: string;
    worktreeId: string;
    threadId: string | null;
    status: string;
    triggerKind: string;
    scheduledFor: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
    summary: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  _count: {
    promptVersions: number;
  };
};

type PromptVersionRecord = {
  id: string;
  automationId: string;
  content: string;
  source: string;
  restoredFromVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ChatServiceAdapter = {
  createThread: (worktreeId: string, input?: Record<string, unknown>) => Promise<{
    id: string;
    worktreeId: string;
  }>;
  sendMessage: (threadId: string, input: Record<string, unknown>) => Promise<unknown>;
};

type ThreadRunBinding = {
  runId: string;
  automationId: string;
  repositoryId: string;
  worktreeId: string;
  threadId: string;
  unsubscribe: () => void;
};

function ensureValidTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error("Invalid IANA timezone");
  }
}

function parseRrule(input: string): ParsedRrule {
  const parts = input
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const kv = new Map<string, string>();
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) {
      throw new Error("Invalid RRULE");
    }
    kv.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = kv.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "HOURLY") {
    throw new Error("Unsupported RRULE frequency");
  }

  const byHour = Number.parseInt(kv.get("BYHOUR") ?? "0", 10);
  const byMinute = Number.parseInt(kv.get("BYMINUTE") ?? "0", 10);
  if (!Number.isInteger(byHour) || byHour < 0 || byHour > 23) {
    throw new Error("Invalid RRULE BYHOUR");
  }
  if (!Number.isInteger(byMinute) || byMinute < 0 || byMinute > 59) {
    throw new Error("Invalid RRULE BYMINUTE");
  }

  const byDay = freq === "WEEKLY"
    ? (kv.get("BYDAY") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : null;

  return {
    freq,
    byHour,
    byMinute,
    byDay: byDay && byDay.length > 0 ? byDay : null,
  };
}

function getZonedParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekdayToken = value("weekday").slice(0, 2).toUpperCase();

  return {
    year: Number.parseInt(value("year"), 10),
    month: Number.parseInt(value("month"), 10),
    day: Number.parseInt(value("day"), 10),
    hour: Number.parseInt(value("hour"), 10),
    minute: Number.parseInt(value("minute"), 10),
    second: Number.parseInt(value("second"), 10),
    weekday: weekdayToken,
  };
}

function civilDateToUtcDate(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}, timezone: string): Date {
  const baseUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
    0,
  );

  let guess = baseUtc;
  for (let idx = 0; idx < 3; idx += 1) {
    const zoned = getZonedParts(new Date(guess), timezone);
    const zonedUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      0,
    );
    const offsetMs = zonedUtc - guess;
    const adjusted = baseUtc - offsetMs;
    if (adjusted === guess) {
      break;
    }
    guess = adjusted;
  }

  return new Date(guess);
}

function localPartsToCivilDate(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): Date {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  ));
}

function civilDateToLocalParts(civilDate: Date) {
  return {
    year: civilDate.getUTCFullYear(),
    month: civilDate.getUTCMonth() + 1,
    day: civilDate.getUTCDate(),
    hour: civilDate.getUTCHours(),
    minute: civilDate.getUTCMinutes(),
    second: civilDate.getUTCSeconds(),
    weekday: ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][civilDate.getUTCDay()] ?? "SU",
  };
}

function computeNextRunAt(rrule: string, timezone: string, now: Date): Date {
  const parsed = parseRrule(rrule);
  const nowLocal = localPartsToCivilDate(getZonedParts(now, timezone));

  if (parsed.freq === "HOURLY") {
    const candidateLocal = new Date(nowLocal);
    candidateLocal.setUTCMinutes(parsed.byMinute, 0, 0);
    let candidate = civilDateToUtcDate(civilDateToLocalParts(candidateLocal), timezone);
    if (candidate <= now) {
      candidateLocal.setUTCHours(candidateLocal.getUTCHours() + 1);
      candidateLocal.setUTCMinutes(parsed.byMinute, 0, 0);
      candidate = civilDateToUtcDate(civilDateToLocalParts(candidateLocal), timezone);
    }
    return candidate;
  }

  const candidateLocal = new Date(nowLocal);
  candidateLocal.setUTCHours(parsed.byHour, parsed.byMinute, 0, 0);

  if (parsed.freq === "DAILY") {
    let candidate = civilDateToUtcDate(civilDateToLocalParts(candidateLocal), timezone);
    if (candidate <= now) {
      candidateLocal.setUTCDate(candidateLocal.getUTCDate() + 1);
      candidate = civilDateToUtcDate(civilDateToLocalParts(candidateLocal), timezone);
    }
    return candidate;
  }

  const allowedDays = new Set(parsed.byDay ?? ["MO"]);
  while (true) {
    const parts = civilDateToLocalParts(candidateLocal);
    const candidate = civilDateToUtcDate(parts, timezone);
    if (candidate > now && allowedDays.has(parts.weekday)) {
      return candidate;
    }
    candidateLocal.setUTCDate(candidateLocal.getUTCDate() + 1);
    candidateLocal.setUTCHours(parsed.byHour, parsed.byMinute, 0, 0);
  }
}

function mapRun(run: {
  id: string;
  automationId: string;
  repositoryId: string;
  worktreeId: string;
  threadId: string | null;
  status: string;
  triggerKind: string;
  scheduledFor: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...run,
    scheduledFor: run.scheduledFor.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function mapPromptVersion(version: PromptVersionRecord) {
  return {
    ...version,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
  };
}

function mapAutomation(automation: {
  id: string;
  repositoryId: string;
  targetWorktreeId: string;
  name: string;
  prompt: string;
  agent: "claude" | "codex" | "cursor" | "opencode";
  model: string;
  modelProviderId: string | null;
  permissionMode: "default" | "full_access";
  chatMode: "default" | "plan";
  enabled: boolean;
  rrule: string;
  timezone: string;
  dtstart: Date;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  latestRun?: ReturnType<typeof mapRun> | null;
  promptVersionCount?: number;
}) {
  return {
    ...automation,
    dtstart: automation.dtstart.toISOString(),
    nextRunAt: automation.nextRunAt.toISOString(),
    lastRunAt: automation.lastRunAt?.toISOString() ?? null,
    createdAt: automation.createdAt.toISOString(),
    updatedAt: automation.updatedAt.toISOString(),
  };
}

function toAutomationSummary(automation: AutomationWithLatestRun) {
  return mapAutomation({
    ...automation,
    latestRun: automation.runs[0] ? mapRun(automation.runs[0]) : null,
    promptVersionCount: automation._count.promptVersions,
  });
}

async function readRunSummary(prisma: PrismaClient, messageId: string | null | undefined): Promise<string | null> {
  if (!messageId) {
    return null;
  }

  const message = await prisma.chatMessage.findUnique({
    where: { id: messageId },
    select: { content: true },
  });

  if (!message) {
    return null;
  }

  const content = message.content.trim();
  if (content.length === 0) {
    return null;
  }

  return content.length > 280 ? `${content.slice(0, 277)}...` : content;
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  return typeof payload.messageId === "string" && payload.messageId.trim().length > 0
    ? payload.messageId
    : null;
}

export function createAutomationService(deps: {
  prisma: PrismaClient;
  eventHub: RuntimeEventHub;
  workspaceEventHub: WorkspaceSyncEventHub;
  chatService: ChatServiceAdapter;
}) {
  const threadBindingsByRunId = new Map<string, ThreadRunBinding>();
  let schedulerTimer: ReturnType<typeof setInterval> | null = null;

  function emitRepositoryRefresh(repositoryId: string, worktreeId: string, threadId?: string | null) {
    deps.workspaceEventHub.emit("repository.updated", {
      repositoryId,
      worktreeId,
      threadId: threadId ?? null,
    });
  }

  async function findAutomationWithSummary(id: string) {
    const automation = await deps.prisma.automation.findUnique({
      where: { id },
      include: {
        runs: {
          orderBy: [
            { createdAt: "desc" },
            { scheduledFor: "desc" },
          ],
          take: 1,
        },
        _count: {
          select: {
            promptVersions: true,
          },
        },
      },
    });

    return automation ? toAutomationSummary(automation as AutomationWithLatestRun) : null;
  }

  async function assertRepositoryAndWorktree(input: {
    repositoryId: string;
    targetWorktreeId: string;
  }) {
    const repository = await deps.prisma.repository.findUnique({
      where: { id: input.repositoryId },
      select: { id: true },
    });
    if (!repository) {
      throw new Error("Repository not found");
    }

    const worktree = await deps.prisma.worktree.findUnique({
      where: { id: input.targetWorktreeId },
      select: { id: true, repositoryId: true },
    });
    if (!worktree || worktree.repositoryId !== input.repositoryId) {
      throw new Error("Target worktree not found");
    }
  }

  function clearThreadBinding(runId: string) {
    const binding = threadBindingsByRunId.get(runId);
    if (!binding) {
      return;
    }
    binding.unsubscribe();
    threadBindingsByRunId.delete(runId);
  }

  async function updateRunStatus(
    runId: string,
    input: {
      status?: "dispatching" | "running" | "waiting_input" | "succeeded" | "failed" | "canceled";
      finishedAt?: Date | null;
      error?: string | null;
      summary?: string | null;
    },
  ) {
    const updated = await deps.prisma.automationRun.update({
      where: { id: runId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
      },
    });

    emitRepositoryRefresh(updated.repositoryId, updated.worktreeId, updated.threadId);
    if (updated.status === "succeeded" || updated.status === "failed" || updated.status === "canceled") {
      clearThreadBinding(updated.id);
    }

    return updated;
  }

  function subscribeToThreadLifecycle(run: {
    id: string;
    automationId: string;
    repositoryId: string;
    worktreeId: string;
    threadId: string;
  }) {
    clearThreadBinding(run.id);

    const unsubscribe = deps.eventHub.subscribe(run.threadId, (event) => {
      void handleThreadEventForRun(run.id, event.type, event.payload as Record<string, unknown>);
    });

    threadBindingsByRunId.set(run.id, {
      runId: run.id,
      automationId: run.automationId,
      repositoryId: run.repositoryId,
      worktreeId: run.worktreeId,
      threadId: run.threadId,
      unsubscribe,
    });
  }

  async function handleThreadEventForRun(runId: string, type: ChatEventType, payload: Record<string, unknown>) {
    if (type === "permission.requested" || type === "question.requested" || type === "plan.created") {
      await updateRunStatus(runId, {
        status: "waiting_input",
      });
      return;
    }

    if (
      type === "permission.resolved"
      || type === "question.answered"
      || type === "plan.approved"
      || type === "plan.revision_requested"
      || type === "message.delta"
      || type === "tool.started"
      || type === "tool.output"
      || type === "tool.finished"
      || type === "subagent.started"
      || type === "subagent.finished"
    ) {
      await updateRunStatus(runId, {
        status: "running",
      });
      return;
    }

    if (type === "chat.completed") {
      const cancelled = payload.cancelled === true;
      const summary = await readRunSummary(deps.prisma, extractMessageId(payload));
      await updateRunStatus(runId, {
        status: cancelled ? "canceled" : "succeeded",
        finishedAt: new Date(),
        error: null,
        summary,
      });
      return;
    }

    if (type === "chat.failed") {
      await updateRunStatus(runId, {
        status: "failed",
        finishedAt: new Date(),
        error: typeof payload.message === "string" ? payload.message : "Automation run failed",
      });
    }
  }

  async function dispatchAutomationRun(
    automation: NonNullable<AutomationRecord>,
    run: {
      id: string;
      automationId: string;
      repositoryId: string;
      worktreeId: string;
      threadId: string | null;
      status: string;
      triggerKind: string;
      scheduledFor: Date;
      startedAt: Date | null;
      finishedAt: Date | null;
      error: string | null;
      summary: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ) {
    try {
      const thread = await deps.chatService.createThread(automation.targetWorktreeId, {
        title: automation.name,
        agent: automation.agent,
        model: automation.model,
        modelProviderId: automation.modelProviderId,
        permissionMode: automation.permissionMode,
        mode: automation.chatMode,
      });

      if (automation.chatMode !== "default") {
        await deps.prisma.chatThread.update({
          where: { id: thread.id },
          data: { mode: automation.chatMode },
        });
      }

      subscribeToThreadLifecycle({
        id: run.id,
        automationId: automation.id,
        repositoryId: automation.repositoryId,
        worktreeId: automation.targetWorktreeId,
        threadId: thread.id,
      });

      const updatedRun = await deps.prisma.automationRun.update({
        where: { id: run.id },
        data: {
          threadId: thread.id,
          status: "running",
        },
      });

      emitRepositoryRefresh(updatedRun.repositoryId, updatedRun.worktreeId, thread.id);

      await deps.chatService.sendMessage(thread.id, {
        content: automation.prompt,
        mode: automation.chatMode,
      });

      await deps.prisma.automation.update({
        where: { id: automation.id },
        data: {
          lastRunAt: run.scheduledFor,
        },
      });

      return mapRun(updatedRun);
    } catch (error) {
      clearThreadBinding(run.id);
      const failedRun = await deps.prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : "Unable to dispatch automation",
        },
      });
      emitRepositoryRefresh(failedRun.repositoryId, failedRun.worktreeId, failedRun.threadId);
      return mapRun(failedRun);
    }
  }

  async function createRunAndDispatch(
    automation: NonNullable<AutomationRecord>,
    input: {
      triggerKind: "manual" | "schedule";
      scheduledFor: Date;
    },
  ) {
    const createdRun = await deps.prisma.automationRun.create({
      data: {
        automationId: automation.id,
        repositoryId: automation.repositoryId,
        worktreeId: automation.targetWorktreeId,
        status: "dispatching",
        triggerKind: input.triggerKind,
        scheduledFor: input.scheduledFor,
        startedAt: input.scheduledFor,
      },
    });

    emitRepositoryRefresh(createdRun.repositoryId, createdRun.worktreeId, createdRun.threadId);
    return dispatchAutomationRun(automation, createdRun);
  }

  async function claimNextScheduledRun(
    automationId: string,
    scheduledFor: Date,
    nextRunAt: Date,
  ) {
    const result = await deps.prisma.automation.updateMany({
      where: {
        id: automationId,
        enabled: true,
        nextRunAt: scheduledFor,
      },
      data: {
        nextRunAt,
        lastRunAt: scheduledFor,
      },
    });

    return result.count === 1;
  }

  return {
    async createAutomation(rawInput: unknown) {
      const input = CreateAutomationInputSchema.parse(rawInput);
      ensureValidTimezone(input.timezone);
      parseRrule(input.rrule);
      await assertRepositoryAndWorktree(input);

      const now = new Date();
      const created = await deps.prisma.automation.create({
        data: {
          repositoryId: input.repositoryId,
          targetWorktreeId: input.targetWorktreeId,
          name: input.name,
          prompt: input.prompt,
          agent: input.agent,
          model: input.model,
          modelProviderId: input.modelProviderId ?? null,
          permissionMode: input.permissionMode,
          chatMode: input.chatMode,
          rrule: input.rrule,
          timezone: input.timezone,
          dtstart: now,
          nextRunAt: computeNextRunAt(input.rrule, input.timezone, now),
        },
      });

      await deps.prisma.automationPromptVersion.create({
        data: {
          automationId: created.id,
          content: input.prompt,
          source: "create",
        },
      });

      emitRepositoryRefresh(created.repositoryId, created.targetWorktreeId);
      return mapAutomation(created);
    },

    async listAutomations(filters?: {
      repositoryId?: string;
      enabled?: boolean;
    }) {
      const automations = await deps.prisma.automation.findMany({
        where: {
          ...(filters?.repositoryId ? { repositoryId: filters.repositoryId } : {}),
          ...(typeof filters?.enabled === "boolean" ? { enabled: filters.enabled } : {}),
        },
        include: {
          runs: {
            orderBy: [
              { createdAt: "desc" },
              { scheduledFor: "desc" },
            ],
            take: 1,
          },
          _count: {
            select: {
              promptVersions: true,
            },
          },
        },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ],
      });

      return automations.map((automation) => toAutomationSummary(automation as AutomationWithLatestRun));
    },

    async getAutomation(automationId: string) {
      return findAutomationWithSummary(automationId);
    },

    async updateAutomation(automationId: string, rawInput: unknown) {
      const input: AutomationUpdateInput = UpdateAutomationInputSchema.parse(rawInput);
      const existing = await deps.prisma.automation.findUnique({
        where: { id: automationId },
      });
      if (!existing) {
        throw new Error("Automation not found");
      }

      if (input.timezone) {
        ensureValidTimezone(input.timezone);
      }
      if (input.rrule) {
        parseRrule(input.rrule);
      }

      const nextTargetWorktreeId = input.targetWorktreeId ?? existing.targetWorktreeId;
      if (nextTargetWorktreeId !== existing.targetWorktreeId) {
        await assertRepositoryAndWorktree({
          repositoryId: existing.repositoryId,
          targetWorktreeId: nextTargetWorktreeId,
        });
      }

      const nextRrule = input.rrule ?? existing.rrule;
      const nextTimezone = input.timezone ?? existing.timezone;
      const nextEnabled = input.enabled ?? existing.enabled;
      const updated = await deps.prisma.automation.update({
        where: { id: automationId },
        data: {
          ...(input.targetWorktreeId ? { targetWorktreeId: input.targetWorktreeId } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelProviderId !== undefined ? { modelProviderId: input.modelProviderId } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.chatMode ? { chatMode: input.chatMode } : {}),
          ...(input.rrule ? { rrule: input.rrule } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(nextEnabled
            ? { nextRunAt: computeNextRunAt(nextRrule, nextTimezone, new Date()) }
            : {}),
        },
      });

      if (input.prompt && input.prompt !== existing.prompt) {
        await deps.prisma.automationPromptVersion.create({
          data: {
            automationId,
            content: input.prompt,
            source: "update",
          },
        });
      }

      emitRepositoryRefresh(updated.repositoryId, updated.targetWorktreeId);
      return findAutomationWithSummary(updated.id);
    },

    async deleteAutomation(automationId: string) {
      const automation = await deps.prisma.automation.findUnique({
        where: { id: automationId },
      });
      if (!automation) {
        return;
      }

      await deps.prisma.automation.delete({
        where: { id: automationId },
      });
      emitRepositoryRefresh(automation.repositoryId, automation.targetWorktreeId);
    },

    async setAutomationEnabled(automationId: string, enabled: boolean) {
      const existing = await deps.prisma.automation.findUnique({
        where: { id: automationId },
      });
      if (!existing) {
        throw new Error("Automation not found");
      }

      const updated = await deps.prisma.automation.update({
        where: { id: automationId },
        data: {
          enabled,
          ...(enabled
            ? {
              nextRunAt: computeNextRunAt(existing.rrule, existing.timezone, new Date()),
            }
            : {}),
        },
      });

      emitRepositoryRefresh(updated.repositoryId, updated.targetWorktreeId);
      return mapAutomation(updated);
    },

    async runAutomationNow(automationId: string) {
      const automation = await deps.prisma.automation.findUnique({
        where: { id: automationId },
      });
      if (!automation) {
        throw new Error("Automation not found");
      }

      return createRunAndDispatch(automation, {
        triggerKind: "manual",
        scheduledFor: new Date(),
      });
    },

    async dispatchDueAutomations(now = new Date()): Promise<number> {
      let dispatchedCount = 0;

      for (let iteration = 0; iteration < 100; iteration += 1) {
        const dueAutomation = await deps.prisma.automation.findFirst({
          where: {
            enabled: true,
            nextRunAt: { lte: now },
          },
          orderBy: {
            nextRunAt: "asc",
          },
        });

        if (!dueAutomation) {
          break;
        }

        const scheduledFor = dueAutomation.nextRunAt;
        const nextRunAt = computeNextRunAt(
          dueAutomation.rrule,
          dueAutomation.timezone,
          new Date(scheduledFor.getTime() + 1_000),
        );
        const claimed = await claimNextScheduledRun(dueAutomation.id, scheduledFor, nextRunAt);
        if (!claimed) {
          continue;
        }

        const refreshedAutomation = await deps.prisma.automation.findUnique({
          where: { id: dueAutomation.id },
        });
        if (!refreshedAutomation) {
          continue;
        }

        await createRunAndDispatch(refreshedAutomation, {
          triggerKind: "schedule",
          scheduledFor,
        });
        dispatchedCount += 1;
      }

      return dispatchedCount;
    },

    async listRuns(automationId: string) {
      const runs = await deps.prisma.automationRun.findMany({
        where: { automationId },
        orderBy: [
          { createdAt: "desc" },
          { scheduledFor: "desc" },
        ],
      });

      return runs.map(mapRun);
    },

    async listPromptVersions(automationId: string) {
      const versions = await deps.prisma.automationPromptVersion.findMany({
        where: { automationId },
        orderBy: [
          { createdAt: "desc" },
          { updatedAt: "desc" },
        ],
      });

      return versions.map(mapPromptVersion);
    },

    async restorePromptVersion(automationId: string, versionId: string) {
      const automation = await deps.prisma.automation.findUnique({
        where: { id: automationId },
      });
      if (!automation) {
        throw new Error("Automation not found");
      }

      const version = await deps.prisma.automationPromptVersion.findFirst({
        where: {
          id: versionId,
          automationId,
        },
      });
      if (!version) {
        throw new Error("Automation prompt version not found");
      }

      await deps.prisma.$transaction([
        deps.prisma.automation.update({
          where: { id: automationId },
          data: {
            prompt: version.content,
          },
        }),
        deps.prisma.automationPromptVersion.create({
          data: {
            automationId,
            content: version.content,
            source: "restore",
            restoredFromVersionId: version.id,
          },
        }),
      ]);

      emitRepositoryRefresh(automation.repositoryId, automation.targetWorktreeId);
      return findAutomationWithSummary(automationId);
    },

    async recoverInFlightRuns() {
      const activeRuns = await deps.prisma.automationRun.findMany({
        where: {
          status: {
            in: ["dispatching", "running", "waiting_input"],
          },
          threadId: {
            not: null,
          },
        },
      });

      let recovered = 0;
      for (const run of activeRuns) {
        if (!run.threadId) {
          continue;
        }

        subscribeToThreadLifecycle({
          id: run.id,
          automationId: run.automationId,
          repositoryId: run.repositoryId,
          worktreeId: run.worktreeId,
          threadId: run.threadId,
        });
        recovered += 1;
      }

      return recovered;
    },

    async tick() {
      return this.dispatchDueAutomations();
    },

    startScheduler(intervalMs = 30_000) {
      if (schedulerTimer) {
        return () => {
          if (schedulerTimer) {
            clearInterval(schedulerTimer);
            schedulerTimer = null;
          }
        };
      }

      schedulerTimer = setInterval(() => {
        void this.dispatchDueAutomations();
      }, intervalMs);

      return () => {
        if (schedulerTimer) {
          clearInterval(schedulerTimer);
          schedulerTimer = null;
        }
      };
    },

    stopScheduler() {
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
    },

    dispose() {
      for (const binding of threadBindingsByRunId.values()) {
        binding.unsubscribe();
      }
      threadBindingsByRunId.clear();

      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
    },
  };
}
