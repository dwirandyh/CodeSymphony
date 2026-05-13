import { z } from "zod";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  CreateAutomationInputSchema,
  UpdateAutomationInputSchema,
  type ChatEventType,
} from "@codesymphony/shared-types";
import type { RuntimeEventHub, WorkspaceSyncEventHub } from "../types.js";
import { buildAutomationBranchName } from "./worktreeService.js";
type AutomationCreateInput = z.infer<typeof CreateAutomationInputSchema>;
type AutomationUpdateInput = z.infer<typeof UpdateAutomationInputSchema>;

type ParsedRrule = {
  freq: "DAILY" | "WEEKLY" | "HOURLY";
  byHour: number;
  byMinute: number;
  byDay: string[] | null;
};

type AutomationRecord = Awaited<ReturnType<PrismaClient["automation"]["findUnique"]>>;
type AutomationRunRecord = {
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
};

type AutomationWithLatestRun = NonNullable<Awaited<ReturnType<PrismaClient["automation"]["findMany"]>>[number]> & {
  runs: AutomationRunRecord[];
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

type WorktreeServiceAdapter = {
  create: (repositoryId: string, input?: Record<string, unknown>) => Promise<{
    worktree: {
      id: string;
    };
  }>;
  waitUntilReady: (worktreeId: string) => Promise<{
    id: string;
  }>;
};

type ThreadRunBinding = {
  runId: string;
  automationId: string;
  repositoryId: string;
  worktreeId: string;
  threadId: string;
  unsubscribe: () => void;
};

const AUTOMATION_PERMISSION_MODE = "full_access" as const;
const ACTIVE_AUTOMATION_RUN_STATUSES = ["queued", "dispatching", "running", "waiting_input"] as const;
const AUTOMATION_BRANCH_CREATE_ATTEMPTS = 50;
const AUTOMATION_CATCH_UP_GRACE_MS = 90_000;
const AUTOMATION_DUE_OCCURRENCE_LIMIT = 100_000;
const MISSED_DUE_TO_RUNTIME_SUMMARY = "Missed while the local automation runtime was unavailable. A newer slot will be replayed.";
const MISSED_DUE_TO_ACTIVE_RUN_SUMMARY = "Missed because another automation run was still active at the scheduled time.";

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

function canRetryAutomationWorktreeCreate(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "Branch already has a worktree in this repository"
    || error.message.startsWith("Worktree path already exists:");
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

function computeNextScheduledSlot(rrule: string, timezone: string, scheduledFor: Date): Date {
  return computeNextRunAt(rrule, timezone, new Date(scheduledFor.getTime() + 1_000));
}

function collectDueOccurrences(input: {
  rrule: string;
  timezone: string;
  nextRunAt: Date;
}, now: Date): {
  dueScheduledFor: Date[];
  nextRunAt: Date;
} {
  const dueScheduledFor: Date[] = [];
  let cursor = input.nextRunAt;

  for (let count = 0; cursor <= now; count += 1) {
    if (count >= AUTOMATION_DUE_OCCURRENCE_LIMIT) {
      throw new Error("Automation schedule reconciliation exceeded the safety limit");
    }

    dueScheduledFor.push(cursor);
    cursor = computeNextScheduledSlot(input.rrule, input.timezone, cursor);
  }

  return {
    dueScheduledFor,
    nextRunAt: cursor,
  };
}

function shouldDispatchAsCatchUp(dueScheduledFor: Date[], now: Date): boolean {
  if (dueScheduledFor.length === 0) {
    return false;
  }

  if (dueScheduledFor.length > 1) {
    return true;
  }

  return now.getTime() - dueScheduledFor[0].getTime() > AUTOMATION_CATCH_UP_GRACE_MS;
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
  targetMode: "repo_root" | "worktree";
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
    permissionMode: AUTOMATION_PERMISSION_MODE,
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
  worktreeService: WorktreeServiceAdapter;
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
    run: AutomationRunRecord,
  ) {
    async function ensureAutomationWorktree(currentRun: AutomationRunRecord): Promise<AutomationRunRecord> {
      if (automation.targetMode !== "worktree" || currentRun.worktreeId !== automation.targetWorktreeId) {
        return currentRun;
      }

      const branchBase = buildAutomationBranchName(automation.name);

      for (let attempt = 0; attempt < AUTOMATION_BRANCH_CREATE_ATTEMPTS; attempt += 1) {
        const branch = attempt === 0 ? branchBase : `${branchBase}-${attempt + 1}`;

        try {
          const created = await deps.worktreeService.create(automation.repositoryId, {
            branch,
            ensureInitialThread: false,
            isAutomation: true,
          });

          const updatedRun = await deps.prisma.automationRun.update({
            where: { id: currentRun.id },
            data: {
              worktreeId: created.worktree.id,
            },
          });
          emitRepositoryRefresh(updatedRun.repositoryId, updatedRun.worktreeId, updatedRun.threadId);
          return updatedRun;
        } catch (error) {
          if (canRetryAutomationWorktreeCreate(error)) {
            continue;
          }
          throw error;
        }
      }

      throw new Error("Unable to allocate an automation worktree branch name");
    }

    try {
      let currentRun = run;
      if (currentRun.status !== "dispatching" || currentRun.startedAt === null) {
        currentRun = await deps.prisma.automationRun.update({
          where: { id: currentRun.id },
          data: {
            status: "dispatching",
            startedAt: currentRun.startedAt ?? new Date(),
          },
        });
        emitRepositoryRefresh(currentRun.repositoryId, currentRun.worktreeId, currentRun.threadId);
      }

      currentRun = await ensureAutomationWorktree(currentRun);

      if (automation.targetMode === "worktree") {
        await deps.worktreeService.waitUntilReady(currentRun.worktreeId);
      }

      const thread = await deps.chatService.createThread(currentRun.worktreeId, {
        title: automation.name,
        isAutomation: true,
        agent: automation.agent,
        model: automation.model,
        modelProviderId: automation.modelProviderId,
        permissionMode: AUTOMATION_PERMISSION_MODE,
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
        worktreeId: currentRun.worktreeId,
        threadId: thread.id,
      });

      const updatedRun = await deps.prisma.automationRun.update({
        where: { id: currentRun.id },
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

  async function createAutomationRunRecord(
    tx: Prisma.TransactionClient,
    automation: NonNullable<AutomationRecord>,
    input: {
      status: "queued" | "missed";
      triggerKind: "manual" | "schedule" | "catch_up";
      scheduledFor: Date;
      finishedAt?: Date | null;
      error?: string | null;
      summary?: string | null;
    },
  ): Promise<AutomationRunRecord> {
    return tx.automationRun.create({
      data: {
        automationId: automation.id,
        repositoryId: automation.repositoryId,
        worktreeId: automation.targetWorktreeId,
        status: input.status,
        triggerKind: input.triggerKind,
        scheduledFor: input.scheduledFor,
        startedAt: null,
        finishedAt: input.finishedAt ?? null,
        error: input.error ?? null,
        summary: input.summary ?? null,
      },
    });
  }

  async function createRunAndDispatch(
    automation: NonNullable<AutomationRecord>,
    input: {
      triggerKind: "manual" | "schedule" | "catch_up";
      scheduledFor: Date;
    },
  ) {
    const createdRun = await deps.prisma.$transaction((tx) => (
      createAutomationRunRecord(tx, automation, {
        status: "queued",
        triggerKind: input.triggerKind,
        scheduledFor: input.scheduledFor,
      })
    ));

    emitRepositoryRefresh(createdRun.repositoryId, createdRun.worktreeId, createdRun.threadId);
    return dispatchAutomationRun(automation, createdRun);
  }

  async function claimDueRunBatch(
    automation: NonNullable<AutomationRecord>,
    now: Date,
  ): Promise<{
    runToDispatch: AutomationRunRecord | null;
    shouldRefresh: boolean;
  }> {
    const { dueScheduledFor, nextRunAt } = collectDueOccurrences({
      rrule: automation.rrule,
      timezone: automation.timezone,
      nextRunAt: automation.nextRunAt,
    }, now);

    if (dueScheduledFor.length === 0) {
      return {
        runToDispatch: null,
        shouldRefresh: false,
      };
    }

    const result = await deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.automation.updateMany({
        where: {
          id: automation.id,
          enabled: true,
          nextRunAt: automation.nextRunAt,
        },
        data: {
          nextRunAt,
        },
      });

      if (claimed.count !== 1) {
        return null;
      }

      const activeRun = await tx.automationRun.findFirst({
        where: {
          automationId: automation.id,
          status: {
            in: [...ACTIVE_AUTOMATION_RUN_STATUSES],
          },
        },
        orderBy: [
          { createdAt: "desc" },
          { scheduledFor: "desc" },
        ],
      });

      const catchUpRun = !activeRun && shouldDispatchAsCatchUp(dueScheduledFor, now);
      const missedScheduledFor = activeRun
        ? dueScheduledFor
        : catchUpRun
          ? dueScheduledFor.slice(0, -1)
          : [];

      for (const scheduledFor of missedScheduledFor) {
        await createAutomationRunRecord(tx, automation, {
          status: "missed",
          triggerKind: "schedule",
          scheduledFor,
          finishedAt: now,
          summary: activeRun ? MISSED_DUE_TO_ACTIVE_RUN_SUMMARY : MISSED_DUE_TO_RUNTIME_SUMMARY,
        });
      }

      if (activeRun) {
        return {
          runToDispatch: null,
          shouldRefresh: missedScheduledFor.length > 0,
        };
      }

      const latestScheduledFor = dueScheduledFor[dueScheduledFor.length - 1];
      if (!latestScheduledFor) {
        return {
          runToDispatch: null,
          shouldRefresh: missedScheduledFor.length > 0,
        };
      }

      const runToDispatch = await createAutomationRunRecord(tx, automation, {
        status: "queued",
        triggerKind: catchUpRun ? "catch_up" : "schedule",
        scheduledFor: latestScheduledFor,
      });

      return {
        runToDispatch,
        shouldRefresh: true,
      };
    });

    return result ?? {
      runToDispatch: null,
      shouldRefresh: false,
    };
  }

  async function findActiveRun(automationId: string) {
    return deps.prisma.automationRun.findFirst({
      where: {
        automationId,
        status: {
          in: [...ACTIVE_AUTOMATION_RUN_STATUSES],
        },
      },
      orderBy: [
        { createdAt: "desc" },
        { scheduledFor: "desc" },
      ],
    });
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
          targetMode: input.targetMode,
          name: input.name,
          prompt: input.prompt,
          agent: input.agent,
          model: input.model,
          modelProviderId: input.modelProviderId ?? null,
          permissionMode: AUTOMATION_PERMISSION_MODE,
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
          ...(input.targetMode ? { targetMode: input.targetMode } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelProviderId !== undefined ? { modelProviderId: input.modelProviderId } : {}),
          permissionMode: AUTOMATION_PERMISSION_MODE,
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

      const activeRun = await findActiveRun(automationId);
      if (activeRun) {
        throw new Error("Automation already has an active run");
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

        const { runToDispatch, shouldRefresh } = await claimDueRunBatch(dueAutomation, now);
        if (!runToDispatch && !shouldRefresh) {
          continue;
        }
        if (shouldRefresh) {
          emitRepositoryRefresh(dueAutomation.repositoryId, dueAutomation.targetWorktreeId);
        }

        if (!runToDispatch) {
          continue;
        }

        await dispatchAutomationRun(dueAutomation, runToDispatch);
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
            in: ["queued", "dispatching", "running", "waiting_input"],
          },
        },
      });

      let recovered = 0;
      for (const run of activeRuns) {
        if (run.threadId) {
          subscribeToThreadLifecycle({
            id: run.id,
            automationId: run.automationId,
            repositoryId: run.repositoryId,
            worktreeId: run.worktreeId,
            threadId: run.threadId,
          });
          recovered += 1;
          continue;
        }

        const automation = await deps.prisma.automation.findUnique({
          where: { id: run.automationId },
        });
        if (!automation) {
          continue;
        }

        await dispatchAutomationRun(automation, run);
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
