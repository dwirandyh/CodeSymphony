import type { ChatEvent, Repository } from "@codesymphony/shared-types";
import type { ActivityTraceStep } from "../../components/workspace/ChatMessageList";
import {
  EXPLORE_BASH_COMMAND_PATTERN,
  FILE_PATH_PATTERN,
  MCP_TOOL_PATTERN,
  READ_PROMPT_PATTERN,
  READ_TOOL_PATTERN,
  SEARCH_TOOL_PATTERN,
  TRIM_FILE_TOKEN_PATTERN,
} from "./constants";
import type { StepCandidate } from "./types";

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
  if (rawSource === "claude_plan_file" || rawSource === "streaming_fallback") {
    return true;
  }

  const filePath = typeof payload.filePath === "string" ? payload.filePath : "";
  return isPlanFilePath(filePath);
}

export function isPlanFilePath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  return filePath.includes(".claude/plans/") || filePath.includes("codesymphony-claude-provider/plans/");
}

export function isPlanModeToolEvent(event: ChatEvent): boolean {
  const toolName = payloadStringOrNull(event.payload.toolName)?.toLowerCase() ?? "";
  if (toolName === "exitplanmode" || toolName === "enterplanmode") return true;
  const filePath = payloadStringOrNull(event.payload.file_path)
    ?? payloadStringOrNull(event.payload.filePath) ?? "";
  if ((toolName === "edit" || toolName === "write") && isPlanFilePath(filePath)) return true;
  return false;
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

export function isExploreLikeBashCommand(command: string | null | undefined): boolean {
  if (!command || command.trim().length === 0) {
    return false;
  }
  return EXPLORE_BASH_COMMAND_PATTERN.test(command.trim());
}

export function isExploreLikeBashEvent(event: ChatEvent): boolean {
  if (!isBashToolEvent(event)) {
    return false;
  }
  const command = payloadStringOrNull(event.payload.command);
  return isExploreLikeBashCommand(command);
}

export function isWorktreeDiffEvent(event: ChatEvent): boolean {
  return event.type === "tool.finished" && event.payload.source === "worktree.diff";
}

export function isMetadataToolEvent(event: ChatEvent): boolean {
  return event.payload.source === "chat.thread.metadata";
}

export function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

export function isReadToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event)) {
    return false;
  }

  return READ_TOOL_PATTERN.test(eventPayloadText(event));
}

export function isSearchToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed" || event.type === "permission.requested" || event.type === "permission.resolved") {
    return false;
  }

  if (isBashToolEvent(event) || isReadToolEvent(event)) {
    return false;
  }

  return SEARCH_TOOL_PATTERN.test(eventPayloadText(event));
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
  if (event.type !== "message.delta" && event.type !== "thinking.delta") {
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

  if (event.type === "thinking.delta") {
    return true;
  }

  return event.type === "permission.requested" || event.type === "question.requested" || event.type === "question.dismissed" || event.type === "plan.created";
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
