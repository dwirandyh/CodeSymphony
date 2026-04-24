import type { ActivityTraceStep, ChatEvent, Repository } from "@codesymphony/shared-types";
import {
  EXPLORE_BASH_COMMAND_PATTERN,
  FILE_PATH_PATTERN,
  INLINE_TOOL_EVENT_TYPES,
  MCP_TOOL_PATTERN,
  READ_PROMPT_PATTERN,
  READ_TOOL_PATTERN,
  SEARCH_TOOL_PATTERN,
  TRIM_FILE_TOKEN_PATTERN,
} from "./constants";
import type { StepCandidate } from "./types";

type SemanticBoundaryKind = "plan-file-output" | "subagent-activity" | "explore-activity" | "edited-diff" | "fallback-tool";

type SemanticBoundary = {
  kind: SemanticBoundaryKind;
  eventId: string;
  eventIdx: number;
  eventType: ChatEvent["type"];
};

// ── Payload helpers ──

export function payloadStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.length > 0 ? value : null;
}

export function payloadStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

// ── Event classification ──

export function isClaudePlanFilePayload(payload: Record<string, unknown>): boolean {
  const rawSource = payload.source;
  if (rawSource === "claude_plan_file" || rawSource === "codex_plan_item") {
    return true;
  }

  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  return isPlanFilePath(filePath);
}

type NormalizedPlanCreatedEvent = {
  id: string;
  messageId: string;
  content: string;
  filePath: string;
  idx: number;
  createdAt: string;
};

export function normalizePlanCreatedEvent(event: ChatEvent, orderedEvents: ChatEvent[]): NormalizedPlanCreatedEvent | null {
  if (event.type !== "plan.created") {
    return null;
  }

  const rawSource = event.payload.source;
  if (rawSource !== "streaming_fallback" && !isClaudePlanFilePayload(event.payload)) {
    return null;
  }

  const messageId = payloadStringOrNull(event.payload.messageId) ?? "";
  let content = payloadStringOrNull(event.payload.content) ?? "";
  let filePath = payloadStringOrNull(event.payload.filePath) ?? "plan.md";
  if (content.trim().length === 0) {
    return null;
  }

  if (event.payload.source === "streaming_fallback" && !isPlanFilePath(filePath)) {
    const realWrite = orderedEvents.find((candidate) =>
      candidate.idx > event.idx
      && candidate.type === "tool.finished"
      && isPlanFilePath(
        payloadStringOrNull(candidate.payload.editTarget)
          ?? payloadStringOrNull(candidate.payload.file_path)
          ?? "",
      )
    );
    if (!realWrite) {
      return null;
    }

    const toolInput = isRecord(realWrite.payload.toolInput) ? realWrite.payload.toolInput : null;
    const realContent = toolInput ? payloadStringOrNull(toolInput.content) : null;
    const realPath = payloadStringOrNull(realWrite.payload.editTarget)
      ?? payloadStringOrNull(realWrite.payload.file_path)
      ?? filePath;
    if (!realContent || realContent.trim().length === 0) {
      return null;
    }

    content = realContent;
    filePath = realPath;
    return {
      id: realWrite.id,
      messageId,
      content,
      filePath,
      idx: realWrite.idx,
      createdAt: realWrite.createdAt,
    };
  }

  return {
    id: event.id,
    messageId,
    content,
    filePath,
    idx: event.idx,
    createdAt: event.createdAt,
  };
}

export function isPlanFilePath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  return (
    filePath.includes(".claude/plans/")
    || filePath.includes(".cursor/plans/")
    || filePath.includes("codesymphony-claude-provider/plans/")
  );
}

export function isPlanModeToolEvent(event: ChatEvent): boolean {
  const toolName = payloadStringOrNull(event.payload.toolName)?.toLowerCase() ?? "";
  if (toolName === "exitplanmode" || toolName === "enterplanmode") return true;
  const filePath = payloadStringOrNull(event.payload.file_path)
    ?? payloadStringOrNull(event.payload.filePath) ?? "";
  if ((toolName === "edit" || toolName === "write") && isPlanFilePath(filePath)) return true;
  return false;
}

function isTodoWriteToolEvent(event: ChatEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
    return false;
  }

  return payloadStringOrNull(event.payload.toolName)?.trim().toLowerCase() === "todowrite";
}

export function isBashPayload(payload: Record<string, unknown>): boolean {
  if (payload.isBash === true || payload.shell === "bash") {
    return true;
  }

  const toolName = payload.toolName;
  return typeof toolName === "string" && toolName.trim().toLowerCase() === "bash";
}

export function isBashToolEvent(event: ChatEvent): boolean {
  if (event.type !== "tool.started" && event.type !== "tool.output" && event.type !== "tool.finished") {
    return false;
  }

  return isBashPayload(event.payload);
}

function splitTopLevelShellCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktickQuote = false;
  let escaped = false;

  const pushSegment = (): boolean => {
    const trimmed = current.trim();
    if (trimmed.length === 0) {
      return false;
    }

    segments.push(trimmed);
    current = "";
    return true;
  };

  for (let idx = 0; idx < command.length; idx += 1) {
    const char = command[idx];
    const next = idx + 1 < command.length ? command[idx + 1] : "";

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && !inSingleQuote) {
      current += char;
      escaped = true;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += char;
      if (char === "\"") {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inBacktickQuote) {
      current += char;
      if (char === "`") {
        inBacktickQuote = false;
      }
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      continue;
    }

    if (char === "\"") {
      inDoubleQuote = true;
      current += char;
      continue;
    }

    if (char === "`") {
      inBacktickQuote = true;
      current += char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      if (!pushSegment()) {
        return null;
      }
      idx += 1;
      continue;
    }

    if (char === ";" || char === "|") {
      if (!pushSegment()) {
        return null;
      }
      continue;
    }

    current += char;
  }

  if (escaped || inSingleQuote || inDoubleQuote || inBacktickQuote) {
    return null;
  }

  if (!pushSegment()) {
    return null;
  }

  return segments;
}

function extractShellCommandHead(segment: string): string | null {
  const trimmed = segment.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const [head] = trimmed.split(/\s+/, 1);
  return head && head.length > 0 ? head : null;
}

export function isExploreLikeBashCommand(command: string | null | undefined): boolean {
  if (!command || command.trim().length === 0) {
    return false;
  }

  const segments = splitTopLevelShellCommandSegments(command);
  if (!segments || segments.length === 0) {
    return false;
  }

  for (const segment of segments) {
    const head = extractShellCommandHead(segment);
    if (!head || !EXPLORE_BASH_COMMAND_PATTERN.test(head)) {
      return false;
    }
  }

  return true;
}

function extractBashCommandFromPayload(payload: Record<string, unknown>): string | null {
  const directCommand = payloadStringOrNull(payload.command);
  if (directCommand) {
    return directCommand;
  }

  const toolInput = isRecord(payload.toolInput) ? payload.toolInput : null;
  return toolInput ? payloadStringOrNull(toolInput.command) : null;
}

export function isExploreLikeBashEvent(event: ChatEvent): boolean {
  if (!isBashToolEvent(event)) {
    return false;
  }
  const command = extractBashCommandFromPayload(event.payload);
  return isExploreLikeBashCommand(command);
}

export const GIT_STATUS_INVALIDATION_EVENT_TYPES = new Set<ChatEvent["type"]>([
  "tool.finished",
  "chat.completed",
  "chat.failed",
]);

export function isWorktreeDiffEvent(event: ChatEvent): boolean {
  return event.type === "tool.finished" && event.payload.source === "worktree.diff";
}

export function isMetadataToolEvent(event: ChatEvent): boolean {
  return event.payload.source === "chat.thread.metadata";
}

export function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

function eventClassificationText(event: ChatEvent): string {
  if (isWorktreeDiffEvent(event) || isMetadataToolEvent(event)) {
    return "";
  }

  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  };

  const payload = event.payload;
  push(payload.toolName);
  push(payload.summary);
  push(payload.command);
  push(payload.searchParams);
  push(payload.file_path);
  push(payload.filePath);
  push(payload.path);
  push(payload.editTarget);
  push(payload.target);

  const toolInput = isRecord(payload.toolInput) ? payload.toolInput : null;
  if (toolInput) {
    push(toolInput.toolName);
    push(toolInput.command);
    push(toolInput.searchParams);
    push(toolInput.file_path);
    push(toolInput.filePath);
    push(toolInput.path);
    push(toolInput.editTarget);
    push(toolInput.target);
    push(toolInput.pattern);
    push(toolInput.query);
  }

  return parts.join(" ").toLowerCase();
}

export function isReadToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event)) {
    return false;
  }

  return READ_TOOL_PATTERN.test(eventClassificationText(event));
}

export function isSearchToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event) || isReadToolEvent(event)) {
    return false;
  }

  return SEARCH_TOOL_PATTERN.test(eventClassificationText(event));
}

// ── Event data extraction ──

export function findRepositoryByWorktree(repositories: Repository[], worktreeId: string | null): Repository | null {
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

export function parseTimestamp(input: string): number | null {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getEventMessageId(event: ChatEvent): string | null {
  if (event.type !== "message.delta") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

export function getCompletedMessageId(event: ChatEvent): string | null {
  if (event.type !== "chat.completed") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

export function shouldClearWaitingAssistantOnEvent(event: ChatEvent): boolean {
  if (event.type === "chat.completed" || event.type === "chat.failed") {
    return true;
  }

  if (event.type === "message.delta") {
    return event.payload.role === "assistant";
  }

  if (
    event.type === "tool.started"
    || event.type === "tool.output"
    || event.type === "tool.finished"
  ) {
    return true;
  }

  return event.type === "permission.requested" || event.type === "question.requested";
}

// ── Content helpers ──

export function extractFirstFilePath(text: string): string | null {
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

export function promptLooksLikeFileRead(prompt: string): boolean {
  return READ_PROMPT_PATTERN.test(prompt) && extractFirstFilePath(prompt) != null;
}

export function hasUnclosedCodeFence(content: string): boolean {
  const fenceCount = (content.match(/(^|\n)```/g) ?? []).length;
  return fenceCount % 2 !== 0;
}

export function isLikelyDiffContent(content: string): boolean {
  return /^(diff --git .+|--- [^\r\n]+|\+\+\+ [^\r\n]+|@@ .+ @@)/m.test(content);
}

// ── Diff helpers ──

export function filterDiffByFiles(diff: string, targetFiles: string[]): string {
  if (targetFiles.length === 0 || diff.length === 0) return diff;
  const sections: string[] = [];
  let currentLines: string[] = [];
  let include = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (include && currentLines.length > 0) sections.push(currentLines.join("\n"));
      currentLines = [line];
      const m = line.match(/diff --git a\/(.+?) b\/(.+)/);
      const fp = m ? m[2] : null;
      include = fp != null && targetFiles.some((t) => fp === t || fp.endsWith("/" + t) || t.endsWith("/" + fp));
    } else {
      currentLines.push(line);
    }
  }
  if (include && currentLines.length > 0) sections.push(currentLines.join("\n"));
  return sections.join("\n");
}

export function countDiffStats(diff: string): { additions: number; deletions: number } {
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

// ── Activity step helpers ──

export function activityStepLabel(event: ChatEvent, detail: string): string {
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

export function toolEventDetail(event: ChatEvent): string {
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

export function buildActivitySteps(context: ChatEvent[]): ActivityTraceStep[] {
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

export function computeDurationSecondsFromEvents(events: ChatEvent[]): number {
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

export function buildActivityIntroText(content: string): string | null {
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

// ── Shared tool helpers ──

export function finishedToolUseIds(event: ChatEvent): string[] {
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

export function detectSemanticBoundaryFromEvents(events: ChatEvent[]): SemanticBoundary | null {
  const ordered = [...events].sort((a, b) => a.idx - b.idx);

  for (const event of ordered) {
    if (isMetadataToolEvent(event)) {
      continue;
    }

    if (event.type === "plan.created" && normalizePlanCreatedEvent(event, ordered)) {
      return {
        kind: "plan-file-output",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }

    if (event.type === "subagent.started" || event.type === "subagent.finished") {
      return {
        kind: "subagent-activity",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }

    if (!INLINE_TOOL_EVENT_TYPES.has(event.type)) {
      continue;
    }

    if (event.type === "chat.failed") {
      continue;
    }

    if (event.type === "permission.requested" || event.type === "permission.resolved") {
      continue;
    }

    if (event.type === "question.requested" || event.type === "question.answered" || event.type === "question.dismissed") {
      continue;
    }

    if (event.type === "plan.approved" || event.type === "plan.dismissed" || event.type === "plan.revision_requested") {
      continue;
    }

    if (isPlanModeToolEvent(event)) {
      continue;
    }

    if (isWorktreeDiffEvent(event)) {
      return {
        kind: "edited-diff",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }

    if (isExploreLikeBashEvent(event) || isReadToolEvent(event) || isSearchToolEvent(event)) {
      return {
        kind: "explore-activity",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }

    if (isBashToolEvent(event)) {
      return {
        kind: "fallback-tool",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }

    if (event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.finished") {
      return {
        kind: "fallback-tool",
        eventId: event.id,
        eventIdx: event.idx,
        eventType: event.type,
      };
    }
  }

  return null;
}
