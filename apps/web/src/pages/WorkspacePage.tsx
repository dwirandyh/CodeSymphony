import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, ChatMode, ChatThread, Repository } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/Composer";
import {
  ChatMessageList,
  type ActivityTraceStep,
  type AssistantRenderHint,
  type ChatTimelineItem,
} from "../components/workspace/ChatMessageList";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { api } from "../lib/api";
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
const MCP_TOOL_PATTERN = /\bmcp\b/i;
const READ_PROMPT_PATTERN =
  /\b(read|open|show|cat|display|view|find|locate|buka\w*|lihat\w*|isi\w*|lengkap|full|ulang|repeat|cari\w*|temu\w*|kasih\s*tau)\b/i;
const FILE_PATH_PATTERN = /(?:[~./\w-]+\/)?[\w.-]+\.[a-z0-9]{1,10}\b|readme(?:\.md)?\b/gi;
const TRIM_FILE_TOKEN_PATTERN = /^[`"'([{<\s]+|[`"',.;:)\]}>/\\\s]+$/g;

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

function inferLanguageFromPath(filePath: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const normalizedPath = filePath.toLowerCase().split(/[?#]/, 1)[0];
  if (normalizedPath.endsWith("readme") || normalizedPath.endsWith("readme.md")) {
    return "md";
  }

  const lastDot = normalizedPath.lastIndexOf(".");
  if (lastDot < 0 || lastDot === normalizedPath.length - 1) {
    return undefined;
  }

  return normalizedPath.slice(lastDot + 1);
}

function inferRawFileLanguage(context: ChatEvent[], prompt: string): string {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const event = context[index];
    if (!isReadToolEvent(event)) {
      continue;
    }

    const pathFromEvent = extractFirstFilePath(JSON.stringify(event.payload ?? {}));
    const language = inferLanguageFromPath(pathFromEvent);
    if (language) {
      return language;
    }
  }

  const pathFromPrompt = extractFirstFilePath(prompt);
  return inferLanguageFromPath(pathFromPrompt) ?? "text";
}

function hasUnclosedCodeFence(content: string): boolean {
  const fenceCount = (content.match(/(^|\n)```/g) ?? []).length;
  return fenceCount % 2 !== 0;
}

function isLikelyDiffContent(content: string): boolean {
  return /^(diff --git|---\s|\+\+\+\s|@@\s)/m.test(content);
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

    if (event.type === "tool.started") {
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
  createdAt: string;
  eventIds: Set<string>;
};

type EditedRun = {
  id: string;
  eventId: string;
  startIdx: number;
  anchorIdx: number;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
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
  const hasBashToolLifecycleEvents = ordered.some((event) => isBashToolEvent(event));

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
      ? precedingToolUseIds
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

  if (!hasBashToolLifecycleEvents) {
    for (const event of ordered) {
      if (event.type === "permission.requested") {
        const requestId = payloadStringOrNull(event.payload.requestId);
        const toolName = payloadStringOrNull(event.payload.toolName);
        const command = payloadStringOrNull(event.payload.command);
        if (!requestId || !toolName || toolName.toLowerCase() !== "bash" || !command) {
          continue;
        }

        byToolUseId.set(`permission:${requestId}`, {
          id: `bash:permission:${requestId}`,
          toolUseId: `permission:${requestId}`,
          startIdx: event.idx,
          anchorIdx: event.idx,
          summary: "Awaiting approval",
          command,
          output: null,
          error: null,
          truncated: false,
          durationSeconds: null,
          status: "running",
          createdAt: event.createdAt,
          eventIds: new Set([event.id]),
        });
        continue;
      }

      if (event.type !== "permission.resolved") {
        continue;
      }

      const requestId = payloadStringOrNull(event.payload.requestId);
      if (!requestId) {
        continue;
      }

      const key = `permission:${requestId}`;
      const run = byToolUseId.get(key);
      if (!run) {
        continue;
      }

      const decision = payloadStringOrNull(event.payload.decision);
      const message = payloadStringOrNull(event.payload.message);
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
        run.error = message ?? "Denied by user";
      } else if (decision === "allow" || decision === "allow_always") {
        run.status = "success";
      }
    }
  }

  return Array.from(byToolUseId.values()).sort((a, b) => a.startIdx - b.startIdx);
}

function extractEditedRuns(context: ChatEvent[], fullContext?: ChatEvent[]): EditedRun[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const runs: EditedRun[] = [];

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

  for (const event of ordered) {
    if (!isWorktreeDiffEvent(event)) {
      continue;
    }

    const anchorIdx = bestAnchorIdx ?? event.idx;
    const diff = payloadStringOrNull(event.payload.diff) ?? "";
    const changedFiles = payloadStringArray(event.payload.changedFiles);
    const { additions, deletions } = countDiffStats(diff);
    runs.push({
      id: `edited:${event.id}`,
      eventId: event.id,
      startIdx: anchorIdx,
      anchorIdx,
      changedFiles,
      diff,
      diffTruncated: event.payload.diffTruncated === true,
      additions,
      deletions,
      createdAt: event.createdAt,
      eventIds: new Set([event.id]),
    });
  }

  return runs;
}

type ReadRunGroup = {
  id: string;
  files: string[];
  startIdx: number;
  anchorIdx: number;
  createdAt: string;
  eventIds: Set<string>;
};

function extractReadFilename(event: ChatEvent): string {
  const summary = payloadStringOrNull(event.payload.summary);
  if (summary) {
    // Strip common prefixes like "Read ", "Opened " to get the filename
    const stripped = summary.replace(/^(Read|Opened|Cat)\s+/i, "").trim();
    if (stripped.length > 0) {
      return stripped;
    }
  }
  return "file";
}

function extractReadRunGroups(context: ChatEvent[]): ReadRunGroup[] {
  const ordered = [...context].sort((a, b) => a.idx - b.idx);
  const groups: ReadRunGroup[] = [];
  let currentGroup: ReadRunGroup | null = null;

  for (const event of ordered) {
    // Only group tool.finished read events. message.delta breaks a run.
    if (event.type === "message.delta") {
      if (currentGroup) {
        groups.push(currentGroup);
        currentGroup = null;
      }
      continue;
    }

    if (!isReadToolEvent(event)) {
      continue;
    }

    const filename = extractReadFilename(event);
    if (currentGroup) {
      currentGroup.files.push(filename);
      currentGroup.eventIds.add(event.id);
    } else {
      currentGroup = {
        id: `read:${event.id}`,
        files: [filename],
        startIdx: event.idx,
        anchorIdx: event.idx,
        createdAt: event.createdAt,
        eventIds: new Set([event.id]),
      };
    }
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

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
  const stickyRawFileMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFileLanguageByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());

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
      stickyRawFileMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      stickyRawFileLanguageByMessageIdRef.current = new Map();
      setMessages([]);
      setEvents([]);
      return;
    }

    streamingMessageIdsRef.current = new Set();
    stickyRawFileMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    stickyRawFileLanguageByMessageIdRef.current = new Map();
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
          if (completedMessageId.length > 0) {
            streamingMessageIdsRef.current.delete(completedMessageId);
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
      const timestamp = parseTimestamp(message.createdAt);
      const context = message.role === "assistant" ? assistantContextById.get(message.id) ?? [] : [];
      const nearestUserPrompt = latestUserPromptByAssistantId.get(message.id) ?? "";
      const hasReadContext = context.some((event) => isReadToolEvent(event));
      const looksLikeFileRead = promptLooksLikeFileRead(nearestUserPrompt);
      const shouldRenderRawFileNow = hasReadContext || looksLikeFileRead;
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
      if (message.role === "assistant" && shouldRenderRawFileNow) {
        stickyRawFileMessageIdsRef.current.add(message.id);
      }
      if (message.role === "assistant" && !isCompleted && hasUnclosedFence) {
        stickyRawFallbackMessageIdsRef.current.add(message.id);
      }
      if (message.role === "assistant" && isCompleted) {
        stickyRawFallbackMessageIdsRef.current.delete(message.id);
      }
      const shouldRenderRawFile = message.role === "assistant" && stickyRawFileMessageIdsRef.current.has(message.id);
      const shouldRenderRawFallback =
        message.role === "assistant" && !isCompleted && stickyRawFallbackMessageIdsRef.current.has(message.id);
      const isStreamingMessage = message.role === "assistant" && streamingMessageIdsRef.current.has(message.id) && !isCompleted;
      const inferredLanguage = shouldRenderRawFile ? inferRawFileLanguage(context, nearestUserPrompt) : undefined;
      if (message.role === "assistant" && shouldRenderRawFile && inferredLanguage && inferredLanguage !== "text") {
        stickyRawFileLanguageByMessageIdRef.current.set(message.id, inferredLanguage);
      }
      const stickyLanguage = stickyRawFileLanguageByMessageIdRef.current.get(message.id);
      if (message.role === "assistant") {
        const decisionSignature = [
          shouldRenderRawFileNow ? "now:1" : "now:0",
          shouldRenderRawFile ? "sticky:1" : "sticky:0",
          shouldRenderRawFallback ? "fallback:1" : "fallback:0",
          inferredLanguage ?? "infer:none",
          stickyLanguage ?? "stickyLang:none",
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
              shouldRenderRawFileNow,
              shouldRenderRawFile,
              inferredLanguage,
              stickyLanguage,
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

            if (shouldRenderRawFile) {
              if (isStreamingMessage) {
                return "markdown";
              }
              return "raw-file";
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
      if (message.role === "assistant") {
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
            return false;
          }

          return true;
        })
        : context;
      const readRunGroups = message.role === "assistant" ? extractReadRunGroups(nonBashContext) : [];
      const readEventIds = new Set<string>();
      for (const group of readRunGroups) {
        group.eventIds.forEach((id) => readEventIds.add(id));
      }
      const activityContext = message.role === "assistant"
        ? nonBashContext.filter((event) => !isWorktreeDiffEvent(event) && !readEventIds.has(event.id))
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
        for (const group of readRunGroups) {
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

      // Push standalone read-files groups when no bash/edited runs trigger
      // inline segmentation — we don't want read events to break text segments.
      if (message.role === "assistant" && readRunGroups.length > 0 && bashRuns.length === 0 && editedRuns.length === 0) {
        for (const group of readRunGroups) {
          sortable.push({
            item: {
              kind: "read-files",
              id: `${message.id}:${group.id}`,
              files: group.files,
            },
            anchorIdx: group.anchorIdx,
            timestamp: parseTimestamp(group.createdAt) ?? timestamp,
            rank: 3,
            stableOrder: message.seq + 0.0005,
          });
        }
      }

      if (message.role === "assistant" && (bashRuns.length > 0 || editedRuns.length > 0)) {
        const hasInlineReadRuns = readRunGroups.length > 0;
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
            kind: "read-files";
            id: string;
            startIdx: number;
            anchorIdx: number;
            createdAt: string;
            group: ReadRunGroup;
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
          ...(hasInlineReadRuns ? readRunGroups.map((group, index) => ({
            kind: "read-files" as const,
            id: `read:${group.id}:${index}`,
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
          segmentBuckets[0] = {
            content: message.content,
            anchorIdx,
            timestamp,
          };
        }

        const hasLeadingText = segmentBuckets[0].content.length > 0;
        const hasAnyTrailingText = segmentBuckets.slice(1).some((bucket) => bucket.content.length > 0);
        const deferFirstInsertUntilText = !hasLeadingText && hasAnyTrailingText && inlineInserts.length > 0;
        let delayedFirstInsertInserted = false;
        let stableOffset = 0;

        function pushInlineInsert(insert: InlineInsert, bucketTimestamp?: number | null) {
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
              },
              anchorIdx: run.anchorIdx,
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
                changedFiles: run.changedFiles,
                diff: run.diff,
                diffTruncated: run.diffTruncated,
                additions: run.additions,
                deletions: run.deletions,
                createdAt: run.createdAt,
              },
              anchorIdx: run.anchorIdx,
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
              kind: "read-files",
              id: `${message.id}:${group.id}:${insert.id}`,
              files: group.files,
            },
            anchorIdx: group.anchorIdx,
            timestamp: bucketTimestamp ?? timestamp,
            rank: 3,
            stableOrder: message.seq + stableOffset,
          });
          stableOffset += 0.001;
        }

        for (let bucketIndex = 0; bucketIndex < segmentBuckets.length; bucketIndex += 1) {
          const bucket = segmentBuckets[bucketIndex];
          if (bucket.content.length > 0) {
            const segmentMessage: ChatMessage = {
              ...message,
              id: `${message.id}:segment:${bucketIndex}`,
              content: bucket.content,
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
              anchorIdx: bucket.anchorIdx ?? anchorIdx,
              timestamp: bucket.timestamp ?? timestamp,
              rank: 3,
              stableOrder: message.seq + stableOffset,
            });
            stableOffset += 0.001;

            if (deferFirstInsertUntilText && !delayedFirstInsertInserted) {
              pushInlineInsert(inlineInserts[0], bucket.timestamp);
              delayedFirstInsertInserted = true;
            }
          }

          if (bucketIndex >= inlineInserts.length) {
            continue;
          }

          if (deferFirstInsertUntilText && bucketIndex === 0) {
            continue;
          }

          pushInlineInsert(inlineInserts[bucketIndex], segmentBuckets[bucketIndex]?.timestamp);
        }

        continue;
      }

      sortable.push({
        item: {
          kind: "message",
          message,
          renderHint,
          rawFileLanguage: message.role === "assistant" && shouldRenderRawFile ? stickyLanguage ?? inferredLanguage : undefined,
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

    const rawOrphanToolEvents = inlineToolEvents.filter((event) => !assignedToolEventIds.has(event.id));
    const orphanNonPermissionEvents: ChatEvent[] = [];
    const latestPermissionResolvedByRequestId = new Map<string, ChatEvent>();
    const orphanPermissionResolvedWithoutRequestId: ChatEvent[] = [];

    for (const event of rawOrphanToolEvents) {
      if (event.type === "permission.requested") {
        continue;
      }

      if (event.type === "tool.started") {
        continue;
      }

      if (event.type !== "permission.resolved") {
        orphanNonPermissionEvents.push(event);
        continue;
      }

      const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : "";
      if (requestId.length === 0) {
        orphanPermissionResolvedWithoutRequestId.push(event);
        continue;
      }

      const existing = latestPermissionResolvedByRequestId.get(requestId);
      if (!existing || event.idx > existing.idx) {
        latestPermissionResolvedByRequestId.set(requestId, event);
      }
    }

    const orphanToolEvents = [
      ...orphanNonPermissionEvents,
      ...orphanPermissionResolvedWithoutRequestId,
      ...Array.from(latestPermissionResolvedByRequestId.values()),
    ].sort((a, b) => a.idx - b.idx);
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
    for (const event of orphanToolEvents) {
      if (isWorktreeDiffEvent(event)) {
        const diff = payloadStringOrNull(event.payload.diff) ?? "";
        const { additions, deletions } = countDiffStats(diff);
        sortable.push({
          item: {
            kind: "edited-diff",
            id: `orphan:${event.id}`,
            eventId: event.id,
            changedFiles: payloadStringArray(event.payload.changedFiles),
            diff,
            diffTruncated: event.payload.diffTruncated === true,
            additions,
            deletions,
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
      const aTime = a.timestamp ?? MAX_ORDER_INDEX;
      const bTime = b.timestamp ?? MAX_ORDER_INDEX;
      if (aTime !== bTime) {
        return aTime - bTime;
      }

      if (a.anchorIdx !== b.anchorIdx) {
        return a.anchorIdx - b.anchorIdx;
      }

      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }

      return a.stableOrder - b.stableOrder;
    });

    return sortable.map((entry) => entry.item);
  }, [messages, events]);

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
                <ChatMessageList items={timelineItems} showThinkingPlaceholder={showThinkingPlaceholder} />
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
