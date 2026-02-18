import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, ChatMode, ChatThread, Repository } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/Composer";
import {
  ChatMessageList,
  type ActivityTraceStep,
  type AssistantRenderHint,
  type ChatTimelineItem,
  type ExploreActivityEntry,
  type ReadFileTimelineEntry,
} from "../components/workspace/ChatMessageList";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { api } from "../lib/api";
import { logService } from "../lib/logService";
import { pushRenderDebug } from "../lib/renderDebug";

const EVENT_TYPES = [
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "chat.completed",
  "chat.failed",
] as const;

const INLINE_TOOL_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "tool.started",
  "tool.output",
  "tool.finished",
  "permission.requested",
  "permission.resolved",
  "question.requested",
  "question.answered",
  "plan.created",
  "plan.approved",
  "plan.revision_requested",
  "chat.failed",
]);
const MAX_ORDER_INDEX = Number.MAX_SAFE_INTEGER;
const READ_TOOL_PATTERN = /\b(read|open|cat)\b/i;
const SEARCH_TOOL_PATTERN = /\b(glob|grep|search|find|list|scan|ls)\b/i;
const EDIT_TOOL_NAME_PATTERN = /^(edit|multiedit|write)$/i;
const MCP_TOOL_PATTERN = /\bmcp\b/i;
const READ_PROMPT_PATTERN =
  /\b(read|open|show|cat|display|view|find|locate|buka\w*|lihat\w*|isi\w*|lengkap|full|ulang|repeat|cari\w*|temu\w*|kasih\s*tau)\b/i;
const FILE_PATH_PATTERN = /(?:[~./\w-]+\/)?[\w.-]+\.[a-z0-9]{1,10}\b|readme(?:\.md)?\b/gi;
const TRIM_FILE_TOKEN_PATTERN = /^[`"'([{<\s]+|[`"',.;:)\]}>/\\\s]+$/g;
const SENTENCE_BOUNDARY_PATTERN = /[.!?](?:["')\]]+)?(?:\s+|$|(?=[A-Z]))/;
const SENTENCE_BOUNDARY_SCAN_LIMIT = 280;

function isClaudePlanFilePayload(payload: Record<string, unknown>): boolean {
  const rawSource = payload.source;
  if (rawSource === "claude_plan_file") {
    return true;
  }

  if (rawSource === "streaming_fallback") {
    return false;
  }

  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  return filePath.includes(".claude/plans/") && filePath.endsWith(".md");
}

function findRepositoryByWorktree(repositories: Repository[], worktreeId: string | null): Repository | null {
  if (!worktreeId) {
    return null;
  }

  for (const repository of repositories) {
    if (repository.worktrees.some((worktree) => worktree.id === worktreeId)) {
      return repository;
    }
  }

  return null;
}

function parseTimestamp(input: string): number | null {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEventMessageId(event: ChatEvent): string | null {
  if (event.type !== "message.delta") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

function getCompletedMessageId(event: ChatEvent): string | null {
  if (event.type !== "chat.completed") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

function shouldClearWaitingAssistantOnEvent(event: ChatEvent): boolean {
  if (event.type === "chat.completed" || event.type === "chat.failed") {
    return true;
  }

  if (event.type === "message.delta") {
    return event.payload.role === "assistant";
  }

  return event.type === "permission.requested" || event.type === "question.requested" || event.type === "plan.created";
}

function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

function isReadToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event)) {
    return false;
  }

  return READ_TOOL_PATTERN.test(eventPayloadText(event));
}

function isSearchToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event) || isReadToolEvent(event)) {
    return false;
  }

  return SEARCH_TOOL_PATTERN.test(eventPayloadText(event));
}

function extractFirstFilePath(text: string): string | null {
  const matches = text.match(FILE_PATH_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }

  for (const match of matches) {
    const candidate = match.replace(TRIM_FILE_TOKEN_PATTERN, "").trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

function promptLooksLikeFileRead(prompt: string): boolean {
  return READ_PROMPT_PATTERN.test(prompt) && extractFirstFilePath(prompt) != null;
}

function hasUnclosedCodeFence(content: string): boolean {
  const fenceCount = (content.match(/(^|\n)```/g) ?? []).length;
  return fenceCount % 2 !== 0;
}

function isLikelyDiffContent(content: string): boolean {
  return /^(diff --git .+|--- [^\r\n]+|\+\+\+ [^\r\n]+|@@ .+ @@)/m.test(content);
}

function isWorktreeDiffEvent(event: ChatEvent): boolean {
  return event.type === "tool.finished" && event.payload.source === "worktree.diff";
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function activityStepLabel(event: ChatEvent, detail: string): string {
  const payload = eventPayloadText(event);
  const source = `${payload} ${detail}`.toLowerCase();
  const payloadSource = typeof event.payload.source === "string" ? event.payload.source.toLowerCase() : "";

  if (event.type === "chat.failed") {
    return "Error";
  }

  if (payloadSource === "integrity.warning" || source.includes("integrity warning") || source.includes("runtime-integrity-warning")) {
    return "Warning";
  }

  if (event.type === "permission.requested") {
    return "Permission";
  }

  if (event.type === "permission.resolved") {
    return "Permission";
  }

  if (READ_TOOL_PATTERN.test(source)) {
    return "Analyzed";
  }

  if (SEARCH_TOOL_PATTERN.test(source)) {
    return "Searched";
  }

  if (MCP_TOOL_PATTERN.test(source)) {
    return "MCP Tool";
  }

  return "Step";
}

function toolEventDetail(event: ChatEvent): string {
  if (event.type === "chat.failed") {
    return String(event.payload.message ?? "Chat failed");
  }

  if (event.type === "permission.requested") {
    return "Permission requested";
  }

  if (event.type === "permission.resolved") {
    const decision = event.payload.decision;
    if (decision === "allow") {
      return "Permission allowed";
    }
    if (decision === "allow_always") {
      return "Permission allowed (always)";
    }
    if (decision === "deny") {
      return "Permission denied";
    }
    return "Permission resolved";
  }

  if (event.type === "tool.finished") {
    const summary = event.payload.summary;
    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  }

  const toolName = event.payload.toolName;
  if (typeof toolName === "string" && toolName.trim().length > 0) {
    if (event.type === "tool.started") {
      return `${toolName.trim()} (running)`;
    }

    if (event.type === "tool.output") {
      const elapsed = Number(event.payload.elapsedTimeSeconds ?? 0);
      if (Number.isFinite(elapsed) && elapsed > 0) {
        return `${toolName.trim()} (${elapsed.toFixed(1)}s)`;
      }
    }
    return toolName.trim();
  }

  const command = event.payload.command;
  if (typeof command === "string" && command.trim().length > 0) {
    return command.trim();
  }

  return "Tool step";
}

type StepCandidate = {
  key: string | null;
  priority: number;
  idx: number;
  step: ActivityTraceStep;
};

function buildActivitySteps(context: ChatEvent[]): ActivityTraceStep[] {
  const candidates: StepCandidate[] = [];

  for (const event of context) {
    if (event.type === "chat.failed") {
      const detail = toolEventDetail(event);
      candidates.push({
        key: null,
        priority: 3,
        idx: event.idx,
        step: {
          id: event.id,
          label: activityStepLabel(event, detail),
          detail,
        },
      });
      continue;
    }

    if (event.type === "permission.requested") {
      continue;
    }

    const detail = toolEventDetail(event);
    const label = activityStepLabel(event, detail);

    if (event.type === "permission.resolved") {
      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      const key = requestId.length > 0 ? `permission:${requestId}` : `permission:${event.id}`;
      candidates.push({
        key,
        priority: 2,
        idx: event.idx,
        step: {
          id: event.id,
          label,
          detail,
        },
      });
      continue;
    }

    if (event.type === "tool.finished") {
      const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
        ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];

      if (precedingToolUseIds.length === 0) {
        candidates.push({
          key: null,
          priority: 2,
          idx: event.idx,
          step: {
            id: event.id,
            label,
            detail,
          },
        });
      } else {
        for (const toolUseId of precedingToolUseIds) {
          candidates.push({
            key: toolUseId,
            priority: 2,
            idx: event.idx,
            step: {
              id: `${event.id}:${toolUseId}`,
              label,
              detail,
            },
          });
        }
      }
      continue;
    }

    const toolUseId = event.payload.toolUseId;
    candidates.push({
      key: typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : null,
      priority: event.type === "tool.output" ? 1 : 0,
      idx: event.idx,
      step: {
        id: event.id,
        label,
        detail,
      },
    });
  }

  const chosenByKey = new Map<string, StepCandidate>();
  const unkeyed: StepCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate.key) {
      unkeyed.push(candidate);
      continue;
    }

    const existing = chosenByKey.get(candidate.key);
    if (!existing || candidate.priority > existing.priority || (candidate.priority === existing.priority && candidate.idx > existing.idx)) {
      chosenByKey.set(candidate.key, candidate);
    }
  }

  return [...Array.from(chosenByKey.values()), ...unkeyed]
    .sort((a, b) => a.idx - b.idx)
    .map((candidate) => candidate.step);
}

function computeDurationSecondsFromEvents(events: ChatEvent[]): number {
  if (events.length === 0) {
    return 0;
  }

  const timestamps = events.map((event) => parseTimestamp(event.createdAt)).filter((value): value is number => value != null);
  if (timestamps.length >= 2) {
    const first = Math.min(...timestamps);
    const last = Math.max(...timestamps);
    const seconds = Math.max(1, Math.round((last - first) / 1000));
    return Number.isFinite(seconds) ? seconds : 1;
  }

  const maxElapsed = events
    .filter((event) => event.type === "tool.output")
    .map((event) => Number(event.payload.elapsedTimeSeconds ?? 0))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);

  if (maxElapsed > 0) {
    return Math.max(1, Math.round(maxElapsed));
  }

  return 1;
}

function buildActivityIntroText(content: string): string | null {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const intro = (sentences.length > 0 ? sentences.slice(0, 2).join(" ") : normalized).trim();
  if (intro.length <= 220) {
    return intro;
  }

  return `${intro.slice(0, 217).trimEnd()}...`;
}

function splitAtFirstSentenceBoundary(text: string): { head: string; tail: string } | null {
  if (text.length === 0) {
    return null;
  }

  const scanTarget = text.slice(0, SENTENCE_BOUNDARY_SCAN_LIMIT);
  const match = SENTENCE_BOUNDARY_PATTERN.exec(scanTarget);
  if (!match) {
    return null;
  }

  const boundaryIdx = match.index + match[0].length;
  if (boundaryIdx <= 0) {
    return null;
  }

  return {
    head: text.slice(0, boundaryIdx),
    tail: text.slice(boundaryIdx),
  };
}

function hasSentenceBoundary(text: string): boolean {
  return splitAtFirstSentenceBoundary(text) != null;
}

function isSentenceAwareInlineInsertKind(kind: string | null): boolean {
  return kind === "explore-activity" || kind === "edited" || kind === "bash";
}

function shouldDelayFirstInlineInsert(
  firstInsertKind: string | null,
  leadingContent: string,
  hasAnyTrailingText: boolean,
): boolean {
  if (!isSentenceAwareInlineInsertKind(firstInsertKind) || !hasAnyTrailingText) {
    return false;
  }

  if (leadingContent.length === 0) {
    return true;
  }

  return !hasSentenceBoundary(leadingContent);
}

type BashRun = {
  id: string;
  toolUseId: string;
  startIdx: number;
  anchorIdx: number;
  summary: string | null;
  command: string | null;
  output: string | null;
  error: string | null;
  truncated: boolean;
  durationSeconds: number | null;
  status: "running" | "success" | "failed";
  rejectedByUser: boolean;
  createdAt: string;
  eventIds: Set<string>;
};

type EditedRun = {
  id: string;
  eventId: string;
  startIdx: number;
  anchorIdx: number;
  status: "running" | "success" | "failed";
  diffKind: "proposed" | "actual" | "none";
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
  rejectedByUser: boolean;
  createdAt: string;
  eventIds: Set<string>;
};

function payloadStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.length > 0 ? value : null;
}

function payloadStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isEditToolName(toolName: string | null): boolean {
  if (!toolName) {
    return false;
  }

  return EDIT_TOOL_NAME_PATTERN.test(toolName.trim());
}

function extractEditTargetFromUnknownToolInput(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const keyCandidates = ["file_path", "path", "file", "filepath", "target", "filename"];
  for (const key of keyCandidates) {
    const value = payloadStringOrNull(input[key]);
    if (value) {
      return value.trim();
    }
  }

  return null;
}

function extractEditTargetFromSummary(summary: string): string | null {
  const editedMatch = /^Edited\s+(.+)$/i.exec(summary.trim());
  if (editedMatch?.[1]) {
    const candidate = editedMatch[1].trim();
    if (!/^(\d+\s+files?|files?|changes?)$/i.test(candidate)) {
      return candidate;
    }
    return null;
  }

  const failedMatch = /^Failed to edit\s+(.+)$/i.exec(summary.trim());
  if (failedMatch?.[1]) {
    return failedMatch[1].trim();
  }

  return null;
}

function buildProposedEditDiffFromToolInput(toolInput: unknown, filePath: string): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  function extractEditBlock(record: Record<string, unknown>): { oldText: string | null; newText: string | null } | null {
    const oldText =
      payloadStringOrNull(record.old_string)
      ?? payloadStringOrNull(record.old_text)
      ?? payloadStringOrNull(record.old)
      ?? null;
    const newText =
      payloadStringOrNull(record.new_string)
      ?? payloadStringOrNull(record.new_text)
      ?? payloadStringOrNull(record.new)
      ?? payloadStringOrNull(record.content)
      ?? payloadStringOrNull(record.new_content)
      ?? null;
    if (!oldText && !newText) {
      return null;
    }
    return { oldText, newText };
  }

  const blocks: Array<{ oldText: string | null; newText: string | null }> = [];
  const rootBlock = extractEditBlock(toolInput);
  if (rootBlock) {
    blocks.push(rootBlock);
  }

  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!isRecord(edit)) {
        continue;
      }
      const block = extractEditBlock(edit);
      if (block) {
        blocks.push(block);
      }
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  for (const block of blocks) {
    const oldLines = block.oldText ? block.oldText.split(/\r?\n/) : [];
    const newLines = block.newText ? block.newText.split(/\r?\n/) : [];
    const oldStart = oldLines.length === 0 ? "1,0" : oldLines.length === 1 ? "1" : `1,${oldLines.length}`;
    const newStart = newLines.length === 0 ? "1,0" : newLines.length === 1 ? "1" : `1,${newLines.length}`;
    lines.push(`@@ -${oldStart} +${newStart} @@`);
    lines.push(...oldLines.map((line) => `-${line}`));
    lines.push(...newLines.map((line) => `+${line}`));
  }

  return lines.join("\n");
}

function isEditToolLifecycleEvent(event: ChatEvent): boolean {
  if (event.type === "tool.started" || event.type === "tool.output") {
    const toolName = payloadStringOrNull(event.payload.toolName);
    return isEditToolName(toolName);
  }

  if (event.type === "tool.finished") {
    if (event.payload.source === "worktree.diff") {
      return false;
    }
    const explicitTarget = payloadStringOrNull(event.payload.editTarget);
    if (explicitTarget) {
      return true;
    }
    const summary = payloadStringOrNull(event.payload.summary);
    return Boolean(summary && extractEditTargetFromSummary(summary));
  }

  if (event.type === "permission.requested") {
    const toolName = payloadStringOrNull(event.payload.toolName);
    return isEditToolName(toolName);
  }

  return false;
}

function isBashPayload(payload: Record<string, unknown>): boolean {
  if (payload.isBash === true || payload.shell === "bash") {
    return true;
  }

  const toolName = payload.toolName;
  return typeof toolName === "string" && toolName.trim().toLowerCase() === "bash";
}

function isBashToolEvent(event: ChatEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
    return false;
  }

  return isBashPayload(event.payload);
}

function extractBashRuns(context: ChatEvent[]): BashRun[] {
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
      const summaryLower = (run.summary ?? "").toLowerCase();
      run.status = run.error
        ? "failed"
        : summaryLower.includes("failed") || summaryLower.includes("error")
          ? "failed"
          : "success";
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

  return Array.from(byToolUseId.values()).sort((a, b) => a.startIdx - b.startIdx);
}

function extractEditedRuns(context: ChatEvent[], fullContext?: ChatEvent[]): EditedRun[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const byRunKey = new Map<string, EditedRun>();

  // Determine the best anchor position for the edited-diff card. Claude Code
  // emits all message.delta events before the final worktree.diff, so using
  // the worktree.diff's own idx would place the card after ALL text.
  //
  // Instead, anchor to the last permission/tool event that occurred during the
  // conversation — these fire *between* text deltas (planning text before,
  // confirmation text after), giving a natural inline split point.
  const anchorSource = fullContext ? [...fullContext].sort((a, b) => a.idx - b.idx) : ordered;
  let bestAnchorIdx: number | null = null;
  for (const event of anchorSource) {
    if (isWorktreeDiffEvent(event)) {
      continue;
    }
    if (
      event.type === "permission.resolved" ||
      event.type === "permission.requested" ||
      event.type === "tool.finished" ||
      event.type === "tool.output" ||
      event.type === "tool.started"
    ) {
      bestAnchorIdx = event.idx;
    }
  }

  function ensureRun(
    runKey: string,
    event: ChatEvent,
    options?: { startIdx?: number; anchorIdx?: number },
  ): EditedRun {
    const existing = byRunKey.get(runKey);
    const nextStartIdx = options?.startIdx ?? event.idx;
    const nextAnchorIdx = options?.anchorIdx ?? nextStartIdx;
    if (existing) {
      existing.startIdx = Math.min(existing.startIdx, nextStartIdx);
      existing.anchorIdx = Math.min(existing.anchorIdx, nextAnchorIdx);
      existing.eventIds.add(event.id);
      return existing;
    }

    const created: EditedRun = {
      id: `edited:${runKey}`,
      eventId: event.id,
      startIdx: nextStartIdx,
      anchorIdx: nextAnchorIdx,
      status: "running",
      diffKind: "none",
      changedFiles: [],
      diff: "",
      diffTruncated: false,
      additions: 0,
      deletions: 0,
      rejectedByUser: false,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    };
    byRunKey.set(runKey, created);
    return created;
  }

  function setRunTargetIfPresent(run: EditedRun, target: string | null): void {
    if (!target) {
      return;
    }
    if (!run.changedFiles.includes(target)) {
      run.changedFiles.push(target);
    }
  }

  function markRunFinishedFromEvent(run: EditedRun, event: ChatEvent): void {
    const hasError = payloadStringOrNull(event.payload.error);
    const summary = payloadStringOrNull(event.payload.summary);
    const summaryLower = (summary ?? "").toLowerCase();
    run.status = hasError || summaryLower.includes("failed") || summaryLower.includes("error") ? "failed" : "success";
    if (run.status !== "failed") {
      run.rejectedByUser = false;
    }
  }

  for (const event of ordered) {
    if (event.type === "permission.requested") {
      if (!isEditToolLifecycleEvent(event)) {
        continue;
      }
      const requestId = payloadStringOrNull(event.payload.requestId) ?? `permission:${event.id}`;
      const run = ensureRun(requestId, event);
      run.status = "running";
      run.rejectedByUser = false;

      const toolInput = isRecord(event.payload.toolInput) ? event.payload.toolInput : null;
      const target =
        payloadStringOrNull(event.payload.editTarget)
        ?? extractEditTargetFromUnknownToolInput(toolInput)
        ?? null;
      setRunTargetIfPresent(run, target);
      if (toolInput && target) {
        const proposedDiff = buildProposedEditDiffFromToolInput(toolInput, target);
        if (proposedDiff && run.diffKind !== "actual") {
          run.diff = proposedDiff;
          run.diffKind = "proposed";
          run.diffTruncated = false;
          const { additions, deletions } = countDiffStats(proposedDiff);
          run.additions = additions;
          run.deletions = deletions;
        }
      }
      continue;
    }

    if (event.type === "permission.resolved") {
      const requestId = payloadStringOrNull(event.payload.requestId);
      if (!requestId) {
        continue;
      }
      const run = byRunKey.get(requestId);
      if (!run) {
        continue;
      }
      run.eventIds.add(event.id);
      const decision = payloadStringOrNull(event.payload.decision);
      if (decision === "deny") {
        run.status = "failed";
        run.rejectedByUser = true;
      } else if (decision === "allow" || decision === "allow_always") {
        run.rejectedByUser = false;
      }
      continue;
    }

    if (event.type === "tool.started" || event.type === "tool.output") {
      if (!isEditToolLifecycleEvent(event)) {
        continue;
      }
      const toolUseId = payloadStringOrNull(event.payload.toolUseId) ?? `${event.type}:${event.id}`;
      const run = ensureRun(toolUseId, event);
      if (run.status !== "failed") {
        run.status = "running";
      }
      setRunTargetIfPresent(run, payloadStringOrNull(event.payload.editTarget));
      continue;
    }

    if (event.type === "tool.finished" && !isWorktreeDiffEvent(event)) {
      const runIds = finishedToolUseIds(event);
      const summary = payloadStringOrNull(event.payload.summary);
      const summaryTarget = summary ? extractEditTargetFromSummary(summary) : null;
      const explicitTarget = payloadStringOrNull(event.payload.editTarget) ?? summaryTarget;

      let matchedRun = false;
      for (const runId of runIds) {
        const existing = byRunKey.get(runId);
        const shouldTrack = existing || isEditToolLifecycleEvent(event) || explicitTarget != null;
        if (!shouldTrack) {
          continue;
        }
        const run = ensureRun(runId, event);
        setRunTargetIfPresent(run, explicitTarget);
        markRunFinishedFromEvent(run, event);
        matchedRun = true;
      }

      if (!matchedRun && (isEditToolLifecycleEvent(event) || explicitTarget != null)) {
        const fallbackKey = `finished:${event.id}`;
        const run = ensureRun(fallbackKey, event);
        setRunTargetIfPresent(run, explicitTarget);
        markRunFinishedFromEvent(run, event);
      }
      continue;
    }

    if (!isWorktreeDiffEvent(event)) {
      continue;
    }

    const diff = payloadStringOrNull(event.payload.diff) ?? "";
    const changedFiles = payloadStringArray(event.payload.changedFiles);
    const { additions, deletions } = countDiffStats(diff);
    const targetRun = Array.from(byRunKey.values())
      .filter((run) => run.startIdx <= event.idx && run.diffKind !== "actual" && run.status !== "failed")
      .sort((a, b) => b.startIdx - a.startIdx)[0];

    const run = targetRun
      ?? ensureRun(`worktree:${event.id}`, event, {
        startIdx: bestAnchorIdx ?? event.idx,
        anchorIdx: bestAnchorIdx ?? event.idx,
      });
    run.eventId = event.id;
    run.status = "success";
    run.diffKind = "actual";
    run.diff = diff;
    run.diffTruncated = event.payload.diffTruncated === true;
    run.additions = additions;
    run.deletions = deletions;
    run.rejectedByUser = false;
    run.eventIds.add(event.id);
    if (changedFiles.length > 0) {
      run.changedFiles = changedFiles;
    }
  }

  return Array.from(byRunKey.values()).sort((a, b) => a.startIdx - b.startIdx);
}

type ExploreRunKind = "read" | "search";

type ExploreRunState = {
  id: string;
  kind: ExploreRunKind;
  pending: boolean;
  label: string;
  openPath: string | null;
  searchToolName: string | null;
  searchParams: string | null;
  orderIdx: number;
  startIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

type ExploreActivityGroup = {
  id: string;
  status: "running" | "success";
  fileCount: number;
  searchCount: number;
  entries: ExploreActivityEntry[];
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

function shortenReadTargetForDisplay(target: string): string {
  const cleaned = target.trim().replace(/^["'`]+|["'`]+$/g, "");
  const normalized = cleaned.replace(/\\/g, "/");
  const normalizedWithoutLine = normalized.replace(/:\d+(?::\d+)?$/, "");
  const parts = normalizedWithoutLine.replace(/\/+$/, "").split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return cleaned;
  }

  const basename = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : null;

  // Keep hidden-directory context (for example ".beads/README.md"),
  // otherwise prefer basename to avoid noisy long paths.
  if (parent && parent.startsWith(".")) {
    return `${parent}/${basename}`;
  }

  return basename;
}

function extractReadTargetFromSummary(summary: string): string | null {
  if (/^completed\s+read$/i.test(summary.trim())) {
    return null;
  }

  const stripped = summary.replace(/^(Read|Opened|Cat)\s+/i, "").trim();
  if (stripped.length === 0) {
    return null;
  }

  const cleaned = stripped.replace(/^["'`]+|["'`]+$/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function extractReadFileEntry(event: ChatEvent): ReadFileTimelineEntry | null {
  const summary = payloadStringOrNull(event.payload.summary);
  if (summary) {
    const target = extractReadTargetFromSummary(summary);
    if (target) {
      return {
        label: shortenReadTargetForDisplay(target),
        openPath: target,
      };
    }

    return {
      label: "file",
      openPath: null,
    };
  }
  return null;
}

function normalizeSearchSummary(summary: string): string {
  const normalized = summary.trim();
  if (normalized.length === 0) {
    return "Searched";
  }

  if (/^searched\s+for\s+/i.test(normalized)) {
    return normalized;
  }

  if (/^completed\s+(glob|grep|search|find|list|scan|ls)\b/i.test(normalized)) {
    return "Searched";
  }

  return `Searched for ${normalized}`;
}

function searchContextFromEvent(event: ChatEvent): { toolName: string | null; searchParams: string | null } {
  const toolName = payloadStringOrNull(event.payload.toolName);
  const searchParams = payloadStringOrNull(event.payload.searchParams);
  return {
    toolName: toolName ? toolName.trim() : null,
    searchParams: searchParams ? searchParams.trim() : null,
  };
}

function buildSearchRunningLabel(toolName: string | null, searchParams: string | null): string {
  const base = `Searching ${toolName && toolName.length > 0 ? toolName : "Search"}`;
  if (searchParams && searchParams.length > 0) {
    return `${base} (${searchParams})`;
  }
  return base;
}

function buildSearchCompletedFallbackLabel(toolName: string | null, searchParams: string | null): string {
  const base = `Searched${toolName && toolName.length > 0 ? ` ${toolName}` : ""}`;
  if (searchParams && searchParams.length > 0) {
    return `${base} (${searchParams})`;
  }
  return base;
}

function extractSearchEntryLabel(
  event: ChatEvent,
  options?: { toolName?: string | null; searchParams?: string | null },
): string {
  const fallbackToolName = options?.toolName ?? null;
  const fallbackSearchParams = options?.searchParams ?? null;
  const summary = payloadStringOrNull(event.payload.summary);
  if (summary) {
    const normalized = summary.trim();
    if (/^completed\s+(glob|grep|search|find|list|scan|ls)\b/i.test(normalized)) {
      return buildSearchCompletedFallbackLabel(fallbackToolName, fallbackSearchParams);
    }
    return normalizeSearchSummary(summary);
  }

  return buildSearchCompletedFallbackLabel(fallbackToolName, fallbackSearchParams);
}

function extractExploreRunKind(event: ChatEvent): ExploreRunKind | null {
  if (isReadToolEvent(event)) {
    return "read";
  }

  if (isSearchToolEvent(event)) {
    return "search";
  }

  return null;
}

function finishedToolUseIds(event: ChatEvent): string[] {
  const precedingToolUseIds = Array.isArray(event.payload.precedingToolUseIds)
    ? event.payload.precedingToolUseIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  if (precedingToolUseIds.length > 0) {
    return precedingToolUseIds;
  }

  const toolUseId = payloadStringOrNull(event.payload.toolUseId);
  if (toolUseId) {
    return [toolUseId];
  }

  return [`finished:${event.id}`];
}

function extractExploreActivityGroups(context: ChatEvent[]): ExploreActivityGroup[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const groups: ExploreActivityGroup[] = [];
  let currentRuns = new Map<string, ExploreRunState>();
  let currentStartIdx: number | null = null;
  let currentCreatedAt: string | null = null;
  let currentFirstEventId: string | null = null;

  function ensureRun(runId: string, kind: ExploreRunKind, event: ChatEvent): ExploreRunState {
    const existing = currentRuns.get(runId);
    if (existing) {
      existing.startIdx = Math.min(existing.startIdx, event.idx);
      existing.eventIds.add(event.id);
      return existing;
    }

    const created: ExploreRunState = {
      id: runId,
      kind,
      pending: true,
      label: kind === "read" ? "file" : "Searching...",
      openPath: null,
      searchToolName: null,
      searchParams: null,
      orderIdx: event.idx,
      startIdx: event.idx,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    };
    currentRuns.set(runId, created);
    return created;
  }

  function flushGroup() {
    if (currentRuns.size === 0 || currentStartIdx == null || currentCreatedAt == null || currentFirstEventId == null) {
      currentRuns = new Map<string, ExploreRunState>();
      currentStartIdx = null;
      currentCreatedAt = null;
      currentFirstEventId = null;
      return;
    }

    const runs = Array.from(currentRuns.values());
    const entries = runs
      .map((run): ExploreActivityEntry => ({
        kind: run.kind,
        label: run.pending
          ? (run.kind === "read"
            ? "Reading..."
            : (run.label.length > 0 ? run.label : "Searching..."))
          : run.label,
        openPath: run.pending ? null : run.openPath,
        pending: run.pending,
        orderIdx: run.orderIdx,
      }))
      .sort((a, b) => {
        if (a.orderIdx !== b.orderIdx) {
          return a.orderIdx - b.orderIdx;
        }

        if (a.pending !== b.pending) {
          return a.pending ? 1 : -1;
        }

        return a.kind.localeCompare(b.kind);
      });
    const fileCount = runs.filter((run) => run.kind === "read").length;
    const searchCount = runs.filter((run) => run.kind === "search").length;
    if (fileCount === 0 && searchCount === 0) {
      currentRuns = new Map<string, ExploreRunState>();
      currentStartIdx = null;
      currentCreatedAt = null;
      currentFirstEventId = null;
      return;
    }

    const eventIds = new Set<string>();
    runs.forEach((run) => {
      run.eventIds.forEach((eventId) => eventIds.add(eventId));
    });
    groups.push({
      id: `explore:${currentFirstEventId}`,
      status: runs.some((run) => run.pending) ? "running" : "success",
      fileCount,
      searchCount,
      entries,
      startIdx: currentStartIdx,
      anchorIdx: currentStartIdx,
      createdAt: currentCreatedAt,
      eventIds,
    });

    currentRuns = new Map<string, ExploreRunState>();
    currentStartIdx = null;
    currentCreatedAt = null;
    currentFirstEventId = null;
  }

  for (const event of ordered) {
    // Keep inline grouping aligned with assistant text segments.
    if (event.type === "message.delta") {
      flushGroup();
      continue;
    }

    if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
      continue;
    }

    const kindFromEvent = extractExploreRunKind(event);
    const toolUseId = payloadStringOrNull(event.payload.toolUseId);

    if (event.type === "tool.started" || event.type === "tool.output") {
      const runId = toolUseId ?? `${event.type}:${event.id}`;
      const existing = currentRuns.get(runId);
      const kind = existing?.kind ?? kindFromEvent;
      if (!kind) {
        continue;
      }

      if (currentStartIdx == null) {
        currentStartIdx = event.idx;
        currentCreatedAt = event.createdAt;
        currentFirstEventId = event.id;
      }

      const run = ensureRun(runId, kind, event);
      run.pending = true;
      run.orderIdx = Math.max(run.orderIdx, event.idx);
      if (run.kind === "search") {
        const context = searchContextFromEvent(event);
        run.searchToolName = context.toolName ?? run.searchToolName;
        run.searchParams = context.searchParams ?? run.searchParams;
        run.label = buildSearchRunningLabel(run.searchToolName, run.searchParams);
      }
      continue;
    }

    const runIds = finishedToolUseIds(event);
    if (currentStartIdx == null) {
      currentStartIdx = event.idx;
      currentCreatedAt = event.createdAt;
      currentFirstEventId = event.id;
    }

    for (const runId of runIds) {
      const existing = currentRuns.get(runId);
      const kind = existing?.kind ?? kindFromEvent;
      if (!kind) {
        continue;
      }

      const run = existing ?? ensureRun(runId, kind, event);
      run.pending = false;
      run.orderIdx = event.idx;
      run.eventIds.add(event.id);

      if (run.kind === "read") {
        const readFile = extractReadFileEntry(event);
        run.label = readFile?.label ?? "file";
        run.openPath = readFile?.openPath ?? null;
        continue;
      }

      const context = searchContextFromEvent(event);
      run.searchToolName = context.toolName ?? run.searchToolName;
      run.searchParams = context.searchParams ?? run.searchParams;
      run.label = extractSearchEntryLabel(event, {
        toolName: run.searchToolName,
        searchParams: run.searchParams,
      });
      run.openPath = null;
    }
  }

  flushGroup();
  return groups;
}

type PendingPermissionRequest = {
  requestId: string;
  toolName: string;
  command: string | null;
  blockedPath: string | null;
  decisionReason: string | null;
  idx: number;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

type PendingQuestionRequest = {
  requestId: string;
  questions: QuestionItem[];
  idx: number;
};

export function WorkspacePage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("");
  const [chatMode, setChatMode] = useState<ChatMode>("default");

  const [loadingRepos, setLoadingRepos] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingThreadId, setStoppingThreadId] = useState<string | null>(null);
  const [stopRequestedThreadId, setStopRequestedThreadId] = useState<string | null>(null);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [submittingWorktree, setSubmittingWorktree] = useState(false);
  const [closingThreadId, setClosingThreadId] = useState<string | null>(null);
  const [waitingAssistant, setWaitingAssistant] = useState<{ threadId: string; afterIdx: number } | null>(null);
  const [resolvingPermissionIds, setResolvingPermissionIds] = useState<Set<string>>(new Set());
  const [answeringQuestionIds, setAnsweringQuestionIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());
  const loggedOrphanEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());

  function ensureSeenEventIds(threadId: string): Set<string> {
    const existing = seenEventIdsByThreadRef.current.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    seenEventIdsByThreadRef.current.set(threadId, created);
    return created;
  }

  function updateLastEventIdx(threadId: string, idx: number) {
    const current = lastEventIdxByThreadRef.current.get(threadId);
    if (current == null || idx > current) {
      lastEventIdxByThreadRef.current.set(threadId, idx);
    }
  }

  function ensureLoggedOrphanEventIds(threadId: string): Set<string> {
    const existing = loggedOrphanEventIdsByThreadRef.current.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    loggedOrphanEventIdsByThreadRef.current.set(threadId, created);
    return created;
  }

  function startWaitingAssistant(threadId: string) {
    const afterIdx = lastEventIdxByThreadRef.current.get(threadId) ?? -1;
    setWaitingAssistant({
      threadId,
      afterIdx,
    });
  }

  const selectedRepository = useMemo(() => {
    if (selectedRepositoryId) {
      return repositories.find((repository) => repository.id === selectedRepositoryId) ?? null;
    }

    return findRepositoryByWorktree(repositories, selectedWorktreeId);
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);

  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) {
      return null;
    }

    for (const repository of repositories) {
      const found = repository.worktrees.find((worktree) => worktree.id === selectedWorktreeId);
      if (found) {
        return found;
      }
    }

    return null;
  }, [repositories, selectedWorktreeId]);

  async function loadRepositories() {
    setLoadingRepos(true);
    setError(null);

    try {
      const data = await api.listRepositories();
      setRepositories(data);

      if (!selectedRepositoryId && data[0]) {
        setSelectedRepositoryId(data[0].id);
      }

      if (!selectedWorktreeId) {
        const firstWorktree = data[0]?.worktrees[0];
        if (firstWorktree) {
          setSelectedWorktreeId(firstWorktree.id);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load repositories");
    } finally {
      setLoadingRepos(false);
    }
  }

  async function ensureThread(worktreeId: string): Promise<string | null> {
    const existing = await api.listThreads(worktreeId);
    setThreads(existing);

    if (existing.length > 0) {
      return existing[0].id;
    }

    const created = await api.createThread(worktreeId, { title: "Main Thread" });
    setThreads([created]);
    return created.id;
  }

  async function loadThreadData(threadId: string) {
    const [threadMessages, threadEvents] = await Promise.all([api.listMessages(threadId), api.listEvents(threadId)]);
    setMessages(threadMessages);
    setEvents(threadEvents);
    pushRenderDebug({
      source: "WorkspacePage",
      event: "loadThreadData",
      details: {
        threadId,
        messages: threadMessages.length,
        events: threadEvents.length,
      },
    });

    const seenEventIds = new Set<string>();
    let lastIdx: number | null = null;
    for (const event of threadEvents) {
      seenEventIds.add(event.id);
      if (lastIdx == null || event.idx > lastIdx) {
        lastIdx = event.idx;
      }
    }

    seenEventIdsByThreadRef.current.set(threadId, seenEventIds);
    if (lastIdx == null) {
      lastEventIdxByThreadRef.current.delete(threadId);
    } else {
      lastEventIdxByThreadRef.current.set(threadId, lastIdx);
    }
  }

  useEffect(() => {
    void loadRepositories();
  }, []);

  useEffect(() => {
    if (!selectedWorktreeId) {
      setWaitingAssistant(null);
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const threadId = await ensureThread(selectedWorktreeId);
        if (!threadId || cancelled) {
          return;
        }

        setSelectedThreadId(threadId);
      } catch (threadError) {
        if (!cancelled) {
          setError(threadError instanceof Error ? threadError.message : "Failed to load threads");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedWorktreeId]);

  useEffect(() => {
    if (!selectedThreadId) {
      setWaitingAssistant(null);
      setStoppingThreadId(null);
      setStopRequestedThreadId(null);
      setResolvingPermissionIds(new Set());
      streamingMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      setMessages([]);
      setEvents([]);
      return;
    }

    streamingMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    setWaitingAssistant(null);
    setStoppingThreadId(null);
    setStopRequestedThreadId(null);
    setResolvingPermissionIds(new Set());

    let disposed = false;
    let stream: EventSource | null = null;

    void (async () => {
      try {
        await loadThreadData(selectedThreadId);
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load thread");
        }
        return;
      }

      if (disposed) {
        return;
      }

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);
      const lastEventIdx = lastEventIdxByThreadRef.current.get(selectedThreadId);
      if (typeof lastEventIdx === "number") {
        streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
      }

      stream = new EventSource(streamUrl.toString());

      const onEvent = (rawEvent: MessageEvent<string>) => {
        if (disposed) {
          return;
        }

        const payload = JSON.parse(rawEvent.data) as ChatEvent;
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        if (seenEventIds.has(payload.id)) {
          pushRenderDebug({
            source: "WorkspacePage",
            event: "streamEventSkippedDuplicate",
            messageId: String(payload.payload.messageId ?? ""),
            details: {
              eventId: payload.id,
              type: payload.type,
              idx: payload.idx,
            },
          });
          return;
        }

        seenEventIds.add(payload.id);
        updateLastEventIdx(selectedThreadId, payload.idx);
        pushRenderDebug({
          source: "WorkspacePage",
          event: "streamEventAccepted",
          messageId: String(payload.payload.messageId ?? ""),
          details: {
            eventId: payload.id,
            type: payload.type,
            idx: payload.idx,
            payload: payload.payload,
          },
        });
        if (payload.type === "tool.started" || payload.type === "tool.output" || payload.type === "tool.finished") {
          logService.log("debug", "chat.stream", "Tool event received from stream", {
            threadId: selectedThreadId,
            eventId: payload.id,
            idx: payload.idx,
            type: payload.type,
            toolUseId: typeof payload.payload.toolUseId === "string" ? payload.payload.toolUseId : null,
            toolName: typeof payload.payload.toolName === "string" ? payload.payload.toolName : null,
          });
        }

        setWaitingAssistant((current) => {
          if (!current || current.threadId !== selectedThreadId || payload.idx <= current.afterIdx) {
            return current;
          }

          if (shouldClearWaitingAssistantOnEvent(payload)) {
            return null;
          }

          return current;
        });

        setEvents((current) => [...current, payload].sort((a, b) => a.idx - b.idx));

        if (payload.type === "message.delta") {
          const messageId = String(payload.payload.messageId ?? "");
          const role =
            payload.payload.role === "assistant" || payload.payload.role === "user" ? payload.payload.role : "assistant";
          const delta = String(payload.payload.delta ?? "");
          pushRenderDebug({
            source: "WorkspacePage",
            event: "messageDelta",
            messageId,
            details: {
              role,
              deltaLength: delta.length,
              idx: payload.idx,
            },
          });

          if (messageId.length === 0) {
            return;
          }

          if (role === "assistant") {
            streamingMessageIdsRef.current.add(messageId);
          }

          setMessages((current) => {
            const existing = current.find((message) => message.id === messageId);
            if (!existing) {
              return [
                ...current,
                {
                  id: messageId,
                  threadId: selectedThreadId,
                  seq: current.length,
                  role,
                  content: delta,
                  createdAt: new Date().toISOString(),
                },
              ];
            }

            if (role === "user") {
              return current;
            }

            return current.map((message) =>
              message.id === messageId
                ? {
                  ...message,
                  content: message.content + delta,
                }
                : message,
            );
          });
        }

        if (payload.type === "chat.completed") {
          const completedMessageId = String(payload.payload.messageId ?? "");
          const completedThreadTitle = payloadStringOrNull(payload.payload.threadTitle);
          if (completedMessageId.length > 0) {
            streamingMessageIdsRef.current.delete(completedMessageId);
          }
          if (completedThreadTitle) {
            setThreads((current) =>
              current.map((thread) =>
                thread.id === selectedThreadId
                  ? {
                      ...thread,
                      title: completedThreadTitle,
                    }
                  : thread,
              ),
            );
          }
          pushRenderDebug({
            source: "WorkspacePage",
            event: "chatCompleted",
            messageId: completedMessageId,
            details: { idx: payload.idx },
          });
          void loadThreadData(selectedThreadId);
        }
      };

      for (const eventType of EVENT_TYPES) {
        stream.addEventListener(eventType, onEvent as EventListener);
      }

      stream.onerror = () => {
        if (!disposed && stream && stream.readyState === EventSource.CLOSED) {
          setError("Lost connection to chat stream");
        }
      };
    })();

    return () => {
      disposed = true;
      stream?.close();
    };
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) {
      return;
    }

    setWaitingAssistant((current) => {
      if (!current || current.threadId !== selectedThreadId) {
        return current;
      }

      const shouldClear = events.some((event) => {
        if (event.idx <= current.afterIdx) {
          return false;
        }

        return shouldClearWaitingAssistantOnEvent(event);
      });

      return shouldClear ? null : current;
    });
  }, [events, selectedThreadId]);

  async function attachRepository() {
    setSubmittingRepo(true);
    setError(null);

    try {
      let path = "";

      try {
        const picked = await api.pickDirectory();
        path = picked.path.trim();
      } catch {
        const manualPath =
          typeof window === "undefined"
            ? null
            : window.prompt("Enter the repository path on the runtime machine", "");
        path = manualPath?.trim() ?? "";
      }

      if (!path) {
        return;
      }

      await api.createRepository({
        path,
      });
      await loadRepositories();
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Failed to add repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function submitWorktree(repositoryId: string) {
    setSubmittingWorktree(true);
    setError(null);

    try {
      const created = await api.createWorktree(repositoryId);

      await loadRepositories();
      setSelectedWorktreeId(created.id);
      setSelectedRepositoryId(repositoryId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create worktree");
    } finally {
      setSubmittingWorktree(false);
    }
  }

  async function removeWorktree(worktreeId: string) {
    setError(null);

    try {
      await api.deleteWorktree(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
        setSelectedThreadId(null);
      }
      await loadRepositories();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to delete worktree");
    }
  }

  async function createAdditionalThread() {
    if (!selectedWorktreeId) {
      return;
    }

    setError(null);

    try {
      const created = await api.createThread(selectedWorktreeId, {
        title: `Thread ${threads.length + 1}`,
      });
      setThreads((current) => {
        const exists = current.some((thread) => thread.id === created.id);
        if (exists) {
          return current;
        }

        return [...current, created];
      });
      setSelectedThreadId(created.id);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Failed to create thread");
    }
  }

  async function closeThread(threadId: string) {
    setError(null);
    setClosingThreadId(threadId);

    try {
      await api.deleteThread(threadId);
      setThreads((current) => {
        const updated = current.filter((thread) => thread.id !== threadId);

        if (selectedThreadId === threadId) {
          const nextThreadId = updated[0]?.id ?? null;
          setWaitingAssistant(null);
          setSelectedThreadId(nextThreadId);

          if (!nextThreadId) {
            setMessages([]);
            setEvents([]);
          }
        }

        return updated;
      });
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Failed to close session");
    } finally {
      setClosingThreadId(null);
    }
  }

  async function submitMessage(content?: string) {
    const messageContent = content ?? chatInput;
    if (!selectedThreadId || !messageContent.trim()) {
      return;
    }

    startWaitingAssistant(selectedThreadId);
    setSendingMessage(true);
    setError(null);

    try {
      await api.sendMessage(selectedThreadId, {
        content: messageContent,
        mode: chatMode,
      });
      setChatInput("");
      await loadThreadData(selectedThreadId);
    } catch (sendError) {
      setWaitingAssistant(null);
      setError(sendError instanceof Error ? sendError.message : "Failed to send message");
    } finally {
      setSendingMessage(false);
    }
  }

  async function stopAssistantRun() {
    if (!selectedThreadId) {
      return;
    }

    const threadId = selectedThreadId;
    if (stopRequestedThreadId === threadId) {
      return;
    }

    setStopRequestedThreadId(threadId);
    setStoppingThreadId(threadId);
    setError(null);

    try {
      await api.stopRun(threadId);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Failed to stop run");
      setStopRequestedThreadId((current) => (current === threadId ? null : current));
    } finally {
      setStoppingThreadId((current) => (current === threadId ? null : current));
    }
  }

  const pendingPermissionRequests = useMemo<PendingPermissionRequest[]>(() => {
    const pendingById = new Map<string, PendingPermissionRequest>();
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);

    for (const event of orderedEvents) {
      if (event.type === "permission.requested") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length === 0) {
          continue;
        }

        pendingById.set(requestId, {
          requestId,
          toolName: typeof event.payload.toolName === "string" ? event.payload.toolName : "Tool",
          command: typeof event.payload.command === "string" ? event.payload.command : null,
          blockedPath: typeof event.payload.blockedPath === "string" ? event.payload.blockedPath : null,
          decisionReason: typeof event.payload.decisionReason === "string" ? event.payload.decisionReason : null,
          idx: event.idx,
        });
        continue;
      }

      if (event.type === "permission.resolved") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length > 0) {
          pendingById.delete(requestId);
        }
      }
    }

    return Array.from(pendingById.values()).sort((a, b) => a.idx - b.idx);
  }, [events]);

  async function resolvePermission(requestId: string, decision: "allow" | "allow_always" | "deny") {
    if (!selectedThreadId) {
      return;
    }

    if (decision !== "deny") {
      startWaitingAssistant(selectedThreadId);
    }
    setResolvingPermissionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    setError(null);

    try {
      await api.resolvePermission(selectedThreadId, {
        requestId,
        decision,
      });
    } catch (resolveError) {
      if (decision !== "deny") {
        setWaitingAssistant((current) => (current?.threadId === selectedThreadId ? null : current));
      }
      setError(resolveError instanceof Error ? resolveError.message : "Failed to resolve permission");
    } finally {
      setResolvingPermissionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  const pendingQuestionRequests = useMemo<PendingQuestionRequest[]>(() => {
    const pendingById = new Map<string, PendingQuestionRequest>();
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);

    for (const event of orderedEvents) {
      if (event.type === "question.requested") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length === 0) {
          continue;
        }

        const rawQuestions = Array.isArray(event.payload.questions) ? event.payload.questions : [];
        const questions: QuestionItem[] = rawQuestions.map((q: Record<string, unknown>) => ({
          question: typeof q.question === "string" ? q.question : "",
          header: typeof q.header === "string" ? q.header : undefined,
          options: Array.isArray(q.options)
            ? q.options.map((o: Record<string, unknown>) => ({
              label: typeof o.label === "string" ? o.label : "",
              description: typeof o.description === "string" ? o.description : undefined,
            }))
            : undefined,
          multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
        }));

        pendingById.set(requestId, { requestId, questions, idx: event.idx });
        continue;
      }

      if (event.type === "question.answered") {
        const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
        if (requestId.length > 0) {
          pendingById.delete(requestId);
        }
      }
    }

    return Array.from(pendingById.values()).sort((a, b) => a.idx - b.idx);
  }, [events]);

  async function answerQuestion(requestId: string, answers: Record<string, string>) {
    if (!selectedThreadId) {
      return;
    }

    startWaitingAssistant(selectedThreadId);
    setAnsweringQuestionIds((current) => {
      const next = new Set(current);
      next.add(requestId);
      return next;
    });
    setError(null);

    try {
      await api.answerQuestion(selectedThreadId, { requestId, answers });
    } catch (answerError) {
      setWaitingAssistant((current) => (current?.threadId === selectedThreadId ? null : current));
      setError(answerError instanceof Error ? answerError.message : "Failed to answer question");
    } finally {
      setAnsweringQuestionIds((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  type PendingPlan = {
    content: string;
    filePath: string;
    createdIdx: number;
    status: "pending" | "revising" | "sending" | "approved" | "superseded";
  };

  const pendingPlan = useMemo<PendingPlan | null>(() => {
    const orderedEvents = [...events].sort((a, b) => a.idx - b.idx);
    let latestPlan: PendingPlan | null = null;

    for (const event of orderedEvents) {
      if (event.type === "plan.created") {
        const content = typeof event.payload.content === "string" ? event.payload.content : "";
        const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "";
        if (content.length > 0) {
          latestPlan = { content, filePath, createdIdx: event.idx, status: "pending" };
        }
      } else if (event.type === "plan.approved") {
        if (latestPlan) {
          latestPlan = {
            content: latestPlan.content,
            filePath: latestPlan.filePath,
            createdIdx: latestPlan.createdIdx,
            status: "approved",
          };
        }
      } else if (event.type === "plan.revision_requested") {
        if (latestPlan) {
          latestPlan = {
            content: latestPlan.content,
            filePath: latestPlan.filePath,
            createdIdx: latestPlan.createdIdx,
            status: "sending",
          };
        }
      }
    }

    return latestPlan;
  }, [events]);

  const [planActionBusy, setPlanActionBusy] = useState(false);
  const [closedPlanDecision, setClosedPlanDecision] = useState<{ threadId: string; createdIdx: number } | null>(null);

  async function handleApprovePlan() {
    if (!selectedThreadId) {
      return;
    }

    startWaitingAssistant(selectedThreadId);
    setPlanActionBusy(true);
    setError(null);

    try {
      await api.approvePlan(selectedThreadId);
      if (pendingPlan) {
        setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
      }
    } catch (approveError) {
      setWaitingAssistant((current) => (current?.threadId === selectedThreadId ? null : current));
      setError(approveError instanceof Error ? approveError.message : "Failed to approve plan");
    } finally {
      setPlanActionBusy(false);
    }
  }

  async function handleRevisePlan(feedback: string) {
    if (!selectedThreadId) {
      return;
    }

    startWaitingAssistant(selectedThreadId);
    setPlanActionBusy(true);
    setError(null);

    try {
      await api.revisePlan(selectedThreadId, { feedback });
      if (pendingPlan) {
        setClosedPlanDecision({ threadId: selectedThreadId, createdIdx: pendingPlan.createdIdx });
      }
    } catch (reviseError) {
      setWaitingAssistant((current) => (current?.threadId === selectedThreadId ? null : current));
      setError(reviseError instanceof Error ? reviseError.message : "Failed to revise plan");
    } finally {
      setPlanActionBusy(false);
    }
  }

  const timelineItems = useMemo<ChatTimelineItem[]>(() => {
    const orderedEventsByIdx = [...events].sort((a, b) => a.idx - b.idx);

    const firstMessageEventIdxById = new Map<string, number>();
    const completedMessageIds = new Set<string>();
    const completedEventIdxByMessageId = new Map<string, number>();
    for (const event of orderedEventsByIdx) {
      const messageId = getEventMessageId(event);
      if (messageId) {
        const currentIdx = firstMessageEventIdxById.get(messageId);
        if (currentIdx == null || event.idx < currentIdx) {
          firstMessageEventIdxById.set(messageId, event.idx);
        }
      }

      const completedId = getCompletedMessageId(event);
      if (completedId) {
        completedMessageIds.add(completedId);
        const currentCompletedIdx = completedEventIdxByMessageId.get(completedId);
        if (currentCompletedIdx == null || event.idx < currentCompletedIdx) {
          completedEventIdxByMessageId.set(completedId, event.idx);
        }
      }
    }

    const planFileOutputByMessageId = new Map<string, {
      id: string;
      messageId: string;
      content: string;
      filePath: string;
      idx: number;
      createdAt: string;
    }>();
    for (const event of orderedEventsByIdx) {
      if (event.type !== "plan.created") {
        continue;
      }

      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
      if (messageId.length === 0) {
        continue;
      }

      if (!isClaudePlanFilePayload(event.payload)) {
        continue;
      }

      const content = typeof event.payload.content === "string" ? event.payload.content : "";
      const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "plan.md";
      if (content.trim().length === 0) {
        continue;
      }

      planFileOutputByMessageId.set(messageId, {
        id: event.id,
        messageId,
        content,
        filePath,
        idx: event.idx,
        createdAt: event.createdAt,
      });
    }

    const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);
    const latestUserPromptByAssistantId = new Map<string, string>();
    let latestUserPrompt = "";
    for (const message of sortedMessages) {
      if (message.role === "user") {
        latestUserPrompt = message.content;
        continue;
      }

      if (message.role === "assistant") {
        latestUserPromptByAssistantId.set(message.id, latestUserPrompt);
      }
    }

    const inlineToolEvents = orderedEventsByIdx.filter((event) => INLINE_TOOL_EVENT_TYPES.has(event.type));
    const assistantDeltaEventsByMessageId = new Map<string, ChatEvent[]>();
    for (const event of orderedEventsByIdx) {
      if (event.type !== "message.delta" || event.payload.role !== "assistant") {
        continue;
      }

      const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : null;
      if (!messageId) {
        continue;
      }

      const existing = assistantDeltaEventsByMessageId.get(messageId) ?? [];
      existing.push(event);
      assistantDeltaEventsByMessageId.set(messageId, existing);
    }

    const assistantContextById = new Map<string, ChatEvent[]>();
    const assistantMessages = sortedMessages.filter((message) => message.role === "assistant");
    const nextAssistantStartIdxByMessageId = new Map<string, number>();
    for (let index = 0; index < assistantMessages.length; index += 1) {
      const currentMessage = assistantMessages[index];
      for (let nextIndex = index + 1; nextIndex < assistantMessages.length; nextIndex += 1) {
        const nextStartIdx = firstMessageEventIdxById.get(assistantMessages[nextIndex].id);
        if (typeof nextStartIdx === "number") {
          nextAssistantStartIdxByMessageId.set(currentMessage.id, nextStartIdx);
          break;
        }
      }
    }

    let previousAssistantBoundaryIdx = -1;
    for (const message of assistantMessages) {
      const completedIdx = completedEventIdxByMessageId.get(message.id);
      const nextAssistantStartIdx = nextAssistantStartIdxByMessageId.get(message.id);
      const upperBoundaryIdx =
        typeof completedIdx === "number"
          ? completedIdx
          : typeof nextAssistantStartIdx === "number"
            ? nextAssistantStartIdx - 1
            : Number.POSITIVE_INFINITY;
      const context = inlineToolEvents.filter((event) => {
        if (event.idx <= previousAssistantBoundaryIdx) {
          return false;
        }
        return event.idx <= upperBoundaryIdx;
      });

      assistantContextById.set(message.id, context);
      pushRenderDebug({
        source: "WorkspacePage",
        event: "activityContextCollected",
        messageId: message.id,
        details: {
          upperBoundaryIdx,
          contextSize: context.length,
          contextEvents: context.map((event) => ({
            id: event.id,
            idx: event.idx,
            type: event.type,
          })),
        },
      });
      if (Number.isFinite(upperBoundaryIdx)) {
        previousAssistantBoundaryIdx = Math.max(previousAssistantBoundaryIdx, upperBoundaryIdx);
      }
    }

    type SortableEntry = {
      item: ChatTimelineItem;
      anchorIdx: number;
      timestamp: number | null;
      rank: number;
      stableOrder: number;
    };
    const sortable: SortableEntry[] = [];
    const assignedToolEventIds = new Set<string>();

    for (const message of sortedMessages) {
      const anchorIdx = firstMessageEventIdxById.get(message.id) ?? MAX_ORDER_INDEX;
      const firstAssistantDeltaTimestamp = message.role === "assistant"
        ? parseTimestamp(assistantDeltaEventsByMessageId.get(message.id)?.[0]?.createdAt ?? "")
        : null;
      const timestamp = firstAssistantDeltaTimestamp ?? parseTimestamp(message.createdAt);
      const context = message.role === "assistant" ? assistantContextById.get(message.id) ?? [] : [];
      const nearestUserPrompt = latestUserPromptByAssistantId.get(message.id) ?? "";
      const hasReadContext = context.some((event) => isReadToolEvent(event));
      const looksLikeFileRead = promptLooksLikeFileRead(nearestUserPrompt);
      const isReadResponseContext = hasReadContext || looksLikeFileRead;
      const hasMessageDelta = firstMessageEventIdxById.has(message.id);
      const isCompleted = message.role === "assistant" ? completedMessageIds.has(message.id) : false;
      const planFileOutput = message.role === "assistant" ? planFileOutputByMessageId.get(message.id) : undefined;
      const shouldSkipMessageBecausePlanCard =
        message.role === "assistant" &&
        !!planFileOutput &&
        message.content.trim().length > 0 &&
        message.content.trim() === planFileOutput.content.trim();

      if (
        message.role === "assistant" &&
        (shouldSkipMessageBecausePlanCard || (message.content.trim().length === 0 && !isCompleted && !hasMessageDelta))
      ) {
        continue;
      }

      const hasUnclosedFence = message.role === "assistant" ? hasUnclosedCodeFence(message.content) : false;
      if (message.role === "assistant" && !isCompleted && hasUnclosedFence && !isReadResponseContext) {
        stickyRawFallbackMessageIdsRef.current.add(message.id);
      }
      if (message.role === "assistant" && isCompleted) {
        stickyRawFallbackMessageIdsRef.current.delete(message.id);
      }
      const shouldRenderRawFallback =
        message.role === "assistant"
        && !isCompleted
        && !isReadResponseContext
        && stickyRawFallbackMessageIdsRef.current.has(message.id);
      const isStreamingMessage = message.role === "assistant" && streamingMessageIdsRef.current.has(message.id) && !isCompleted;
      if (message.role === "assistant") {
        const decisionSignature = [
          isReadResponseContext ? "read:1" : "read:0",
          shouldRenderRawFallback ? "fallback:1" : "fallback:0",
          `ctx:${context.length}`,
          `len:${message.content.length}`,
        ].join("|");
        const previousSignature = renderDecisionByMessageIdRef.current.get(message.id);
        if (decisionSignature !== previousSignature) {
          renderDecisionByMessageIdRef.current.set(message.id, decisionSignature);
          pushRenderDebug({
            source: "WorkspacePage",
            event: "rawFileDecision",
            messageId: message.id,
            details: {
              isReadResponseContext,
              shouldRenderRawFallback,
              contextCount: context.length,
              contentLength: message.content.length,
            },
          });
        }
      }
      const renderHint: AssistantRenderHint | undefined =
        message.role === "assistant"
          ? (() => {
            if (isLikelyDiffContent(message.content)) {
              return "diff";
            }

            if (shouldRenderRawFallback) {
              if (isStreamingMessage) {
                return "markdown";
              }
              return "raw-fallback";
            }

            return "markdown";
          })()
          : undefined;

      const bashRuns = message.role === "assistant" ? extractBashRuns(context) : [];
      const bashRunEventIds = new Set<string>();
      const permissionToolNameByRequestId = new Map<string, string>();
      if (message.role === "assistant") {
        for (const event of context) {
          if (event.type !== "permission.requested") {
            continue;
          }
          const requestId = payloadStringOrNull(event.payload.requestId);
          const toolName = payloadStringOrNull(event.payload.toolName);
          if (!requestId || !toolName) {
            continue;
          }
          permissionToolNameByRequestId.set(requestId, toolName.toLowerCase());
        }
        for (const run of bashRuns) {
          run.eventIds.forEach((eventId) => bashRunEventIds.add(eventId));
        }
      }

      const nonBashContext = message.role === "assistant"
        ? context.filter((event) => {
          if (isBashToolEvent(event) || bashRunEventIds.has(event.id)) {
            return false;
          }

          if (bashRuns.length > 0 && (event.type === "permission.requested" || event.type === "permission.resolved")) {
            if (event.type === "permission.requested") {
              const toolName = payloadStringOrNull(event.payload.toolName)?.toLowerCase();
              if (toolName === "bash") {
                return false;
              }
            } else {
              const requestId = payloadStringOrNull(event.payload.requestId);
              if (requestId && permissionToolNameByRequestId.get(requestId) === "bash") {
                return false;
              }
            }
          }

          return true;
        })
        : context;
      const exploreActivityGroups = message.role === "assistant" ? extractExploreActivityGroups(nonBashContext) : [];
      const exploreEventIds = new Set<string>();
      for (const group of exploreActivityGroups) {
        group.eventIds.forEach((id) => exploreEventIds.add(id));
      }
      const activityContext = message.role === "assistant"
        ? nonBashContext.filter((event) => !isWorktreeDiffEvent(event) && !exploreEventIds.has(event.id))
        : nonBashContext;
      if (message.role === "assistant") {
        for (const run of bashRuns) {
          run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
      }
      const editedRuns = message.role === "assistant" ? extractEditedRuns(nonBashContext, context) : [];
      if (message.role === "assistant") {
        for (const run of editedRuns) {
          run.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
        for (const group of exploreActivityGroups) {
          group.eventIds.forEach((eventId) => assignedToolEventIds.add(eventId));
        }
      }

      if (message.role === "assistant" && activityContext.length > 0 && bashRuns.length === 0) {
        const steps = buildActivitySteps(activityContext);
        const contextTimestamp = parseTimestamp(activityContext[0]?.createdAt ?? message.createdAt);
        pushRenderDebug({
          source: "WorkspacePage",
          event: "activityStepsBuilt",
          messageId: message.id,
          details: {
            contextSize: activityContext.length,
            stepSize: steps.length,
            steps,
          },
        });
        if (steps.length > 0) {
          activityContext.forEach((event) => assignedToolEventIds.add(event.id));
          sortable.push({
            item: {
              kind: "activity",
              messageId: message.id,
              durationSeconds: computeDurationSecondsFromEvents(activityContext),
              introText: buildActivityIntroText(message.content),
              steps,
              defaultExpanded: isStreamingMessage,
            },
            anchorIdx,
            timestamp: contextTimestamp,
            rank: 2,
            stableOrder: message.seq,
          });
        }
      }

      if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0 || exploreActivityGroups.length > 0)) {
        const hasInlineExploreRuns = exploreActivityGroups.length > 0;
        type InlineInsert =
          | {
            kind: "bash";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            run: BashRun;
          }
          | {
            kind: "edited";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            run: EditedRun;
          }
          | {
            kind: "explore-activity";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            group: ExploreActivityGroup;
          };

        const inlineInserts: InlineInsert[] = [
          ...bashRuns.map((run, index) => ({
            kind: "bash" as const,
            id: `bash:${run.toolUseId}:${index}`,
            startIdx: run.startIdx,
            anchorIdx: run.anchorIdx,
            createdAt: run.createdAt,
            run,
          })),
          ...editedRuns.map((run, index) => ({
            kind: "edited" as const,
            id: `edited:${run.eventId}:${index}`,
            startIdx: run.startIdx,
            anchorIdx: run.anchorIdx,
            createdAt: run.createdAt,
            run,
          })),
          ...(hasInlineExploreRuns ? exploreActivityGroups.map((group, index) => ({
            kind: "explore-activity" as const,
            id: `explore:${group.id}:${index}`,
            startIdx: group.startIdx,
            anchorIdx: group.anchorIdx,
            createdAt: group.createdAt,
            group,
          })) : []),
        ].sort((a, b) => {
          if (a.startIdx !== b.startIdx) {
            return a.startIdx - b.startIdx;
          }

          if (a.anchorIdx !== b.anchorIdx) {
            return a.anchorIdx - b.anchorIdx;
          }

          return a.id.localeCompare(b.id);
        });

        const messageDeltaEvents = assistantDeltaEventsByMessageId.get(message.id) ?? [];
        const segmentBuckets = Array.from({ length: inlineInserts.length + 1 }, () => ({
          content: "",
          anchorIdx: null as number | null,
          timestamp: null as number | null,
        }));

        for (const deltaEvent of messageDeltaEvents) {
          const deltaText = typeof deltaEvent.payload.delta === "string" ? deltaEvent.payload.delta : "";
          if (deltaText.length === 0) {
            continue;
          }

          let bucketIndex = inlineInserts.findIndex((insert) => deltaEvent.idx < insert.startIdx);
          if (bucketIndex < 0) {
            bucketIndex = inlineInserts.length;
          }

          const bucket = segmentBuckets[bucketIndex];
          bucket.content += deltaText;
          bucket.anchorIdx = bucket.anchorIdx == null ? deltaEvent.idx : Math.min(bucket.anchorIdx, deltaEvent.idx);
          if (bucket.timestamp == null) {
            bucket.timestamp = parseTimestamp(deltaEvent.createdAt);
          }
        }

        const hasSegmentContent = segmentBuckets.some((bucket) => bucket.content.length > 0);
        if (!hasSegmentContent && message.content.length > 0) {
          const shouldPlaceFallbackAfterInserts =
            inlineInserts.length > 0 && inlineInserts.every((insert) => insert.startIdx <= anchorIdx);
          const fallbackBucketIndex = shouldPlaceFallbackAfterInserts ? inlineInserts.length : 0;
          segmentBuckets[fallbackBucketIndex] = {
            content: message.content,
            anchorIdx,
            timestamp,
          };
        }

        const hasLeadingText = segmentBuckets[0].content.length > 0;
        const hasAnyTrailingText = segmentBuckets.slice(1).some((bucket) => bucket.content.length > 0);
        const firstInsertKind = inlineInserts[0]?.kind ?? null;
        const deferFirstInsertUntilText =
          !hasLeadingText
          && hasAnyTrailingText
          && inlineInserts.length > 0
          && !isSentenceAwareInlineInsertKind(firstInsertKind);
        const delayFirstInlineInsert = shouldDelayFirstInlineInsert(
          firstInsertKind,
          segmentBuckets[0]?.content ?? "",
          hasAnyTrailingText,
        );
        let shouldDelayFirstInsert = deferFirstInsertUntilText || delayFirstInlineInsert;
        let nextInsertIndex = 0;
        let stableOffset = 0;
        let delayedFirstSegmentContent = "";
        let delayedFirstSegmentAnchorIdx: number | null = null;
        let delayedFirstSegmentTimestamp: number | null = null;

        function pushInlineInsert(insert: InlineInsert, bucketTimestamp?: number | null, bucketAnchorIdx?: number | null) {
          if (insert.kind === "bash") {
            const run = insert.run;
            const status = run.status === "running" && isCompleted ? "success" : run.status;
            sortable.push({
              item: {
                kind: "bash-command",
                id: `${message.id}:${run.toolUseId}:${insert.id}`,
                toolUseId: run.toolUseId,
                shell: "bash",
                command: run.command,
                summary: run.summary,
                output: run.output,
                error: run.error,
                truncated: run.truncated,
                durationSeconds: run.durationSeconds,
                status,
                rejectedByUser: run.rejectedByUser,
              },
              anchorIdx: bucketAnchorIdx ?? run.anchorIdx,
              timestamp: parseTimestamp(run.createdAt) ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;
            return;
          }

          if (insert.kind === "edited") {
            const run = insert.run;
            sortable.push({
              item: {
                kind: "edited-diff",
                id: `${message.id}:${run.eventId}:${insert.id}`,
                eventId: run.eventId,
                status: run.status,
                diffKind: run.diffKind,
                changedFiles: run.changedFiles,
                diff: run.diff,
                diffTruncated: run.diffTruncated,
                additions: run.additions,
                deletions: run.deletions,
                rejectedByUser: run.rejectedByUser,
                createdAt: run.createdAt,
              },
              anchorIdx: bucketAnchorIdx ?? run.anchorIdx,
              timestamp: bucketTimestamp ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;
            return;
          }

          const group = insert.group;
          sortable.push({
            item: {
              kind: "explore-activity",
              id: `${message.id}:${group.id}:${insert.id}`,
              status: group.status,
              fileCount: group.fileCount,
              searchCount: group.searchCount,
              entries: group.entries,
            },
            anchorIdx: bucketAnchorIdx ?? group.anchorIdx,
            timestamp: bucketTimestamp ?? timestamp,
            rank: 3,
            stableOrder: message.seq + stableOffset,
          });
          stableOffset += 0.001;
        }

        function pushMessageSegment(content: string, segmentIdSuffix: string, segmentAnchorIdx: number | null, segmentTimestamp: number | null) {
          if (content.length === 0) {
            return;
          }

          const segmentMessage: ChatMessage = {
            ...message,
            id: `${message.id}:segment:${segmentIdSuffix}`,
            content,
          };
          sortable.push({
            item: {
              kind: "message",
              message: segmentMessage,
              renderHint: renderHint === "diff" ? "diff" : "markdown",
              rawFileLanguage: undefined,
              isCompleted,
              context: nonBashContext,
            },
            anchorIdx: segmentAnchorIdx ?? anchorIdx,
            timestamp: segmentTimestamp ?? timestamp,
            rank: 3,
            stableOrder: message.seq + stableOffset,
          });
          stableOffset += 0.001;
        }

        for (let bucketIndex = 0; bucketIndex < segmentBuckets.length; bucketIndex += 1) {
          const bucket = segmentBuckets[bucketIndex];
          if (bucket.content.length > 0) {
            if (
              shouldDelayFirstInsert
              && nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
            ) {
              delayedFirstSegmentContent += bucket.content;
              delayedFirstSegmentAnchorIdx = delayedFirstSegmentAnchorIdx == null
                ? bucket.anchorIdx
                : bucket.anchorIdx == null
                  ? delayedFirstSegmentAnchorIdx
                  : Math.min(delayedFirstSegmentAnchorIdx, bucket.anchorIdx);
              if (delayedFirstSegmentTimestamp == null) {
                delayedFirstSegmentTimestamp = bucket.timestamp;
              }

              const splitSegment = splitAtFirstSentenceBoundary(delayedFirstSegmentContent);
              const isLastBucket = bucketIndex === segmentBuckets.length - 1;
              if (!splitSegment && !isLastBucket) {
                continue;
              }

              if (splitSegment) {
                pushMessageSegment(
                  splitSegment.head,
                  `${bucketIndex}:delayed-head`,
                  delayedFirstSegmentAnchorIdx,
                  delayedFirstSegmentTimestamp,
                );
                pushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx ?? delayedFirstSegmentAnchorIdx);
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
                if (splitSegment.tail.length > 0) {
                  pushMessageSegment(
                    splitSegment.tail,
                    `${bucketIndex}:delayed-tail`,
                    bucket.anchorIdx ?? delayedFirstSegmentAnchorIdx,
                    bucket.timestamp ?? delayedFirstSegmentTimestamp,
                  );
                }
              } else {
                pushMessageSegment(
                  delayedFirstSegmentContent,
                  `${bucketIndex}:delayed-fallback`,
                  delayedFirstSegmentAnchorIdx,
                  delayedFirstSegmentTimestamp,
                );
                pushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx ?? delayedFirstSegmentAnchorIdx);
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
              }

              delayedFirstSegmentContent = "";
              delayedFirstSegmentAnchorIdx = null;
              delayedFirstSegmentTimestamp = null;
              continue;
            }

            let segmentRendered = false;
            if (
              nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
              && hasAnyTrailingText
              && inlineInserts.length > 0
            ) {
              const splitSegment = hasSentenceBoundary(bucket.content) ? splitAtFirstSentenceBoundary(bucket.content) : null;
              if (splitSegment) {
                pushMessageSegment(splitSegment.head, `${bucketIndex}:head`, bucket.anchorIdx, bucket.timestamp);
                pushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx);
                nextInsertIndex = 1;
                shouldDelayFirstInsert = false;
                pushMessageSegment(splitSegment.tail, `${bucketIndex}:tail`, bucket.anchorIdx, bucket.timestamp);
                segmentRendered = true;
              }
            }

            if (!segmentRendered) {
              pushMessageSegment(bucket.content, `${bucketIndex}`, bucket.anchorIdx, bucket.timestamp);
            }

            if (shouldDelayFirstInsert && nextInsertIndex === 0 && bucketIndex > 0) {
              pushInlineInsert(inlineInserts[0], bucket.timestamp, bucket.anchorIdx);
              nextInsertIndex = 1;
              shouldDelayFirstInsert = false;
            }
          }

          while (nextInsertIndex <= bucketIndex && nextInsertIndex < inlineInserts.length) {
            const shouldHoldLeadingSentenceAwareInsert =
              nextInsertIndex === 0
              && isSentenceAwareInlineInsertKind(firstInsertKind)
              && hasAnyTrailingText
              && bucketIndex === 0;
            if (shouldHoldLeadingSentenceAwareInsert) {
              break;
            }
            if (shouldDelayFirstInsert && nextInsertIndex === 0) {
              break;
            }
            pushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
            nextInsertIndex += 1;
          }
        }

        while (nextInsertIndex < inlineInserts.length) {
          pushInlineInsert(inlineInserts[nextInsertIndex], segmentBuckets[nextInsertIndex]?.timestamp);
          nextInsertIndex += 1;
        }

        continue;
      }

      sortable.push({
        item: {
          kind: "message",
          message,
          renderHint,
          rawFileLanguage: undefined,
          isCompleted,
          context: nonBashContext,
        },
        anchorIdx,
        timestamp,
        rank: message.role === "assistant" ? 3 : message.role === "user" ? 1 : 4,
        stableOrder: message.seq,
      });
    }

    for (const planFileOutput of planFileOutputByMessageId.values()) {
      sortable.push({
        item: {
          kind: "plan-file-output",
          id: planFileOutput.id,
          messageId: planFileOutput.messageId,
          content: planFileOutput.content,
          filePath: planFileOutput.filePath,
          createdAt: planFileOutput.createdAt,
        },
        anchorIdx: planFileOutput.idx,
        timestamp: parseTimestamp(planFileOutput.createdAt),
        rank: 3,
        stableOrder: planFileOutput.idx + 0.0005,
      });
    }

    const orphanToolEvents = inlineToolEvents
      .filter((event) => !assignedToolEventIds.has(event.id))
      .filter((event) => event.type !== "permission.requested" && event.type !== "permission.resolved")
      .sort((a, b) => a.idx - b.idx);
    pushRenderDebug({
      source: "WorkspacePage",
      event: "activityOrphanToolEvents",
      details: {
        inlineToolEventCount: inlineToolEvents.length,
        assignedToolEventCount: assignedToolEventIds.size,
        orphanCount: orphanToolEvents.length,
        orphanEvents: orphanToolEvents.map((event) => ({
          id: event.id,
          idx: event.idx,
          type: event.type,
        })),
      },
    });
    if (selectedThreadId) {
      const loggedOrphanEventIds = ensureLoggedOrphanEventIds(selectedThreadId);
      for (const event of orphanToolEvents) {
        if (loggedOrphanEventIds.has(event.id)) {
          continue;
        }

        loggedOrphanEventIds.add(event.id);
        logService.log("warn", "chat.sync", "Tool event not attached to assistant timeline", {
          threadId: selectedThreadId,
          eventId: event.id,
          idx: event.idx,
          type: event.type,
          toolUseId: typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : null,
          toolName: typeof event.payload.toolName === "string" ? event.payload.toolName : null,
        });
      }
    }
    for (const event of orphanToolEvents) {
      if (isWorktreeDiffEvent(event)) {
        const diff = payloadStringOrNull(event.payload.diff) ?? "";
        const { additions, deletions } = countDiffStats(diff);
        sortable.push({
          item: {
            kind: "edited-diff",
            id: `orphan:${event.id}`,
            eventId: event.id,
            status: "success",
            diffKind: "actual",
            changedFiles: payloadStringArray(event.payload.changedFiles),
            diff,
            diffTruncated: event.payload.diffTruncated === true,
            additions,
            deletions,
            rejectedByUser: false,
            createdAt: event.createdAt,
          },
          anchorIdx: event.idx,
          timestamp: parseTimestamp(event.createdAt),
          rank: 0,
          stableOrder: event.idx,
        });
        continue;
      }

      sortable.push({
        item: {
          kind: "tool",
          event,
        },
        anchorIdx: event.idx,
        timestamp: parseTimestamp(event.createdAt),
        rank: 0,
        stableOrder: event.idx,
      });
    }

    sortable.sort((a, b) => {
      if (a.anchorIdx !== b.anchorIdx) {
        return a.anchorIdx - b.anchorIdx;
      }

      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }

      if (a.stableOrder !== b.stableOrder) {
        return a.stableOrder - b.stableOrder;
      }

      const aTime = a.timestamp ?? MAX_ORDER_INDEX;
      const bTime = b.timestamp ?? MAX_ORDER_INDEX;
      return aTime - bTime;
    });

    return sortable.map((entry) => entry.item);
  }, [messages, events, selectedThreadId]);

  const hasPendingPermissionRequests = pendingPermissionRequests.length > 0;
  const hasPendingQuestionRequests = pendingQuestionRequests.length > 0;
  const hasPendingPlan = pendingPlan !== null && pendingPlan.status === "pending";
  const hasStreamingAssistantMessage =
    selectedThreadId != null
    && messages.some(
      (message) =>
        message.threadId === selectedThreadId
        && message.role === "assistant"
        && streamingMessageIdsRef.current.has(message.id),
    );
  const showStopAction =
    selectedThreadId != null
    && (sendingMessage || waitingAssistant?.threadId === selectedThreadId || hasStreamingAssistantMessage);
  const stopRequestedForActiveThread = selectedThreadId != null && stopRequestedThreadId === selectedThreadId;
  const stoppingRun =
    selectedThreadId != null && (stoppingThreadId === selectedThreadId || stopRequestedForActiveThread);
  const hidePlanDecisionByOptimisticClose =
    hasPendingPlan &&
    selectedThreadId != null &&
    closedPlanDecision?.threadId === selectedThreadId &&
    closedPlanDecision.createdIdx === pendingPlan.createdIdx;
  const showPlanDecisionComposer = hasPendingPlan && !hidePlanDecisionByOptimisticClose;
  const isWaitingForUserGate = hasPendingPermissionRequests || hasPendingQuestionRequests || showPlanDecisionComposer;
  const showThinkingPlaceholder = waitingAssistant?.threadId === selectedThreadId && !isWaitingForUserGate;

  const openReadFile = useCallback(async (filePath: string) => {
    if (!selectedWorktreeId) {
      setError("Worktree is not selected");
      return;
    }

    try {
      await api.openWorktreeFile(selectedWorktreeId, { path: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open file";
      setError(message);
    }
  }, [selectedWorktreeId]);

  useEffect(() => {
    if (!showStopAction) {
      setStopRequestedThreadId(null);
    }
  }, [showStopAction]);

  // ── Sidebar resize state ──
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarStartXRef = useRef(0);
  const sidebarStartWidthRef = useRef(0);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarDragging(true);
    sidebarStartXRef.current = e.clientX;
    sidebarStartWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!sidebarDragging) return;

    function onMove(e: MouseEvent) {
      const delta = e.clientX - sidebarStartXRef.current;
      setSidebarWidth(Math.max(200, Math.min(500, sidebarStartWidthRef.current + delta)));
    }
    function onUp() {
      setSidebarDragging(false);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [sidebarDragging]);

  return (
    <div className="flex h-full p-2 sm:p-3">
      <div className="mx-auto flex min-h-0 w-full max-w-[1860px]">
        {/* ── Resizable sidebar ── */}
        <aside
          className="hidden min-h-0 shrink-0 rounded-2xl bg-card/75 p-2 lg:block lg:p-3"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="mb-3">
            <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
            <p className="text-xs text-muted-foreground">Local code conductor</p>
          </div>

          <RepositoryPanel
            repositories={repositories}
            selectedRepositoryId={selectedRepositoryId}
            selectedWorktreeId={selectedWorktreeId}
            loadingRepos={loadingRepos}
            submittingRepo={submittingRepo}
            submittingWorktree={submittingWorktree}
            onAttachRepository={() => void attachRepository()}
            onSelectRepository={setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              setSelectedRepositoryId(repositoryId);
              setSelectedWorktreeId(worktreeId);
            }}
            onDeleteWorktree={(worktreeId) => void removeWorktree(worktreeId)}
          />
        </aside>

        {/* ── Sidebar resize handle ── */}
        <div
          className={`hidden w-1 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20 lg:flex ${sidebarDragging ? "bg-primary/30" : ""
            }`}
          onMouseDown={handleSidebarMouseDown}
        >
          <div
            className={`h-8 w-[2px] rounded-full transition-colors ${sidebarDragging ? "bg-primary/60" : "bg-border/30"
              }`}
          />
        </div>

        {/* ── Main content area (chat + bottom panel) ── */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-2.5 lg:p-3">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <WorkspaceHeader
              selectedRepositoryName={selectedRepository?.name ?? "No repository selected"}
              selectedWorktreeLabel={selectedWorktree ? `Worktree: ${selectedWorktree.branch}` : "Choose a worktree"}
              threads={threads}
              selectedThreadId={selectedThreadId}
              disabled={!selectedWorktreeId}
              closingThreadId={closingThreadId}
              onSelectThread={setSelectedThreadId}
              onCreateThread={() => void createAdditionalThread()}
              onCloseThread={(threadId) => void closeThread(threadId)}
            />

            {error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {error}
              </div>
            ) : null}

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1">
                <ChatMessageList
                  items={timelineItems}
                  showThinkingPlaceholder={showThinkingPlaceholder}
                  onOpenReadFile={openReadFile}
                />
              </div>
            </section>
            {pendingPermissionRequests.length > 0 ? (
              <section className="mx-auto w-full max-w-3xl px-3" data-testid="permission-prompts-container">
                <div className="space-y-2">
                  {pendingPermissionRequests.map((request) => (
                    <PermissionPromptCard
                      key={request.requestId}
                      requestId={request.requestId}
                      toolName={request.toolName}
                      command={request.command}
                      blockedPath={request.blockedPath}
                      decisionReason={request.decisionReason}
                      busy={resolvingPermissionIds.has(request.requestId)}
                      canAlwaysAllow={Boolean(request.command)}
                      onAllowOnce={(requestId) => void resolvePermission(requestId, "allow")}
                      onAllowAlways={(requestId) => void resolvePermission(requestId, "allow_always")}
                      onDeny={(requestId) => void resolvePermission(requestId, "deny")}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {pendingQuestionRequests.length > 0 ? (
              <section className="mx-auto w-full max-w-3xl px-3" data-testid="question-prompts-container">
                <div className="space-y-2">
                  {pendingQuestionRequests.map((request) => (
                    <QuestionCard
                      key={request.requestId}
                      requestId={request.requestId}
                      questions={request.questions}
                      busy={answeringQuestionIds.has(request.requestId)}
                      onAnswer={(requestId, answers) => void answerQuestion(requestId, answers)}
                    />
                  ))}
                </div>
              </section>
            ) : null}


            {showPlanDecisionComposer ? (
              <PlanDecisionComposer
                busy={planActionBusy}
                onApprove={() => void handleApprovePlan()}
                onRevise={(feedback) => void handleRevisePlan(feedback)}
              />
            ) : (
              <Composer
                value={chatInput}
                disabled={!selectedThreadId || sendingMessage || hasPendingPermissionRequests || hasPendingQuestionRequests || planActionBusy}
                sending={sendingMessage}
                showStop={showStopAction}
                stopping={stoppingRun}
                mode={chatMode}
                worktreeId={selectedWorktreeId}
                onChange={setChatInput}
                onModeChange={setChatMode}
                onSubmitMessage={(content) => void submitMessage(content)}
                onStop={() => void stopAssistantRun()}
              />
            )}
          </div>

          <BottomPanel worktreeId={selectedWorktreeId} worktreePath={selectedWorktree?.path ?? null} />
        </main>
      </div>
    </div>
  );
}
