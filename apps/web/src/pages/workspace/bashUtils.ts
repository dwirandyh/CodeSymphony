import type { ChatEvent } from "@codesymphony/shared-types";
import { isBashPayload, isBashToolEvent, payloadStringOrNull } from "./eventUtils";
import type { BashRun } from "./types";

export function extractBashRuns(context: ChatEvent[]): BashRun[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const byToolUseId = new Map<string, BashRun>();
  const knownBashToolUseIds = new Set<string>();
  const hasBashToolLifecycleEvents = ordered.some((event) => isBashToolEvent(event));
  const permissionRequestById = new Map<
    string,
    { idx: number; createdAt: string; command: string | null; eventId: string }
  >();

  function ensureRun(toolUseId: string, event: ChatEvent): BashRun {
    const existing = byToolUseId.get(toolUseId);
    if (existing) {
      existing.anchorIdx = Math.min(existing.anchorIdx, event.idx);
      existing.eventIds.add(event.id);
      return existing;
    }

    const created: BashRun = {
      id: `bash:${toolUseId}`,
      toolUseId,
      startIdx: event.idx,
      anchorIdx: event.idx,
      summary: null,
      command: payloadStringOrNull(event.payload.command),
      output: null,
      error: null,
      truncated: false,
      durationSeconds: null,
      status: "running",
      rejectedByUser: false,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    };
    byToolUseId.set(toolUseId, created);
    return created;
  }

  for (const event of ordered) {
    if ((event.type === "tool.started" || event.type === "tool.output") && isBashToolEvent(event)) {
      const toolUseId = payloadStringOrNull(event.payload.toolUseId);
      if (!toolUseId) {
        continue;
      }
      knownBashToolUseIds.add(toolUseId);
      const run = ensureRun(toolUseId, event);
      run.startIdx = Math.min(run.startIdx, event.idx);
      run.command = run.command ?? payloadStringOrNull(event.payload.command);
      if (event.type === "tool.output") {
        const elapsed = Number(event.payload.elapsedTimeSeconds ?? 0);
        if (Number.isFinite(elapsed) && elapsed > 0) {
          run.durationSeconds = Math.max(run.durationSeconds ?? 0, elapsed);
        }
      }
      continue;
    }

    if (event.type !== "tool.finished") {
      continue;
    }

    const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
      ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];

    const bashToolUseIds = precedingToolUseIds.length > 0
      ? precedingToolUseIds.filter((toolUseId) => knownBashToolUseIds.has(toolUseId) || byToolUseId.has(toolUseId))
      : isBashToolEvent(event)
        ? [`event:${event.id}`]
        : [];

    for (const toolUseId of bashToolUseIds) {
      const run = ensureRun(toolUseId, event);
      run.summary = payloadStringOrNull(event.payload.summary);
      run.command = run.command ?? payloadStringOrNull(event.payload.command);
      run.output = payloadStringOrNull(event.payload.output);
      run.error = payloadStringOrNull(event.payload.error);
      run.truncated = event.payload.truncated === true;
      run.status = run.error ? "failed" : "success";
      if (run.durationSeconds == null) {
        const startedAt = Date.parse(run.createdAt);
        const finishedAt = Date.parse(event.createdAt);
        if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt) {
          run.durationSeconds = (finishedAt - startedAt) / 1000;
        }
      }
      run.eventIds.add(event.id);
    }
  }

  for (const event of ordered) {
    if (event.type === "permission.requested") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      const toolName = payloadStringOrNull(event.payload.toolName);
      if (!requestId || !toolName || toolName.toLowerCase() !== "bash") {
        continue;
      }

      const command = payloadStringOrNull(event.payload.command);
      permissionRequestById.set(requestId, {
        idx: event.idx,
        createdAt: event.createdAt,
        command,
        eventId: event.id,
      });

      if (!hasBashToolLifecycleEvents) {
        const run = ensureRun(`permission:${requestId}`, event);
        run.summary = "Awaiting approval";
        run.command = run.command ?? command;
      }
      continue;
    }

    if (event.type !== "permission.resolved") {
      continue;
    }

    const requestId = payloadStringOrNull(event.payload.requestId);
    if (!requestId) {
      continue;
    }

    const decision = payloadStringOrNull(event.payload.decision);
    const message = payloadStringOrNull(event.payload.message);
    const key = `permission:${requestId}`;
    const requestMeta = permissionRequestById.get(requestId);
    let run = byToolUseId.get(key);
    if (!run && decision === "deny" && requestMeta) {
      run = ensureRun(key, event);
      run.startIdx = Math.min(run.startIdx, requestMeta.idx);
      run.anchorIdx = Math.min(run.anchorIdx, requestMeta.idx);
      run.createdAt = requestMeta.createdAt;
      run.command = run.command ?? requestMeta.command;
      run.eventIds.add(requestMeta.eventId);
    }

    if (!run) {
      continue;
    }

    run.summary = message ?? run.summary;
    run.eventIds.add(event.id);
    if (run.durationSeconds == null) {
      const startedAt = Date.parse(run.createdAt);
      const finishedAt = Date.parse(event.createdAt);
      if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt) {
        run.durationSeconds = (finishedAt - startedAt) / 1000;
      }
    }

    if (decision === "deny") {
      run.status = "failed";
      run.rejectedByUser = true;
      run.error = message ?? "Rejected by user";
      if (!run.summary) {
        run.summary = "Rejected by user";
      }
    } else if (decision === "allow" || decision === "allow_always") {
      run.status = "success";
      run.rejectedByUser = false;
    }
  }

  const result = Array.from(byToolUseId.values()).sort((a, b) => a.startIdx - b.startIdx);
  return result;
}
