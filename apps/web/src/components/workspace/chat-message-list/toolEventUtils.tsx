import type { ChatEvent } from "@codesymphony/shared-types";
import type { ChatTimelineItem } from "./ChatMessageList.types";

const WHITESPACE_REGEX = /\s/;
const MCP_TOOL_PREFIX = "mcp__";

function isMcpToolName(value: unknown): value is string {
  return typeof value === "string" && value.toLowerCase().startsWith(MCP_TOOL_PREFIX);
}

function mcpToolNameFromEvent(event: ChatEvent): string | null {
  const toolName = event.payload.toolName;
  return isMcpToolName(toolName) ? toolName : null;
}

export function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

export function toolTitle(event: ChatEvent): string {
  if (event.payload.source === "worktree.diff") {
    return "Worktree changed";
  }

  const mcpToolName = mcpToolNameFromEvent(event);
  if (mcpToolName) {
    const hasError = typeof event.payload.error === "string" && event.payload.error.length > 0;
    if (event.type === "tool.started") {
      return `Running ${mcpToolName}`;
    }
    if (hasError) {
      return `Failed ${mcpToolName}`;
    }
    return `Ran ${mcpToolName}`;
  }

  const payload = eventPayloadText(event);
  const looksLikeExploreTool = /\b(glob|grep|search|find|list|scan|ls)\b/i.test(payload);
  const looksLikeReadTool = /\b(read|open|cat)\b/i.test(payload);

  if (event.type === "chat.failed") {
    return "chat.failed";
  }

  if (event.type === "permission.requested") {
    return "permission.requested";
  }

  if (event.type === "permission.resolved") {
    return "permission.resolved";
  }

  if (looksLikeReadTool) {
    return "Read file";
  }

  if (looksLikeExploreTool) {
    return "Explored";
  }

  if (event.type === "tool.started") {
    return "Running";
  }

  if (event.type === "tool.output") {
    return "tool.output";
  }

  return "tool.finished";
}

export function toolSubtitle(event: ChatEvent): string {
  if (event.payload.source === "worktree.diff") {
    const summary = event.payload.summary;
    return typeof summary === "string" && summary.length > 0 ? summary : "Detected worktree changes";
  }

  const mcpToolName = mcpToolNameFromEvent(event);
  if (mcpToolName) {
    if (event.type === "tool.finished") {
      return String(event.payload.summary ?? mcpToolName);
    }
    return mcpToolName;
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

  if (event.type === "tool.started") {
    const name = String(event.payload.toolName ?? "Tool");
    return `${name} (running)`;
  }

  if (event.type === "tool.output") {
    const name = String(event.payload.toolName ?? "Tool");
    const elapsed = Number(event.payload.elapsedTimeSeconds ?? 0);
    if (Number.isFinite(elapsed) && elapsed > 0) {
      return `${name} (${elapsed.toFixed(1)}s)`;
    }
    return name;
  }

  if (event.type === "tool.finished") {
    return String(event.payload.summary ?? "Tool finished");
  }

  return String(event.payload.message ?? "Chat failed");
}

export function formatCompactDurationSeconds(durationSeconds: number | null): string | null {
  if (durationSeconds == null) {
    return null;
  }

  const value = Number(durationSeconds);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return `${Math.max(1, Math.round(value))}s`;
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (char === "\\") {
        const next = command[index + 1];
        if (next === quote || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }

      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (WHITESPACE_REGEX.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\") {
      const next = command[index + 1];
      if (typeof next === "string") {
        current += next;
        index += 1;
        continue;
      }
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

export function isPathLikeToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }

  if (token.includes("/") || token.includes("\\")) {
    return true;
  }

  return token.startsWith("~/") || token.startsWith("./") || token.startsWith("../");
}

export function basenameFromTokenPath(token: string): string {
  const normalized = token.replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return token;
  }
  return parts[parts.length - 1];
}

export function shortenCommandToken(token: string): string {
  const equalIndex = token.indexOf("=");
  if (equalIndex > 0) {
    const key = token.slice(0, equalIndex);
    const value = token.slice(equalIndex + 1);
    if (isPathLikeToken(value)) {
      return `${key}=${basenameFromTokenPath(value)}`;
    }
  }

  if (isPathLikeToken(token)) {
    return basenameFromTokenPath(token);
  }

  return token;
}

export function truncateSummaryText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

export function shortenCommandForSummary(command: string | null): string | null {
  if (typeof command !== "string") {
    return null;
  }

  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0) {
    return truncateSummaryText(trimmed, 90);
  }

  const shortened = tokens.map(shortenCommandToken).join(" ");
  return truncateSummaryText(shortened, 90);
}

export function getChangedFiles(event: ChatEvent): string[] {
  const value = event.payload.changedFiles;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function getDiffPreview(event: ChatEvent): string | null {
  const value = event.payload.diff;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function editedSummaryLabel({
  changeSource,
  status,
  diffKind,
  changedFiles,
  additions,
  deletions,
  rejectedByUser,
}: {
  changeSource?: "edit-tool" | "worktree-diff";
  status: "running" | "success" | "failed";
  diffKind: "proposed" | "actual" | "none";
  changedFiles: string[];
  additions: number;
  deletions: number;
  rejectedByUser?: boolean;
}): React.ReactNode {
  const firstFile = basenameFromTokenPath(changedFiles[0] ?? "file");
  const fileCount = changedFiles.length > 1 ? ` (${changedFiles.length} files)` : "";
  const isWorktreeDiff = changeSource === "worktree-diff";

  if (status === "running") {
    return isWorktreeDiff ? `Detecting changes for ${firstFile}${fileCount}` : `Editing ${firstFile}${fileCount}`;
  }

  if (status === "failed") {
    if (rejectedByUser) {
      return `Rejected by user: ${firstFile}${fileCount}`;
    }
    return isWorktreeDiff ? `Failed detecting changes for ${firstFile}${fileCount}` : `Failed editing ${firstFile}${fileCount}`;
  }

  const isDeleteOnly = additions === 0 && deletions > 0;
  const verb = isWorktreeDiff
    ? (isDeleteOnly ? "Command deleted" : "Command changed")
    : (isDeleteOnly ? "Deleted" : "Edited");

  if (diffKind === "none") {
    return `${verb} ${firstFile}${fileCount}`;
  }

  return (
    <>
      {verb} {firstFile}{" "}
      <span className="text-emerald-400">+{additions}</span>{" "}
      <span className="text-red-400">-{deletions}</span>
      {fileCount}
    </>
  );
}

export function getTimelineItemKey(item: ChatTimelineItem): string {
  switch (item.kind) {
    case "message":
      return `message:${item.message.id}`;
    case "plan-file-output":
      return `plan-file-output:${item.id}`;
    case "activity":
      return `activity:${item.messageId}`;
    case "tool":
      return `tool:${item.id}`;
    case "edited-diff":
      return `edited-diff:${item.id}`;
    case "subagent-activity":
      return `subagent-activity:${item.id}`;
    case "explore-activity":
      return `explore-activity:${item.id}`;
    case "error":
      return `error:${item.id}`;
    default:
      return `unknown:${JSON.stringify(item)}`;
  }
}

export function isExplicitNoGrowthResult(params: {
  completionReason: string | null;
  estimatedRenderableGrowth: boolean | null;
  messagesAdded: number;
  eventsAdded: number;
}): boolean {
  const { completionReason, estimatedRenderableGrowth, messagesAdded, eventsAdded } = params;
  return completionReason === "empty-cursors"
    || completionReason === "thread-changed"
    || estimatedRenderableGrowth === false
    || (completionReason === "applied" && messagesAdded + eventsAdded <= 0);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function downloadTextFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
