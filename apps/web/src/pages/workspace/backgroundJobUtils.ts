import type { ChatEvent } from "@codesymphony/shared-types";
import { isRecord, payloadStringOrNull } from "./eventUtils";

export type BackgroundJobKind = "monitor";

export type ActiveBackgroundJob = {
  id: string;
  toolUseId: string;
  kind: BackgroundJobKind;
  label: string;
  status: "running";
  elapsedSeconds: number | null;
  startIdx: number;
  createdAt: string;
};

function normalizedToolName(payload: Record<string, unknown>): string {
  const toolName = payloadStringOrNull(payload.toolName);
  return toolName?.trim().toLowerCase() ?? "";
}

function isMonitorPayload(payload: Record<string, unknown>): boolean {
  return normalizedToolName(payload) === "monitor";
}

function isMonitorLifecycleEvent(event: ChatEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
    return false;
  }
  if (!isRecord(event.payload)) {
    return false;
  }
  return isMonitorPayload(event.payload);
}

function labelFromPayload(payload: Record<string, unknown>): string {
  const direct = payloadStringOrNull(payload.description);
  if (direct) {
    return direct;
  }
  const toolInput = isRecord(payload.toolInput) ? payload.toolInput : null;
  const fromInput = toolInput ? payloadStringOrNull(toolInput.description) : null;
  if (fromInput) {
    return fromInput;
  }
  const command = payloadStringOrNull(payload.command)
    ?? (toolInput ? payloadStringOrNull(toolInput.command) : null);
  if (command) {
    return command;
  }
  return "Monitoring";
}

export function extractActiveBackgroundJobs(events: ChatEvent[]): ActiveBackgroundJob[] {
  const ordered = [...events].sort((a, b) => a.idx - b.idx);
  const finishedToolUseIds = new Set<string>();
  const byToolUseId = new Map<string, ActiveBackgroundJob>();

  for (const event of ordered) {
    if (event.type === "tool.finished" && isRecord(event.payload)) {
      const preceding = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
      for (const toolUseId of preceding) {
        finishedToolUseIds.add(toolUseId);
      }
      continue;
    }

    if (!isMonitorLifecycleEvent(event) || !isRecord(event.payload)) {
      continue;
    }

    const toolUseId = payloadStringOrNull(event.payload.toolUseId);
    if (!toolUseId || finishedToolUseIds.has(toolUseId)) {
      continue;
    }

    const existing = byToolUseId.get(toolUseId);
    if (event.type === "tool.output") {
      const elapsed = Number(event.payload.elapsedTimeSeconds ?? 0);
      const elapsedSeconds = Number.isFinite(elapsed) && elapsed > 0
        ? Math.max(existing?.elapsedSeconds ?? 0, elapsed)
        : (existing?.elapsedSeconds ?? null);
      const base = existing ?? {
        id: `background:${toolUseId}`,
        toolUseId,
        kind: "monitor" as const,
        label: labelFromPayload(event.payload),
        status: "running" as const,
        elapsedSeconds: null,
        startIdx: event.idx,
        createdAt: event.createdAt,
      };
      byToolUseId.set(toolUseId, { ...base, elapsedSeconds });
      continue;
    }

    if (event.type === "tool.started") {
      const created: ActiveBackgroundJob = {
        id: `background:${toolUseId}`,
        toolUseId,
        kind: "monitor",
        label: labelFromPayload(event.payload),
        status: "running",
        elapsedSeconds: existing?.elapsedSeconds ?? null,
        startIdx: Math.min(existing?.startIdx ?? event.idx, event.idx),
        createdAt: existing?.createdAt ?? event.createdAt,
      };
      byToolUseId.set(toolUseId, created);
    }
  }

  return [...byToolUseId.values()]
    .filter((job) => !finishedToolUseIds.has(job.toolUseId))
    .sort((a, b) => a.startIdx - b.startIdx);
}