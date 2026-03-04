import { useCallback, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChatAttachment, ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { Bot, Brain, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Copy, Download, FileText, Folder, Loader2, Paperclip, XCircle } from "lucide-react";
import type { SubagentStep } from "../../pages/workspace/types";
import { EXPLORE_BASH_COMMAND_PATTERN } from "../../pages/workspace/constants";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { cn } from "../../lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import { copyRenderDebugLog, isRenderDebugEnabled, pushRenderDebug } from "../../lib/renderDebug";
import { parseUserMentions } from "../../lib/mentions";
import { debugLog } from "../../lib/debugLog";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { VList, type VListHandle } from "virtua";

export type AssistantRenderHint = "markdown" | "raw-file" | "raw-fallback" | "diff";

export type ReadFileTimelineEntry = {
  label: string;
  openPath: string | null;
};

export type ExploreActivityEntry = {
  kind: "read" | "search";
  label: string;
  openPath: string | null;
  pending: boolean;
  orderIdx: number;
};

export type ActivityTraceStep = {
  id: string;
  label: string;
  detail: string;
};

// ── Hoisted RegExp constants ──
const ANSI_ESCAPE_REGEX = /\u001b\[([0-9;]*)m/g;
const DIFF_HEADER_REGEX = /^(diff --git .+|--- [^\r\n]+|\+\+\+ [^\r\n]+|@@ .+ @@)/m;
const CODE_FENCE_REGEX = /(^|\n)```/g;
const CLOSE_FENCE_REGEX = /^`{3,}$/;
const WHITESPACE_REGEX = /\s/;

export type ChatTimelineItem =
  | {
    kind: "message";
    message: ChatMessage;
    renderHint?: AssistantRenderHint;
    rawFileLanguage?: string;
    isCompleted?: boolean;
    context?: ChatEvent[];
  }
  | {
    kind: "plan-file-output";
    id: string;
    messageId: string;
    content: string;
    filePath: string;
    createdAt: string;
  }
  | {
    kind: "activity";
    messageId: string;
    durationSeconds: number;
    introText: string | null;
    steps: ActivityTraceStep[];
    defaultExpanded: boolean;
  }
  | {
    kind: "tool";
    event: ChatEvent;
  }
  | {
    kind: "bash-command";
    id: string;
    toolUseId: string;
    shell: "bash";
    command: string | null;
    summary: string | null;
    output: string | null;
    error: string | null;
    truncated: boolean;
    durationSeconds: number | null;
    status: "running" | "success" | "failed";
    rejectedByUser?: boolean;
  }
  | {
    kind: "edited-diff";
    id: string;
    eventId: string;
    status: "running" | "success" | "failed";
    diffKind: "proposed" | "actual" | "none";
    changedFiles: string[];
    diff: string;
    diffTruncated: boolean;
    additions: number;
    deletions: number;
    rejectedByUser?: boolean;
    createdAt: string;
  }
  | {
    kind: "explore-activity";
    id: string;
    status: "running" | "success";
    fileCount: number;
    searchCount: number;
    entries: ExploreActivityEntry[];
  }
  | {
    kind: "subagent-activity";
    id: string;
    agentId: string;
    agentType: string;
    toolUseId: string;
    status: "running" | "success" | "failed";
    description: string;
    lastMessage: string | null;
    steps: SubagentStep[];
    durationSeconds: number | null;
  }
  | {
    kind: "thinking";
    id: string;
    messageId: string;
    content: string;
    isStreaming: boolean;
  }
  | {
    kind: "error";
    id: string;
    message: string;
    createdAt: string;
  };

const TOP_LOAD_REARM_COOLDOWN_MS = 180;
const AT_BOTTOM_THRESHOLD = 48;
// Trigger older-history load before absolute top so users don't stall at offset 0.
const TOP_LOAD_ENTER_THRESHOLD = 180;
const TOP_LOAD_LEAVE_THRESHOLD = 280;
const TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX = 2;
const TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX = 4;
const TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX = 96;
const TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX = 8;
const TOP_LOAD_RELEASE_ANCHOR_LOCK_MS = 600;
const TOP_LOAD_RELEASE_ANCHOR_WATCH_MS = 1500;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_GUARD_MS = 2800;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_MIN_PREV_OFFSET_PX = 16;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_USER_INPUT_GRACE_MS = 140;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_RESTORE_COOLDOWN_MS = 240;

type LoadOlderRequestMetadata = {
  cycleId: number;
  requestId: string;
};

type LoadOlderRequestResult = {
  cycleId?: number | null;
  requestId?: string;
  completionReason?: string;
  messagesAdded?: number;
  eventsAdded?: number;
  estimatedRenderableGrowth?: boolean;
};

function isExplicitNoGrowthResult(params: {
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

function getTimelineItemKey(item: ChatTimelineItem): string {
  switch (item.kind) {
    case "message":
      return `message:${item.message.id}`;
    case "plan-file-output":
      return `plan-file-output:${item.id}`;
    case "activity":
      return `activity:${item.messageId}`;
    case "tool":
      return `tool:${item.event.id}`;
    case "bash-command":
      return `bash-command:${item.id}`;
    case "edited-diff":
      return `edited-diff:${item.id}`;
    case "explore-activity":
      return `explore-activity:${item.id}`;
    case "subagent-activity":
      return `subagent-activity:${item.id}`;
    case "thinking":
      return `thinking:${item.id}`;
    case "error":
      return `error:${item.id}`;
    default:
      return "unknown";
  }
}

type ChatMessageListProps = {
  items: ChatTimelineItem[];
  showThinkingPlaceholder?: boolean;
  sendingMessage?: boolean;
  onOpenReadFile?: (path: string) => void | Promise<void>;
  hasOlderHistory?: boolean;
  loadingOlderHistory?: boolean;
  topPaginationInteractionReady?: boolean;
  onLoadOlderHistory?: (metadata?: LoadOlderRequestMetadata) => Promise<LoadOlderRequestResult | void> | LoadOlderRequestResult | void;
};

type AnsiSegment = {
  text: string;
  fgColor: string | null;
  bold: boolean;
  dim: boolean;
};

type AnsiStyleState = {
  fgColor: string | null;
  bold: boolean;
  dim: boolean;
};

const ANSI_BASIC_FG_COLORS: Record<number, string> = {
  30: "#282c34",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#dcdfe4",
  90: "#5c6370",
  91: "#f44747",
  92: "#89d185",
  93: "#f2cc60",
  94: "#7aa2f7",
  95: "#d299ff",
  96: "#4fd6be",
  97: "#ffffff",
};

const ANSI_COLOR_LEVELS = [0, 95, 135, 175, 215, 255];

function ansi256ToColor(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    return null;
  }

  if (code < 16) {
    const mappedCode = code < 8 ? 30 + code : 90 + (code - 8);
    return ANSI_BASIC_FG_COLORS[mappedCode] ?? null;
  }

  if (code <= 231) {
    const cube = code - 16;
    const r = ANSI_COLOR_LEVELS[Math.floor(cube / 36) % 6];
    const g = ANSI_COLOR_LEVELS[Math.floor(cube / 6) % 6];
    const b = ANSI_COLOR_LEVELS[cube % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }

  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyAnsiCodes(state: AnsiStyleState, rawCodes: number[]): AnsiStyleState {
  const nextState: AnsiStyleState = { ...state };
  const codes = rawCodes.length > 0 ? rawCodes : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!Number.isFinite(code)) {
      continue;
    }

    if (code === 0) {
      nextState.fgColor = null;
      nextState.bold = false;
      nextState.dim = false;
      continue;
    }

    if (code === 1) {
      nextState.bold = true;
      continue;
    }

    if (code === 2) {
      nextState.dim = true;
      continue;
    }

    if (code === 22) {
      nextState.bold = false;
      nextState.dim = false;
      continue;
    }

    if (code === 39) {
      nextState.fgColor = null;
      continue;
    }

    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      nextState.fgColor = ANSI_BASIC_FG_COLORS[code] ?? null;
      continue;
    }

    if (code === 38) {
      const mode = codes[index + 1];
      if (mode === 5) {
        const paletteCode = codes[index + 2];
        const paletteColor = ansi256ToColor(paletteCode);
        if (paletteColor) {
          nextState.fgColor = paletteColor;
        }
        index += 2;
        continue;
      }

      if (mode === 2) {
        const r = codes[index + 2];
        const g = codes[index + 3];
        const b = codes[index + 4];
        if ([r, g, b].every((entry) => Number.isFinite(entry))) {
          nextState.fgColor = `rgb(${r}, ${g}, ${b})`;
        }
        index += 4;
      }
    }
  }

  return nextState;
}

function toAnsiSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  ANSI_ESCAPE_REGEX.lastIndex = 0;
  let state: AnsiStyleState = {
    fgColor: null,
    bold: false,
    dim: false,
  };
  let cursor = 0;

  while (true) {
    const match = ANSI_ESCAPE_REGEX.exec(input);
    if (!match) {
      break;
    }

    if (match.index > cursor) {
      segments.push({
        text: input.slice(cursor, match.index),
        fgColor: state.fgColor,
        bold: state.bold,
        dim: state.dim,
      });
    }

    const rawCodes = match[1]
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => Number(entry));
    state = applyAnsiCodes(state, rawCodes);
    cursor = ANSI_ESCAPE_REGEX.lastIndex;
  }

  if (cursor < input.length) {
    segments.push({
      text: input.slice(cursor),
      fgColor: state.fgColor,
      bold: state.bold,
      dim: state.dim,
    });
  }

  return segments.length > 0
    ? segments
    : [
      {
        text: input,
        fgColor: null,
        bold: false,
        dim: false,
      },
    ];
}

const TerminalOutputPre = memo(function TerminalOutputPre({ text, className }: { text: string; className: string }) {
  const segments = toAnsiSegments(text);

  return (
    <pre className={className}>
      {segments.map((segment, index) => (
        <span
          // Segment order is stable and content-preserving across renders.
          key={`${index}:${segment.text.length}`}
          style={{
            color: segment.fgColor ?? undefined,
            fontWeight: segment.bold ? 600 : undefined,
            opacity: segment.dim ? 0.78 : undefined,
          }}
        >
          {segment.text}
        </span>
      ))}
    </pre>
  );
});

function isLikelyDiff(code: string, language?: string): boolean {
  if (language === "diff") {
    return true;
  }

  return DIFF_HEADER_REGEX.test(code);
}

const SafePatchDiff = memo(function SafePatchDiff({
  patch,
  options,
}: {
  patch: string;
  options: React.ComponentProps<typeof FileDiff>["options"];
}) {
  const files = useMemo(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return null;
    }
  }, [patch]);

  if (!files || files.length === 0) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
        {patch}
      </pre>
    );
  }

  return (
    <>
      {files.map((file, index) => (
        <FileDiff key={`${file.name}:${index}`} fileDiff={file} options={options} />
      ))}
    </>
  );
});

function hasUnclosedCodeFence(content: string): boolean {
  CODE_FENCE_REGEX.lastIndex = 0;
  const fenceCount = (content.match(CODE_FENCE_REGEX) ?? []).length;
  return fenceCount % 2 !== 0;
}

function splitRawFileContentWithMode(
  content: string,
  requireClosingFence: boolean,
): {
  lead: string;
  code: string;
  tail: string;
  language?: string;
} | null {
  const fenceStart = content.indexOf("```");
  if (fenceStart < 0) {
    return null;
  }

  const openFenceLineEnd = content.indexOf("\n", fenceStart + 3);
  if (openFenceLineEnd < 0) {
    return null;
  }

  const openFenceLine = content.slice(fenceStart + 3, openFenceLineEnd).trim();
  if (!requireClosingFence) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const closeFenceLineStart = content.lastIndexOf("\n```");
  if (closeFenceLineStart <= openFenceLineEnd) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const closeFenceLineEndRaw = content.indexOf("\n", closeFenceLineStart + 1);
  const closeFenceLineEnd = closeFenceLineEndRaw < 0 ? content.length : closeFenceLineEndRaw;
  const closeFenceLine = content.slice(closeFenceLineStart + 1, closeFenceLineEnd).trim();
  if (!CLOSE_FENCE_REGEX.test(closeFenceLine)) {
    return {
      lead: content.slice(0, fenceStart).trim(),
      code: content.slice(openFenceLineEnd + 1),
      tail: "",
      language: openFenceLine.length > 0 ? openFenceLine : undefined,
    };
  }

  const lead = content.slice(0, fenceStart).trim();
  const code = content.slice(openFenceLineEnd + 1, closeFenceLineStart).replace(/\n$/, "");
  const tail = content.slice(closeFenceLineEnd).trim();

  return {
    lead,
    code,
    tail,
    language: openFenceLine.length > 0 ? openFenceLine : undefined,
  };
}

function RawFileBlock({
  content,
  mode,
  language,
  splitNarrative,
  streaming,
}: {
  content: string;
  mode: "raw-file" | "raw-fallback";
  language?: string;
  splitNarrative?: boolean;
  streaming?: boolean;
}) {
  const parsed =
    mode === "raw-file" && splitNarrative !== false
      ? splitRawFileContentWithMode(content, !streaming)
      : null;
  const code = parsed?.code ?? content;
  const headerLanguage =
    mode === "raw-file"
      ? (language?.trim().toLowerCase() || parsed?.language?.trim().toLowerCase() || "text")
      : "text";
  const lead = parsed?.lead ?? "";
  const tail = parsed?.tail ?? "";

  return (
    <div className="space-y-2" data-testid={`assistant-render-${mode}`}>
      {lead.length > 0 ? <p className="whitespace-pre-wrap break-words leading-relaxed">{lead}</p> : null}
      <div className="overflow-hidden rounded-2xl border border-border/35 bg-secondary/20 transition-[border-color,background-color] duration-200">
        <div className="flex items-center justify-between border-b border-border/35 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-semibold lowercase tracking-wide">{headerLanguage}</span>
          <button
            type="button"
            aria-label="Copy file output"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
                return;
              }
              void navigator.clipboard.writeText(code);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
          {code}
        </pre>
      </div>
      {tail.length > 0 ? <p className="whitespace-pre-wrap break-words leading-relaxed">{tail}</p> : null}
    </div>
  );
}

function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

function toolTitle(event: ChatEvent): string {
  if (event.payload.source === "worktree.diff") {
    return "Edited files";
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

function toolSubtitle(event: ChatEvent): string {
  if (event.payload.source === "worktree.diff") {
    const summary = event.payload.summary;
    return typeof summary === "string" && summary.length > 0 ? summary : "Detected file edits";
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

function formatCompactDurationSeconds(durationSeconds: number | null): string | null {
  if (durationSeconds == null) {
    return null;
  }

  const value = Number(durationSeconds);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return `${Math.max(1, Math.round(value))}s`;
}

function tokenizeCommand(command: string): string[] {
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

function isPathLikeToken(token: string): boolean {
  if (token.length === 0) {
    return false;
  }

  if (token.includes("/") || token.includes("\\")) {
    return true;
  }

  return token.startsWith("~/") || token.startsWith("./") || token.startsWith("../");
}

function basenameFromTokenPath(token: string): string {
  const normalized = token.replace(/[\\/]+$/g, "");
  const parts = normalized.split(/[\\/]/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return token;
  }
  return parts[parts.length - 1];
}

function shortenCommandToken(token: string): string {
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

function truncateSummaryText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function shortenCommandForSummary(command: string | null): string | null {
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

function getChangedFiles(event: ChatEvent): string[] {
  const value = event.payload.changedFiles;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function getDiffPreview(event: ChatEvent): string | null {
  const value = event.payload.diff;
  return typeof value === "string" && value.length > 0 ? value : null;
}


function editedSummaryLabel({
  status,
  diffKind,
  changedFiles,
  additions,
  deletions,
  rejectedByUser,
  expanded,
}: {
  status: "running" | "success" | "failed";
  diffKind: "proposed" | "actual" | "none";
  changedFiles: string[];
  additions: number;
  deletions: number;
  rejectedByUser?: boolean;
  expanded?: boolean;
}): React.ReactNode {
  const firstFile = basenameFromTokenPath(changedFiles[0] ?? "file");
  const fileCount = changedFiles.length > 1 ? ` (${changedFiles.length} files)` : "";

  if (status === "running") {
    return `Editing ${firstFile}${fileCount}`;
  }

  if (status === "failed") {
    if (rejectedByUser) {
      return `Rejected by user: ${firstFile}${fileCount}`;
    }
    return `Failed editing ${firstFile}${fileCount}`;
  }

  const isDeleteOnly = additions === 0 && deletions > 0;
  const verb = isDeleteOnly ? "Deleted" : "Edited";

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


const MARKDOWN_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children }) => <p className="leading-6 [&:not(:first-child)]:mt-4 whitespace-pre-wrap break-words">{children}</p>,
  ul: ({ children }) => <ul className="my-4 ml-6 list-disc [&>li]:mt-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 ml-6 list-decimal [&>li]:mt-1.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  h1: ({ children }) => <h1 className="scroll-m-16 text-xl font-bold tracking-tight mb-3">{children}</h1>,
  h2: ({ children }) => <h2 className="scroll-m-16 border-b pb-1.5 text-lg font-semibold tracking-tight mt-5 mb-3 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="scroll-m-16 text-base font-semibold tracking-tight mt-4 mb-2">{children}</h3>,
  h4: ({ children }) => <h4 className="scroll-m-16 text-sm font-semibold tracking-tight mt-3 mb-1.5">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="mt-4 border-l-2 border-primary pl-4 italic text-muted-foreground">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-4 w-full overflow-x-auto text-sm">
      <table className="w-full border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="m-0 border-t p-0 even:bg-muted/50">{children}</tr>,
  th: ({ children }) => <th className="border px-3 py-1.5 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right">{children}</th>,
  td: ({ children }) => <td className="border px-3 py-1.5 text-left [&[align=center]]:text-center [&[align=right]]:text-right">{children}</td>,
  a: ({ children, href }) => <a href={href} className="font-medium text-primary underline underline-offset-4 hover:text-primary/80" target="_blank" rel="noreferrer">{children}</a>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ className, children }) => {
    const language = className?.replace("language-", "").trim();
    const text = String(children).replace(/\n$/, "");
    const inline = !className && !text.includes("\n");

    if (inline) {
      return <code className="relative rounded bg-muted px-[0.25rem] py-[0.15rem] font-mono text-xs font-semibold break-all">{text}</code>;
    }

    if (isLikelyDiff(text, language)) {
      return (
        <div className="my-3 rounded-md border border-border/40 bg-secondary/20 p-2.5 last:mb-0">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Diff
          </div>
          <SafePatchDiff
            patch={text}
            options={{
              diffStyle: "unified",
              overflow: "wrap",
              theme: "pierre-dark",
              themeType: "dark",
              expandUnchanged: false,
              expansionLineCount: 20,
            }}
          />
        </div>
      );
    }

    return (
      <pre className="my-4 max-w-full overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground select-text">
        <code>{text}</code>
      </pre>
    );
  },
};

export const MarkdownBody = memo(function MarkdownBody({
  content,
  testId,
}: {
  content: string;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

const AssistantContent = memo(function AssistantContent({
  content,
  renderHint,
  rawFileLanguage,
  isCompleted,
}: {
  content: string;
  renderHint?: AssistantRenderHint;
  rawFileLanguage?: string;
  isCompleted?: boolean;
}) {
  const mode: AssistantRenderHint = (() => {
    if (renderHint === "diff" || isLikelyDiff(content)) {
      return "diff";
    }

    if (renderHint === "raw-file") {
      return "raw-file";
    }

    if (renderHint === "raw-fallback") {
      return "raw-fallback";
    }

    if (!renderHint && hasUnclosedCodeFence(content)) {
      return "raw-fallback";
    }

    return "markdown";
  })();

  if (mode === "diff") {
    return (
      <div className="rounded-lg border border-border/40 bg-secondary/20 p-3" data-testid="assistant-render-diff">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Diff</div>
        <SafePatchDiff
          patch={content}
          options={{
            diffStyle: "unified",
            overflow: "wrap",
            theme: "pierre-dark",
            themeType: "dark",
            expandUnchanged: false,
            expansionLineCount: 20,
          }}
        />
      </div>
    );
  }

  if (mode === "raw-file") {
    if (!isCompleted) {
      return (
        <div className="space-y-2" data-testid="assistant-render-raw-file-stream">
          <div className="inline-flex rounded-md border border-border/40 bg-secondary/20 px-2 py-1 text-[11px] text-muted-foreground">
            Raw file stream
          </div>
          <RawFileBlock content={content} mode="raw-file" language={rawFileLanguage} splitNarrative streaming />
        </div>
      );
    }

    return <RawFileBlock content={content} mode="raw-file" language={rawFileLanguage} splitNarrative />;
  }

  if (mode === "raw-fallback") {
    return <RawFileBlock content={content} mode="raw-fallback" />;
  }

  return <MarkdownBody content={content} testId="assistant-render-markdown" />;
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AttachmentPopoverContent = memo(function AttachmentPopoverContent({ attachment }: { attachment: ChatAttachment }) {
  const [copied, setCopied] = useState(false);
  const isImage = attachment.mimeType.startsWith("image/");
  const hasContent = attachment.content.length > 0;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(attachment.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [attachment.content]);

  return (
    <PopoverContent
      side="top"
      align="start"
      className="w-80 max-w-[90vw] p-0"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
        <Paperclip className="h-3 w-3 shrink-0 text-purple-400" />
        <span className="truncate text-xs font-medium">{attachment.filename}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {formatFileSize(attachment.sizeBytes)}
        </span>
      </div>
      <div className="bg-secondary/20">
        {isImage ? (
          <p className="px-3 py-4 text-xs italic text-muted-foreground text-center">
            Image file{attachment.storagePath ? ` saved at ${attachment.storagePath}` : ""}
          </p>
        ) : hasContent ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            {attachment.content.length > 2000 ? `${attachment.content.slice(0, 2000)}…` : attachment.content}
          </pre>
        ) : (
          <p className="px-3 py-4 text-xs italic text-muted-foreground text-center">No content preview available</p>
        )}
      </div>
      {hasContent && !isImage && (
        <div className="flex justify-end border-t border-border/30 px-2 py-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </PopoverContent>
  );
});

const AttachmentBlock = memo(function AttachmentBlock({ attachment }: { attachment: ChatAttachment }) {
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <div className="overflow-hidden rounded-lg border border-border/30 bg-secondary/20">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40"
          >
            {isImage ? (
              <Paperclip className="h-3 w-3 shrink-0 text-purple-400" />
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{attachment.filename}</span>
            <span className="shrink-0 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {formatFileSize(attachment.sizeBytes)}
            </span>
          </button>
        </PopoverTrigger>
        <AttachmentPopoverContent attachment={attachment} />
      </Popover>
    </div>
  );
});

const InlineAttachmentChip = memo(function InlineAttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  return (
    <span className="inline-flex align-baseline mx-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-1.5 py-0 text-xs text-purple-400 cursor-pointer select-none hover:bg-purple-500/25"
            title={`${attachment.filename} (${formatFileSize(attachment.sizeBytes)})`}
          >
            <Paperclip className="h-3 w-3 shrink-0 inline-block" />
            <span className="max-w-[140px] truncate">{attachment.filename}</span>
          </button>
        </PopoverTrigger>
        <AttachmentPopoverContent attachment={attachment} />
      </Popover>
    </span>
  );
});

const ATTACHMENT_MARKER_RE = /\{\{attachment:([^}]+)\}\}/g;

const UserMessageContent = memo(function UserMessageContent({ content, attachments }: { content: string; attachments?: ChatAttachment[] }) {
  const attachmentMap = useMemo(() => {
    const map = new Map<string, ChatAttachment>();
    if (attachments) {
      for (const att of attachments) map.set(att.id, att);
    }
    return map;
  }, [attachments]);

  // Check if content has inline attachment markers
  const hasInlineMarkers = ATTACHMENT_MARKER_RE.test(content);
  // Reset lastIndex after test
  ATTACHMENT_MARKER_RE.lastIndex = 0;

  // Collect IDs of attachments referenced inline so we can show the rest as blocks
  const inlineAttachmentIds = useMemo(() => {
    const ids = new Set<string>();
    if (!hasInlineMarkers) return ids;
    let match;
    while ((match = ATTACHMENT_MARKER_RE.exec(content)) !== null) {
      ids.add(match[1]);
    }
    ATTACHMENT_MARKER_RE.lastIndex = 0;
    return ids;
  }, [content, hasInlineMarkers]);

  // Attachments not placed inline via markers
  const remainingAttachments = useMemo(
    () => (attachments ?? []).filter((att) => !inlineAttachmentIds.has(att.id)),
    [attachments, inlineAttachmentIds],
  );

  // clipboard_text attachments always render as inline chips (even if not marker-positioned)
  const clipboardTextAttachments = useMemo(
    () => remainingAttachments.filter((att) => att.source === "clipboard_text"),
    [remainingAttachments],
  );

  // Everything else (file_picker, drag_drop, clipboard_image) renders as collapsible blocks
  const blockAttachments = useMemo(
    () => remainingAttachments.filter((att) => att.source !== "clipboard_text"),
    [remainingAttachments],
  );

  // Strip {{attachment:...}} markers from display text (for cases where marker IDs don't match)
  const displayContent = useMemo(
    () => content.replace(ATTACHMENT_MARKER_RE, "").replace(/  +/g, " ").trim(),
    [content],
  );

  // Split content into text segments and inline attachment markers
  const renderContent = () => {
    if (!hasInlineMarkers) {
      // No inline markers — render with mention parsing only
      const segments = parseUserMentions(displayContent);
      if (segments.length === 1 && segments[0].kind === "text") {
        return (
          <p className="whitespace-pre-wrap break-words leading-relaxed">
            {displayContent}
            {clipboardTextAttachments.map((att) => (
              <InlineAttachmentChip key={att.id} attachment={att} />
            ))}
          </p>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          {segments.map((seg, i) => renderMentionSegment(seg, i))}
          {clipboardTextAttachments.map((att) => (
            <InlineAttachmentChip key={att.id} attachment={att} />
          ))}
        </p>
      );
    }

    // Split on attachment markers, interleave text + chips
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let partKey = 0;

    while ((match = ATTACHMENT_MARKER_RE.exec(content)) !== null) {
      // Text before the marker
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore) {
        const segments = parseUserMentions(textBefore);
        for (const seg of segments) {
          parts.push(renderMentionSegment(seg, partKey++));
        }
      }

      // Inline attachment chip
      const attId = match[1];
      const att = attachmentMap.get(attId);
      if (att) {
        parts.push(
          <InlineAttachmentChip key={`att-${partKey++}`} attachment={att} />,
        );
      }

      lastIndex = match.index + match[0].length;
    }
    ATTACHMENT_MARKER_RE.lastIndex = 0;

    // Remaining text after last marker
    const remaining = content.slice(lastIndex);
    if (remaining) {
      const segments = parseUserMentions(remaining);
      for (const seg of segments) {
        parts.push(renderMentionSegment(seg, partKey++));
      }
    }

    // Append any clipboard_text attachments not matched by markers
    for (const att of clipboardTextAttachments) {
      parts.push(
        <InlineAttachmentChip key={`att-${partKey++}`} attachment={att} />,
      );
    }

    return <p className="whitespace-pre-wrap break-words leading-relaxed">{parts}</p>;
  };

  const textContent = renderContent();

  if (blockAttachments.length === 0) return textContent;

  return (
    <div className="space-y-2">
      {textContent}
      <div className="space-y-1.5">
        {blockAttachments.map((att) => (
          <AttachmentBlock key={att.id} attachment={att} />
        ))}
      </div>
    </div>
  );
});

function renderMentionSegment(seg: ReturnType<typeof parseUserMentions>[number], key: number) {
  if (seg.kind === "text") {
    return <span key={key}>{seg.value}</span>;
  }
  return (
    <span
      key={key}
      title={seg.path}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0 text-xs align-baseline",
        seg.isDirectory
          ? "border-amber-500/30 bg-amber-500/15 text-amber-400"
          : "border-blue-500/30 bg-blue-500/15 text-blue-400",
      )}
    >
      {seg.isDirectory ? (
        <Folder className="h-3 w-3 shrink-0 inline-block" />
      ) : (
        <FileText className="h-3 w-3 shrink-0 inline-block" />
      )}
      <span className="max-w-[140px] truncate">{seg.name}</span>
    </span>
  );
}

function downloadTextFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

const PlanInlineMessage = memo(function PlanInlineMessage({
  id,
  content,
  filePath,
  copied,
  onCopy,
}: {
  id: string;
  content: string;
  filePath: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(content.length > 900);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const contentEl = contentRef.current;
    const fallbackCanExpand = content.length > 900;
    if (!contentEl) {
      setCanExpand(fallbackCanExpand);
      return;
    }

    const evaluate = () => {
      const hasOverflow = contentEl.scrollHeight > contentEl.clientHeight + 4;
      setCanExpand(hasOverflow || fallbackCanExpand);
    };

    evaluate();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      evaluate();
    });
    observer.observe(contentEl);

    return () => {
      observer.disconnect();
    };
  }, [content, expanded]);

  const showToggle = canExpand || expanded;

  return (
    <Card className="overflow-hidden rounded-3xl border-border/50 bg-card/90" data-testid="plan-inline-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
            Plan
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={() => downloadTextFile(filePath.split("/").pop() ?? `plan-${id}.md`, content)}
            aria-label="Download plan message"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={onCopy}
            aria-label="Copy plan message"
          >
            {copied ? "Copied" : <Copy className="h-3.5 w-3.5" />}
          </button>
          {showToggle ? (
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:text-foreground"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? "Collapse plan message" : "Expand plan message"}
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-0">
        <div
          ref={contentRef}
          className={cn("relative text-sm text-foreground/95", !expanded && "max-h-[45vh] overflow-hidden sm:max-h-[60vh]")}
          data-testid="plan-inline-content"
        >
          <MarkdownBody content={content} testId="assistant-render-plan-markdown" />
          {!expanded && canExpand ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card/95 via-card/70 to-transparent" />
          ) : null}
          {!expanded && canExpand ? (
            <div className="absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="pointer-events-auto rounded-full bg-background/95 px-5"
                onClick={() => setExpanded(true)}
                aria-label="Expand plan"
              >
                Expand plan
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
});

type TimelineCtx = {
  rawOutputMessageIds: Set<string>;
  copiedMessageId: string | null;
  copiedDebug: boolean;
  renderDebugEnabled: boolean;
  toggleRawOutput: (id: string) => void;
  copyOutput: (id: string, content: string) => void;
  copyDebugLog: () => void;
  onOpenReadFile?: (path: string) => void | Promise<void>;
  bashExpandedById: Map<string, boolean>;
  setBashExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  editedExpandedById: Map<string, boolean>;
  setEditedExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  exploreActivityExpandedById: Map<string, boolean>;
  setExploreActivityExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentExpandedById: Map<string, boolean>;
  setSubagentExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentPromptExpandedById: Map<string, boolean>;
  setSubagentPromptExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  subagentExploreExpandedById: Map<string, boolean>;
  setSubagentExploreExpandedById: Dispatch<SetStateAction<Map<string, boolean>>>;
  lastRenderSignatureByMessageIdRef: MutableRefObject<Map<string, string>>;
};

const ThinkingPlaceholder = memo(function ThinkingPlaceholder() {
  return (
    <article className="flex w-full justify-start" data-testid="thinking-placeholder">
      <div className="max-w-[85%] px-1 text-sm text-muted-foreground">
        <span className="thinking-shimmer font-medium">Thinking...</span>
      </div>
    </article>
  );
});

const TimelineItem = memo(function TimelineItem({
  item,
  ctx,
}: {
  item: ChatTimelineItem;
  ctx: TimelineCtx;
}) {
  if (item.kind === "plan-file-output") {
    return (
      <article className="flex w-full justify-start" data-testid="timeline-plan-file-output">
        <div className="w-full px-1 text-sm text-foreground">
          <PlanInlineMessage
            id={item.id}
            content={item.content}
            filePath={item.filePath}
            copied={ctx.copiedMessageId === item.id}
            onCopy={() => ctx.copyOutput(item.id, item.content)}
          />
        </div>
      </article>
    );
  }

  if (item.kind === "tool") {
    const changedFiles = getChangedFiles(item.event);
    const diffPreview = getDiffPreview(item.event);

    return (
      <article
        className="rounded-md border border-border/30 bg-background/20 px-3 py-2 text-xs"
        data-testid={`timeline-${item.event.type}`}
      >
        <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
          <span className="shrink-0 font-semibold text-foreground">{toolTitle(item.event)}</span>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{toolSubtitle(item.event)}</span>
        </div>

        {changedFiles.length > 0 ? (
          <div className="mt-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Files</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-foreground/90">
              {changedFiles.map((file) => (
                <li key={file} className="break-all">{file}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {diffPreview ? (
          <details
            className="mt-2 rounded-md border border-border/40 bg-secondary/20 p-2.5"
            data-testid="timeline-tool-diff-preview"
          >
            <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Diff Preview
            </summary>
            <div className="mt-1.5">
              <SafePatchDiff
                patch={diffPreview}
                options={{
                  diffStyle: "unified",
                  overflow: "wrap",
                  theme: "pierre-dark",
                  themeType: "dark",
                  expandUnchanged: false,
                  expansionLineCount: 20,
                }}
              />
            </div>
          </details>
        ) : null}
      </article>
    );
  }

  if (item.kind === "bash-command") {
    const commandText = item.command ?? item.summary ?? "command";
    const statusLabel = item.rejectedByUser
      ? "Rejected by user"
      : item.status === "failed"
        ? "Failed"
        : item.status === "running"
          ? "Running"
          : "Success";
    const expanded = ctx.bashExpandedById.get(item.id) ?? false;
    const isFailed = item.status === "failed" || item.rejectedByUser === true;
    const durationLabel = formatCompactDurationSeconds(item.durationSeconds);
    const shortCommandLabel = shortenCommandForSummary(item.command);
    const summaryPrefix = expanded ? "Ran commands" : shortCommandLabel ? `Ran ${shortCommandLabel}` : "Ran command";
    const summaryLabel = durationLabel ? `${summaryPrefix} for ${durationLabel}` : summaryPrefix;

    return (
      <article
        className="px-1 text-xs"
        data-testid="timeline-bash-command"
      >
        <details
          open={expanded}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            ctx.setBashExpandedById((current) => {
              const next = new Map(current);
              next.set(item.id, nextOpen);
              return next;
            });
          }}
        >
          <summary
            className={cn(
              "group/bash-summary inline-flex list-none cursor-pointer items-center gap-1 rounded-md text-[12px] transition-colors [&::-webkit-details-marker]:hidden",
              isFailed && !expanded
                ? "text-destructive"
                : expanded ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {isFailed && !expanded ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="font-medium">{summaryLabel}</span>
            <span
              className={cn(
                "inline-flex shrink-0 text-[11px] leading-none opacity-0 transition-[opacity,transform,color] group-hover/bash-summary:opacity-100",
                expanded
                  ? "rotate-90 text-muted-foreground"
                  : "text-muted-foreground group-hover/bash-summary:text-foreground",
              )}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </summary>

          <div className="mt-2 overflow-hidden rounded-2xl border border-border/35 bg-secondary/20">
            <div className="px-3 pt-2 pb-1 text-xs font-semibold lowercase tracking-wide text-muted-foreground">
              {item.shell}
            </div>

            <pre className="px-4 py-2.5 font-mono text-sm leading-relaxed text-foreground overflow-x-auto whitespace-pre-wrap break-words">
              <span style={{ color: "#98c379" }}>$</span>
              <span> </span>
              <span style={{ color: "#61afef" }}>{commandText}</span>
            </pre>

            {item.output ? (
              <TerminalOutputPre
                text={item.output}
                className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-foreground"
              />
            ) : null}

            {item.error ? (
              <TerminalOutputPre
                text={item.error}
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-destructive"
              />
            ) : null}

            {!item.output && !item.error && item.summary ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">{item.summary}</div>
            ) : null}

            {item.truncated ? (
              <div className="mt-1 px-3 py-2 text-[11px] text-muted-foreground">... [output truncated]</div>
            ) : null}

            <div className="px-3 pt-1.5 pb-2 text-right text-xs">
              <span
                className={cn(
                  "font-medium",
                  item.status === "failed"
                    ? "text-destructive"
                    : item.status === "running"
                      ? "text-muted-foreground"
                      : "text-foreground",
                )}
              >
                {statusLabel}
              </span>
            </div>
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "edited-diff") {
    const hasDiffContent = item.diff.trim().length > 0;
    const expanded = hasDiffContent ? (ctx.editedExpandedById.get(item.id) ?? false) : false;
    const parsedFiles = hasDiffContent ? parsePatchFiles(item.diff).flatMap((p) => p.files) : [];
    const diffFileNames = parsedFiles.map((f) => f.name);
    const resolvedFiles = item.changedFiles.length > 0 ? item.changedFiles : diffFileNames;
    const summaryLabel = editedSummaryLabel({
      status: item.status,
      diffKind: item.diffKind,
      changedFiles: resolvedFiles,
      additions: item.additions,
      deletions: item.deletions,
      rejectedByUser: item.rejectedByUser,
      expanded,
    });

    const isDiffFailed = item.status === "failed" || item.rejectedByUser === true;

    if (!hasDiffContent && !item.diffTruncated) {
      return (
        <article
          className="px-1 text-xs"
          data-testid="timeline-edited-diff"
        >
          <div className={cn("inline-flex items-center gap-1 text-[12px]", isDiffFailed ? "text-destructive" : "text-muted-foreground")}>
            {isDiffFailed ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="font-medium">{summaryLabel}</span>
          </div>
        </article>
      );
    }

    return (
      <article
        className="px-1 text-xs"
        data-testid="timeline-edited-diff"
      >
        <details
          open={expanded}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            ctx.setEditedExpandedById((current) => {
              const next = new Map(current);
              next.set(item.id, nextOpen);
              return next;
            });
          }}
        >
          <summary
            className={cn(
              "group/edited-summary inline-flex list-none cursor-pointer items-center gap-1 rounded-md text-[12px] transition-colors [&::-webkit-details-marker]:hidden",
              isDiffFailed && !expanded
                ? "text-destructive"
                : expanded ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {isDiffFailed && !expanded ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="font-medium">{summaryLabel}</span>
            <span
              className={cn(
                "inline-flex shrink-0 text-[11px] leading-none opacity-0 transition-[opacity,transform,color] group-hover/edited-summary:opacity-100",
                expanded
                  ? "rotate-90 text-muted-foreground"
                  : "text-muted-foreground group-hover/edited-summary:text-foreground",
              )}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </summary>

          <div className="mt-2 overflow-hidden rounded-2xl border border-border/35 bg-secondary/20">
            {item.diffKind === "proposed" ? (
              <div className="border-b border-border/25 px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                Proposed diff
              </div>
            ) : null}
            {parsedFiles.map((file, sectionIndex) => (
              <div key={`section:${sectionIndex}`} className="max-h-72 overflow-auto">
                <FileDiff
                  fileDiff={file}
                  options={{
                    diffStyle: "unified",
                    overflow: "wrap",
                    theme: "pierre-dark",
                    themeType: "dark",
                    expandUnchanged: false,
                    expansionLineCount: 20,
                  }}
                />
              </div>
            ))}

            {item.diffTruncated ? (
              <div className="px-3 pt-1.5 pb-2 text-[11px] text-muted-foreground">... [diff truncated]</div>
            ) : null}
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "explore-activity") {
    const renderReadLabel = (entry: ExploreActivityEntry, key: string) => (
      <span key={key}>
        Read{" "}
        {entry.openPath && ctx.onOpenReadFile ? (
          <button
            type="button"
            className="inline text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-2"
            onClick={() => {
              const openPath = entry.openPath;
              if (!openPath || !ctx.onOpenReadFile) {
                return;
              }
              void ctx.onOpenReadFile(openPath);
            }}
          >
            {entry.label}
          </button>
        ) : (
          <span>{entry.label}</span>
        )}
      </span>
    );
    const expanded = ctx.exploreActivityExpandedById.get(item.id) === true;
    const summaryPrefix = item.status === "running" ? "Exploring" : "Explored";
    const summaryParts: string[] = [];
    if (item.fileCount > 0) {
      summaryParts.push(`${item.fileCount} files`);
    }
    if (item.searchCount > 0) {
      summaryParts.push(`${item.searchCount} searches`);
    }
    const summaryText = summaryParts.length > 0 ? `${summaryPrefix} ${summaryParts.join(", ")}` : `${summaryPrefix}`;
    return (
      <article
        className="px-1 text-xs"
        data-testid="timeline-explore-activity"
      >
        <details
          open={expanded}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            ctx.setExploreActivityExpandedById((current) => {
              const next = new Map(current);
              next.set(item.id, nextOpen);
              return next;
            });
          }}
        >
          <summary className="group/read-summary cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors select-none flex items-center gap-1.5">
            <span className={item.status === "running" ? "thinking-shimmer" : ""}>{summaryText}</span>
            <span
              data-testid="timeline-explore-activity-chevron"
              className={cn("inline-flex transition-transform duration-150", expanded ? "rotate-90" : "")}
            >
              <ChevronRight className="h-3 w-3" />
            </span>
          </summary>
          <div className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {item.entries.map((entry, idx) => (
              entry.pending
                ? <span key={`pending:${idx}`}>{entry.label}</span>
                : entry.kind === "read"
                  ? renderReadLabel(entry, `read:${idx}`)
                  : <span key={`entry:${idx}`}>{entry.label}</span>
            ))}
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "subagent-activity") {
    const expanded = ctx.subagentExpandedById.get(item.id) === true;
    const isRunning = item.status === "running";
    const agentLabel = item.agentType !== "unknown" ? item.agentType : "Task";
    const descSnippet = item.description || "";
    const truncateDescription = (desc: string, maxLen = 80): string => {
      if (desc.length <= maxLen) return desc;
      const sentenceEnd = desc.search(/[.!?]\s/);
      if (sentenceEnd > 0 && sentenceEnd <= maxLen) {
        return desc.slice(0, sentenceEnd + 1);
      }
      const truncated = desc.slice(0, maxLen);
      const lastSpace = truncated.lastIndexOf(" ");
      return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + "…";
    };
    const headerSnippet = truncateDescription(descSnippet);
    const headerText = headerSnippet
      ? `${agentLabel}(${headerSnippet})`
      : agentLabel;
    const stepCount = item.steps.length;
    const durationText = item.durationSeconds != null ? `${item.durationSeconds}s` : "";
    const statusParts = [
      stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? "s" : ""}` : "",
      durationText,
    ].filter(Boolean).join(" · ");
    const statusText = isRunning
      ? `Running${statusParts ? ` · ${statusParts}` : ""}`
      : `Done${statusParts ? ` · ${statusParts}` : ""}`;

    const EXPLORE_TOOL_NAMES = new Set(["Read", "Grep", "Search", "Glob", "ListDir"]);
    const isExploreStep = (s: SubagentStep) => {
      if (EXPLORE_TOOL_NAMES.has(s.toolName)) return true;
      if (s.toolName === "Bash" && s.label) {
        const cmd = s.label.replace(/^Ran\s+/i, "").trim();
        return EXPLORE_BASH_COMMAND_PATTERN.test(cmd);
      }
      return false;
    };
    const readSteps = item.steps.filter(isExploreStep);
    const otherSteps = item.steps.filter((s) => !isExploreStep(s));
    const readCount = readSteps.filter((s) => s.toolName === "Read").length;
    const searchCount = readSteps.filter((s) => s.toolName !== "Read").length;
    const hasExploreSteps = readSteps.length > 0;
    const allExploreComplete = readSteps.every((s) => s.status === "success");
    const exploreSummaryPrefix = allExploreComplete && !isRunning ? "Explored" : "Exploring";
    const exploreSummaryParts: string[] = [];
    if (readCount > 0) {
      exploreSummaryParts.push(`${readCount} file${readCount !== 1 ? "s" : ""}`);
    }
    if (searchCount > 0) {
      exploreSummaryParts.push(`${searchCount} search${searchCount !== 1 ? "es" : ""}`);
    }
    const exploreSummaryText = exploreSummaryParts.length > 0
      ? `${exploreSummaryPrefix} ${exploreSummaryParts.join(", ")}`
      : exploreSummaryPrefix;

    return (
      <article
        className="px-1"
        data-testid="timeline-subagent-activity"
      >
        <details
          open={expanded}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            ctx.setSubagentExpandedById((current) => {
              const next = new Map(current);
              next.set(item.id, nextOpen);
              return next;
            });
          }}
        >
          {/* Collapsed summary header */}
          <summary className="flex cursor-pointer items-center gap-1.5 select-none list-none text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {headerText}
            </span>
            <span className={cn("text-[10px] shrink-0", isRunning ? "text-muted-foreground" : "text-muted-foreground/50")}>
              {statusText}
            </span>
            <span
              data-testid="timeline-subagent-activity-chevron"
              className={cn("inline-flex shrink-0 transition-transform duration-150", expanded ? "rotate-90" : "")}
            >
              <ChevronRight className="h-3 w-3" />
            </span>
          </summary>

          {/* Expanded chat-style content */}
          <div className="mt-2 ml-1 rounded-xl border border-border/30 bg-secondary/5 overflow-hidden">
            <div className="flex flex-col gap-3 p-3">
              {/* Prompt — collapsible */}
              {item.description && (
                <div className="px-1 text-xs">
                  <details
                    open={ctx.subagentPromptExpandedById.get(item.id) === true}
                    onToggle={(event) => {
                      const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                      ctx.setSubagentPromptExpandedById((current) => {
                        const next = new Map(current);
                        next.set(item.id, nextOpen);
                        return next;
                      });
                    }}
                  >
                    <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors select-none flex items-center gap-1.5">
                      <span>Prompt</span>
                      <span className={cn("inline-flex transition-transform duration-150", ctx.subagentPromptExpandedById.get(item.id) === true ? "rotate-90" : "")}>
                        <ChevronRight className="h-3 w-3" />
                      </span>
                    </summary>
                    <div className="mt-1 text-sm text-foreground">
                      <p className="whitespace-pre-wrap break-words leading-relaxed">{item.description}</p>
                    </div>
                  </details>
                </div>
              )}

              {/* Explore-activity style steps (reads/searches grouped) */}
              {hasExploreSteps && (
                <div className="px-1 text-xs">
                  <details
                    open={ctx.subagentExploreExpandedById.get(item.id) === true}
                    onToggle={(event) => {
                      const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                      ctx.setSubagentExploreExpandedById((current) => {
                        const next = new Map(current);
                        next.set(item.id, nextOpen);
                        return next;
                      });
                    }}
                  >
                    <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground transition-colors select-none flex items-center gap-1.5">
                      <span>{exploreSummaryText}</span>
                      <span className={cn("inline-flex transition-transform duration-150", ctx.subagentExploreExpandedById.get(item.id) === true ? "rotate-90" : "")}>
                        <ChevronRight className="h-3 w-3" />
                      </span>
                    </summary>
                    <div className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                      {readSteps.map((step, idx) => (
                        <span key={`explore:${idx}`}>
                          {step.toolName === "Read" ? (
                            <>
                              Read{" "}
                              {step.openPath && ctx.onOpenReadFile ? (
                                <button
                                  type="button"
                                  className="inline text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-2"
                                  onClick={() => {
                                    if (step.openPath && ctx.onOpenReadFile) {
                                      void ctx.onOpenReadFile(step.openPath);
                                    }
                                  }}
                                >
                                  {step.label}
                                </button>
                              ) : (
                                <span>{step.label}</span>
                              )}
                            </>
                          ) : (
                            step.label
                          )}
                        </span>
                      ))}
                    </div>
                  </details>
                </div>
              )}

              {/* Other tool steps (bash, edit, etc.) — shown individually */}
              {otherSteps.map((step, idx) => (
                <div key={`tool:${idx}`} className="px-1 text-xs text-muted-foreground flex items-center gap-1.5">
                  {step.status === "success"
                    ? <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500/70" />
                    : <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground/50 animate-spin" />}
                  <span>
                    {step.label}
                  </span>
                </div>
              ))}

              {/* Response — assistant-message style with full markdown */}
              {item.lastMessage && (
                <div className="px-1 text-sm text-foreground">
                  <MarkdownBody content={item.lastMessage} testId="subagent-response-markdown" />
                </div>
              )}

              {/* Thinking shimmer while subagent is running and no response yet */}
              {!item.lastMessage && isRunning && (
                <div className="px-1 text-sm text-muted-foreground">
                  <span>Thinking…</span>
                </div>
              )}
            </div>

            {/* Footer bar */}
            <div className="border-t border-border/20 px-3 py-1.5 text-[10px] text-muted-foreground/50 flex items-center gap-1.5">
              <Bot className="h-3 w-3 shrink-0" />
              <span>
                {statusText}
              </span>
            </div>
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "thinking") {
    return (
      <article
        className="px-1"
        data-testid="timeline-thinking"
      >
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1.5 select-none list-none text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
            <Brain className="h-3.5 w-3.5 shrink-0" />
            <span className={item.isStreaming ? "thinking-shimmer" : ""}>
              {item.isStreaming ? "Thinking…" : "Thought process"}
            </span>
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1.5 rounded-lg border border-border/20 bg-secondary/10 px-3 py-2">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground/80">
              {item.content}
            </pre>
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "error") {
    return (
      <article
        className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        data-testid="timeline-error"
      >
        <div className="mb-1 flex items-center gap-1.5 text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="font-semibold">Chat failed</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-foreground/90">{item.message}</p>
      </article>
    );
  }

  if (item.kind === "activity") {
    return null;
  }

  // item.kind === "message"
  const message = item.message;
  const isRawOutputMode = message.role === "assistant" && ctx.rawOutputMessageIds.has(message.id);
  if (message.role === "assistant") {
    const signature = [
      isRawOutputMode ? "raw" : "beauty",
      item.renderHint ?? "none",
      item.isCompleted ? "done" : "stream",
      item.rawFileLanguage ?? "lang:none",
      `len:${message.content.length}`,
    ].join("|");
    const previousSignature = ctx.lastRenderSignatureByMessageIdRef.current.get(message.id);
    if (signature !== previousSignature) {
      ctx.lastRenderSignatureByMessageIdRef.current.set(message.id, signature);
      pushRenderDebug({
        source: "ChatMessageList",
        event: "assistantRenderSignature",
        messageId: message.id,
        details: {
          signature,
          renderHint: item.renderHint,
          isCompleted: item.isCompleted,
          rawFileLanguage: item.rawFileLanguage,
          contentLength: message.content.length,
        },
      });
    }
  }

  return (
    <article
      className={cn("flex w-full", message.role === "user" ? "justify-end" : "justify-start")}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          "min-w-0 text-sm",
          message.role === "assistant" && "w-full px-1 text-foreground",
          message.role === "user" && "max-w-[85%] rounded-2xl bg-secondary/55 px-4 py-2.5 text-foreground",
          message.role === "system" && "rounded-xl border border-border/40 px-3 py-2 text-muted-foreground",
        )}
      >
        {message.role === "assistant" ? (
          <div className="space-y-2">
            {ctx.renderDebugEnabled ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  aria-label="Copy output"
                  className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                  onClick={() => ctx.copyOutput(message.id, message.content)}
                >
                  {ctx.copiedMessageId === message.id ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  aria-label="Toggle raw output"
                  className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                  onClick={() => ctx.toggleRawOutput(message.id)}
                >
                  {isRawOutputMode ? "Beauty View" : "Raw Claude"}
                </button>
                <button
                  type="button"
                  aria-label="Copy render debug log"
                  className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                  onClick={() => {
                    void ctx.copyDebugLog();
                  }}
                >
                  {ctx.copiedDebug ? "Debug Copied" : "Copy Debug"}
                </button>
              </div>
            ) : null}

            {isRawOutputMode ? (
              <div
                className="overflow-hidden rounded-2xl border border-border/35 bg-secondary/20"
                data-testid="assistant-render-raw-output"
              >
                <div className="flex items-center justify-between border-b border-border/35 px-3 py-2 text-xs text-muted-foreground">
                  <span className="font-semibold lowercase tracking-wide">raw</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
                  {message.content}
                </pre>
              </div>
            ) : (
              <AssistantContent
                content={message.content}
                renderHint={item.renderHint}
                rawFileLanguage={item.rawFileLanguage}
                isCompleted={item.isCompleted}
              />
            )}
          </div>
        ) : (
          <UserMessageContent content={message.content} attachments={message.attachments} />
        )}
      </div>
    </article>
  );
});

export function ChatMessageList({
  items,
  showThinkingPlaceholder = false,
  sendingMessage = false,
  onOpenReadFile,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  topPaginationInteractionReady = false,
  onLoadOlderHistory,
}: ChatMessageListProps) {
  const vlistRef = useRef<VListHandle>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const topLoadArmedRef = useRef(true);
  const topLoadCooldownUntilRef = useRef(0);
  const topLoadRearmTimeoutRef = useRef<number | null>(null);
  const topLoadPostReleaseCooldownUntilRef = useRef(0);
  const [rawOutputMessageIds, setRawOutputMessageIds] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [bashExpandedById, setBashExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [editedExpandedById, setEditedExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [exploreActivityExpandedById, setExploreActivityExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExpandedById, setSubagentExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentPromptExpandedById, setSubagentPromptExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExploreExpandedById, setSubagentExploreExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const lastRenderSignatureByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDebugEnabled = isRenderDebugEnabled();

  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const userScrolledAwayRef = useRef(false);
  const lastItemCountChangeRef = useRef(0);
  const [atTop, setAtTop] = useState(false);
  const atTopRef = useRef(atTop);
  const leftTopZoneRef = useRef(true);
  const loadCycleCounterRef = useRef(0);
  const loadCycleInFlightRef = useRef(false);
  // Track whether shift should be active (only during prepend operations)
  const [shiftActive, setShiftActive] = useState(false);
  const shiftReleasePendingRef = useRef(false);
  const pendingShiftReleaseRef = useRef<{
    cycleId: number;
    requestId: string;
    baselineRenderableCount: number;
    baselineFirstRenderableKey: string | null;
    completionReason: string | null;
    messagesAdded: number;
    eventsAdded: number;
    estimatedRenderableGrowth: boolean | null;
    loadFinished: boolean;
    releaseQueued: boolean;
    releaseAnchorOffset: number | null;
    releaseAnchorDistanceFromTop: number | null;
  } | null>(null);
  const shiftReleaseTimeoutRef = useRef<number | null>(null);
  const shiftDeactivateTokenRef = useRef(0);
  const shiftForceDisabledRef = useRef(false);
  const shiftReleaseAnchorWatchTimeoutRef = useRef<number | null>(null);
  const shiftReleaseAnchorWatchRafRef = useRef<number | null>(null);
  const eventsOnlyLateDriftGuardUntilRef = useRef(0);
  const eventsOnlyLateDriftRestoreCooldownUntilRef = useRef(0);
  const lastUserScrollIntentAtRef = useRef(0);
  const pendingShiftAnchorRestoreRef = useRef<{
    reason: string;
    targetOffset: number;
    releaseAnchorDistanceFromTop: number;
    lockUntilAt: number;
    watchUntilAt: number;
    suppressRestore?: boolean;
    armedScrollSize?: number | null;
  } | null>(null);
  const pendingShiftRestoreFrameRef = useRef(false);
  const shiftPendingVisibilityHideRef = useRef(false);
  const shiftBaselineDfbRef = useRef<number | null>(null);
  // #region agent log
  const prePaginationDomGeoRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const frameTrackerActiveRef = useRef(false);
  const visualTrackerRafRef = useRef<number | null>(null);
  const visualTrackerActiveRef = useRef(false);
  const visualTrackerLastScrollTimeRef = useRef(0);
  const scrollJumpCompensationActiveRef = useRef(false);
  // #endregion
  const scrollFreezeActiveRef = useRef(false);
  const scrollFreezeCleanupRef = useRef<(() => void) | null>(null);
  const remeasureSettledCountRef = useRef(0);
  const remeasureSettledTimerRef = useRef<number | null>(null);

  const freezeScrollInertia = useCallback(() => {
    if (scrollFreezeActiveRef.current) return;
    scrollFreezeActiveRef.current = true;
    scrollFreezeCleanupRef.current = () => {
      scrollFreezeActiveRef.current = false;
      scrollFreezeCleanupRef.current = null;
    };
    // #region agent log
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:freezeScrollInertia',message:'freeze flag set',data:{},timestamp:Date.now(),hypothesisId:'H20'})}).catch(()=>{});
    // #endregion
  }, []);

  const unfreezeScrollInertia = useCallback(() => {
    if (!scrollFreezeActiveRef.current) return;
    scrollFreezeCleanupRef.current?.();
    // #region agent log
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:unfreezeScrollInertia',message:'scroll inertia unfrozen',data:{},timestamp:Date.now(),hypothesisId:'H15'})}).catch(()=>{});
    // #endregion
  }, []);

  const topLoadTransactionActiveRef = useRef(false);
  const hasOlderHistoryRef = useRef(hasOlderHistory);
  const loadingOlderHistoryPropRef = useRef(loadingOlderHistory);
  const topPaginationInteractionReadyRef = useRef(topPaginationInteractionReady);
  const onLoadOlderHistoryRef = useRef(onLoadOlderHistory);
  const renderableCountRef = useRef(0);
  const renderableFirstKeyRef = useRef<string | null>(null);

  const readScrollSnapshot = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle) {
      return {
        scrollHandleReady: false,
        scrollOffset: null,
        scrollSize: null,
        viewportSize: null,
        maxScroll: null,
        distanceFromTop: null,
        distanceFromBottom: null,
      };
    }

    const { scrollOffset, scrollSize, viewportSize } = handle;
    const maxScroll = Math.max(scrollSize - viewportSize, 0);
    const distanceFromTop = Math.max(scrollOffset, 0);
    const distanceFromBottom = Math.max(maxScroll - scrollOffset, 0);

    return {
      scrollHandleReady: true,
      scrollOffset,
      scrollSize,
      viewportSize,
      maxScroll,
      distanceFromTop,
      distanceFromBottom,
    };
  }, []);

  const clearPendingShiftAnchorRestore = useCallback(() => {
    // #region agent log
    const clrHandle = vlistRef.current;
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:clearPendingShiftAnchor',message:'clearing shift anchor',data:{scrollOffset:clrHandle?.scrollOffset,scrollSize:clrHandle?.scrollSize,viewportSize:clrHandle?.viewportSize,hadAnchor:pendingShiftAnchorRestoreRef.current!=null,suppressRestore:pendingShiftAnchorRestoreRef.current?.suppressRestore},timestamp:Date.now(),hypothesisId:'H7'})}).catch(()=>{});
    // #endregion
    pendingShiftAnchorRestoreRef.current = null;
    topLoadPostReleaseCooldownUntilRef.current = 0;
    if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
      window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
      shiftReleaseAnchorWatchTimeoutRef.current = null;
    }
    if (shiftReleaseAnchorWatchRafRef.current != null) {
      window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
      shiftReleaseAnchorWatchRafRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = Date.now();
  }, []);

  const releaseShift = useCallback((reason: string) => {
    const pending = pendingShiftReleaseRef.current;
    pendingShiftReleaseRef.current = null;
    topLoadTransactionActiveRef.current = false;
    if (shiftReleaseTimeoutRef.current != null) {
      window.clearTimeout(shiftReleaseTimeoutRef.current);
      shiftReleaseTimeoutRef.current = null;
    }

    const anchorOffset = pending?.releaseAnchorOffset ?? null;
    const anchorDistanceFromTop = pending?.releaseAnchorDistanceFromTop ?? null;
    const now = Date.now();

    eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
    if (
      reason === "events-only-growth"
      && anchorDistanceFromTop != null
      && anchorDistanceFromTop <= TOP_LOAD_ENTER_THRESHOLD
    ) {
      eventsOnlyLateDriftGuardUntilRef.current = now + TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_GUARD_MS;
    } else {
      eventsOnlyLateDriftGuardUntilRef.current = 0;
    }

    debugLog("ChatMessageList", "load-older-release-shift", {
      reason,
      cycleId: pending?.cycleId ?? null,
      requestId: pending?.requestId ?? null,
      completionReason: pending?.completionReason ?? null,
      messagesAdded: pending?.messagesAdded ?? null,
      eventsAdded: pending?.eventsAdded ?? null,
      estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
      releaseAnchorOffset: anchorOffset,
      releaseAnchorDistanceFromTop: anchorDistanceFromTop,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
    });

    const shouldArmAnchorRestore = true;
    if (shouldArmAnchorRestore && anchorOffset != null && anchorDistanceFromTop != null) {
      // #region agent log
      const rlsHandle = vlistRef.current;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:releaseShift-arm-anchor',message:'arming anchor restore',data:{reason,anchorOffset,anchorDistFromTop:anchorDistanceFromTop,currentOffset:rlsHandle?.scrollOffset,currentScrollSize:rlsHandle?.scrollSize,lockMs:TOP_LOAD_RELEASE_ANCHOR_LOCK_MS,watchMs:TOP_LOAD_RELEASE_ANCHOR_WATCH_MS},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
      // #endregion
      pendingShiftAnchorRestoreRef.current = {
        reason,
        targetOffset: anchorOffset,
        releaseAnchorDistanceFromTop: anchorDistanceFromTop,
        armedScrollSize: rlsHandle?.scrollSize ?? null,
        lockUntilAt: now + TOP_LOAD_RELEASE_ANCHOR_LOCK_MS,
        watchUntilAt: now + TOP_LOAD_RELEASE_ANCHOR_WATCH_MS,
      };
      topLoadPostReleaseCooldownUntilRef.current = now + TOP_LOAD_RELEASE_ANCHOR_WATCH_MS;
      if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
        shiftReleaseAnchorWatchTimeoutRef.current = null;
      }
      shiftReleaseAnchorWatchTimeoutRef.current = window.setTimeout(() => {
        shiftReleaseAnchorWatchTimeoutRef.current = null;
        clearPendingShiftAnchorRestore();
      }, TOP_LOAD_RELEASE_ANCHOR_WATCH_MS);
      if (shiftReleaseAnchorWatchRafRef.current != null) {
        window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
        shiftReleaseAnchorWatchRafRef.current = null;
      }
      const tickAnchorWatch = () => {
        const pendingRestore = pendingShiftAnchorRestoreRef.current;
        if (!pendingRestore) {
          shiftReleaseAnchorWatchRafRef.current = null;
          return;
        }
        const nowTick = Date.now();
        if (nowTick >= pendingRestore.watchUntilAt) {
          clearPendingShiftAnchorRestore();
          shiftReleaseAnchorWatchRafRef.current = null;
          return;
        }
        const handle = vlistRef.current;
        if (handle && !topLoadTransactionActiveRef.current && !pendingRestore.suppressRestore) {
          const currentOffset = handle.scrollOffset;
          const delta = Math.abs(currentOffset - pendingRestore.targetOffset);
          const withinLockWindow = nowTick <= pendingRestore.lockUntilAt;
          const lockTolerancePx = pendingRestore.reason === "events-only-growth"
            ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
            : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
          const severeTopCollapse =
            pendingRestore.reason === "events-only-growth"
            && currentOffset <= TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX
            && delta > TOP_LOAD_ENTER_THRESHOLD;
          const shouldRestore = pendingRestore.reason === "events-only-growth"
            ? severeTopCollapse
            : withinLockWindow
              ? delta > lockTolerancePx
              : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
          if (shouldRestore) {
            debugLog("ChatMessageList", "load-older-release-anchor-restore", {
              reason: pendingRestore.reason,
              restoreMode: severeTopCollapse
                ? "raf-collapse"
                : withinLockWindow
                  ? "raf-lock"
                  : "raf-watch",
              fromOffset: currentOffset,
              targetOffset: pendingRestore.targetOffset,
              delta,
              releaseAnchorDistanceFromTop: pendingRestore.releaseAnchorDistanceFromTop,
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
            });
            // #region agent log
            fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:rAF-anchor-scrollTo',message:'rAF anchor restore scrollTo',data:{from:currentOffset,to:pendingRestore.targetOffset,delta,scrollSize:handle.scrollSize,viewportSize:handle.viewportSize},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
            // #endregion
            handle.scrollTo(pendingRestore.targetOffset);
          }
        }
        shiftReleaseAnchorWatchRafRef.current = window.requestAnimationFrame(tickAnchorWatch);
      };
      shiftReleaseAnchorWatchRafRef.current = window.requestAnimationFrame(tickAnchorWatch);
      const keepShiftDuringAnchorLock = reason !== "events-only-growth"
        || (anchorDistanceFromTop != null && anchorDistanceFromTop <= TOP_LOAD_ENTER_THRESHOLD);
      shiftReleasePendingRef.current = keepShiftDuringAnchorLock;
      pendingShiftRestoreFrameRef.current = keepShiftDuringAnchorLock;
      if (!keepShiftDuringAnchorLock) {
        shiftForceDisabledRef.current = true;
        shiftDeactivateTokenRef.current += 1;
        setShiftActive(false);
        return;
      }
      shiftForceDisabledRef.current = false;
      const nextToken = shiftDeactivateTokenRef.current + 1;
      shiftDeactivateTokenRef.current = nextToken;
      const shiftDeactivateDelayMs = TOP_LOAD_RELEASE_ANCHOR_WATCH_MS;
      debugLog("ChatMessageList", "shift-deactivate-scheduled", {
        reason,
        delayMs: shiftDeactivateDelayMs,
        token: nextToken,
        releaseAnchorOffset: anchorOffset,
        releaseAnchorDistanceFromTop: anchorDistanceFromTop,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        stickyBottom: stickyBottomRef.current,
        topLoadTransactionActive: topLoadTransactionActiveRef.current,
      });
      window.setTimeout(() => {
        if (shiftDeactivateTokenRef.current !== nextToken) {
          return;
        }
        shiftForceDisabledRef.current = true;
        // #region agent log
        const deactHandle = vlistRef.current;
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:shift-deactivate-timer',message:'shift deactivate timer fired',data:{reason,delayMs:shiftDeactivateDelayMs,token:nextToken,scrollOffset:deactHandle?.scrollOffset,scrollSize:deactHandle?.scrollSize,viewportSize:deactHandle?.viewportSize,pendingAnchor:pendingShiftAnchorRestoreRef.current!=null},timestamp:Date.now(),hypothesisId:'H7'})}).catch(()=>{});
        // #endregion
        debugLog("ChatMessageList", "shift-deactivate-fired", {
          reason,
          delayMs: shiftDeactivateDelayMs,
          token: nextToken,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
          topLoadTransactionActive: topLoadTransactionActiveRef.current,
        });
        setShiftActive(false);
        if (scrollWrapperRef.current) {
          const scrollerEl = scrollWrapperRef.current.firstElementChild as HTMLElement | null;
          if (scrollerEl) scrollerEl.style.visibility = "";
        }
      }, shiftDeactivateDelayMs);
      return;
    }

    clearPendingShiftAnchorRestore();
    shiftReleasePendingRef.current = false;
    pendingShiftRestoreFrameRef.current = false;
    shiftForceDisabledRef.current = true;
    shiftDeactivateTokenRef.current += 1;
    setShiftActive(false);
  }, [clearPendingShiftAnchorRestore, readScrollSnapshot]);

  const renderableItems = useMemo(
    () => items.filter((item) => item.kind !== "activity"),
    [items],
  );
  const firstRenderableKey = useMemo(
    () => (renderableItems.length > 0 ? getTimelineItemKey(renderableItems[0]) : null),
    [renderableItems],
  );

  const displayItems = useMemo(() => {
    const result: (ChatTimelineItem | "thinking-placeholder")[] = [...renderableItems];
    if (showThinkingPlaceholder) {
      result.push("thinking-placeholder");
    }
    return result;
  }, [renderableItems, showThinkingPlaceholder]);

  useEffect(() => {
    hasOlderHistoryRef.current = hasOlderHistory;
    loadingOlderHistoryPropRef.current = loadingOlderHistory;
    topPaginationInteractionReadyRef.current = topPaginationInteractionReady;
    onLoadOlderHistoryRef.current = onLoadOlderHistory;
  }, [
    hasOlderHistory,
    loadingOlderHistory,
    topPaginationInteractionReady,
    onLoadOlderHistory,
  ]);

  useEffect(() => {
    renderableCountRef.current = renderableItems.length;
    renderableFirstKeyRef.current = firstRenderableKey;
  }, [firstRenderableKey, renderableItems.length]);

  // #region agent log — continuous visual position tracker (H10/H11)
  useEffect(() => {
    const wrapper = scrollWrapperRef.current;
    if (!wrapper) return;

    let prevSt = 0;
    let prevSh = 0;
    let prevItemTops: number[] = [];
    let idleFrames = 0;
    let rafId: number | null = null;
    let started = false;

    const tick = () => {
      const scroller = wrapper.firstElementChild as HTMLElement | null;
      if (!scroller) { rafId = requestAnimationFrame(tick); return; }

      if (!started) {
        started = true;
        prevSt = scroller.scrollTop;
        prevSh = scroller.scrollHeight;
      }

      const st = scroller.scrollTop;
      const sh = scroller.scrollHeight;
      const stDelta = st - prevSt;
      const shDelta = sh - prevSh;

      const children = scroller.children;
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleItems: { idx: number; top: number }[] = [];
      for (let i = 0; i < children.length; i++) {
        const r = children[i].getBoundingClientRect();
        if (r.bottom > scrollerRect.top && r.top < scrollerRect.bottom) {
          visibleItems.push({ idx: i, top: r.top - scrollerRect.top });
        }
      }

      let maxItemShift = 0;
      if (prevItemTops.length > 0 && visibleItems.length > 0) {
        for (const vi of visibleItems) {
          const prevTop = prevItemTops[vi.idx];
          if (prevTop !== undefined) {
            const itemVisualDelta = (vi.top - prevTop) + stDelta;
            if (Math.abs(itemVisualDelta) > Math.abs(maxItemShift)) {
              maxItemShift = itemVisualDelta;
            }
          }
        }
      }

      const hasSignificant = Math.abs(stDelta) > 50 || Math.abs(shDelta) > 50 || Math.abs(maxItemShift) > 15;

      if (hasSignificant) {
        idleFrames = 0;
        const sample = visibleItems.slice(0, 3).map(v => ({ i: v.idx, t: Math.round(v.top) }));
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:visual-tracker',message:'vt',data:{st:Math.round(st),sh:Math.round(sh),stD:Math.round(stDelta),shD:Math.round(shDelta),mis:Math.round(maxItemShift),vis:sample,nVis:visibleItems.length},timestamp:Date.now(),hypothesisId:'H10'})}).catch(()=>{});
      } else if (stDelta !== 0 || shDelta !== 0) {
        idleFrames = 0;
      } else {
        idleFrames++;
      }

      const newTops: number[] = [];
      for (const vi of visibleItems) { newTops[vi.idx] = vi.top; }
      prevItemTops = newTops;
      prevSt = st;
      prevSh = sh;

      if (idleFrames < 600) {
        rafId = requestAnimationFrame(tick);
      } else {
        visualTrackerActiveRef.current = false;
      }
    };

    visualTrackerActiveRef.current = true;
    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      visualTrackerActiveRef.current = false;
    };
  }, []);
  // #endregion

  const prevDisplayCountRef = useRef(displayItems.length);
  useLayoutEffect(() => {
    const prevCount = prevDisplayCountRef.current;
    if (displayItems.length !== prevCount) {
      lastItemCountChangeRef.current = Date.now();
      prevDisplayCountRef.current = displayItems.length;
      // #region agent log
      const leH = vlistRef.current;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:layoutEffect-items-changed',message:'displayItems count changed',data:{prevCount,newCount:displayItems.length,delta:displayItems.length-prevCount,scrollOffset:leH?.scrollOffset,scrollSize:leH?.scrollSize,viewportSize:leH?.viewportSize,shiftActive,topLoadTxActive:topLoadTransactionActiveRef.current,effectiveShift:topLoadTransactionActiveRef.current||(shiftActive&&!shiftForceDisabledRef.current&&pendingShiftAnchorRestoreRef.current!=null)},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
      // Frame-by-frame visual tracker (H8)
      if (displayItems.length > prevCount && !frameTrackerActiveRef.current) {
        const ftContainer = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
        if (ftContainer) {
          frameTrackerActiveRef.current = true;
          const preGeo = prePaginationDomGeoRef.current;
          prePaginationDomGeoRef.current = null;
          const leScrollTop = ftContainer.scrollTop;
          const leScrollHeight = ftContainer.scrollHeight;
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:frame-track-init',message:'frame tracker start (layoutEffect)',data:{preScrollTop:preGeo?.scrollTop??null,preScrollHeight:preGeo?.scrollHeight??null,leScrollTop,leScrollHeight,heightGrowth:preGeo?leScrollHeight-preGeo.scrollHeight:null,topShift:preGeo?leScrollTop-preGeo.scrollTop:null,itemDelta:displayItems.length-prevCount},timestamp:Date.now(),hypothesisId:'H8'})}).catch(()=>{});
          let prevFt = leScrollTop;
          let prevFh = leScrollHeight;
          let fi = 0;
          const trackFrame = () => {
            if (fi > 25) { frameTrackerActiveRef.current = false; return; }
            const ct = ftContainer.scrollTop;
            const ch = ftContainer.scrollHeight;
            const td = ct - prevFt;
            const hd = ch - prevFh;
            fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:frame-track',message:'frame '+fi,data:{f:fi,scrollTop:ct,scrollHeight:ch,topDelta:td,heightDelta:hd,visualShift:hd-td,cumTopFromPre:preGeo?ct-preGeo.scrollTop:null,cumHeightFromPre:preGeo?ch-preGeo.scrollHeight:null},timestamp:Date.now(),hypothesisId:'H8'})}).catch(()=>{});
            prevFt = ct;
            prevFh = ch;
            fi++;
            requestAnimationFrame(trackFrame);
          };
          requestAnimationFrame(trackFrame);
        }
      }
      // #endregion
    }

    // Prevent one-frame flash: if items grew and shift is pending, hide the
    // scroll container before the browser paints. The onScroll handler will
    // reveal it once virtua adjusts the scroll offset (typically ~8ms).
    if (shiftPendingVisibilityHideRef.current && displayItems.length > prevCount) {
      shiftPendingVisibilityHideRef.current = false;
      const wrapper = scrollWrapperRef.current;
      if (wrapper) {
        const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
        if (scrollerEl) {
          scrollerEl.style.visibility = "hidden";
          // #region agent log
          const h = vlistRef.current;
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:layoutEffect-hide',message:'hiding scroller before paint',data:{prevCount,newCount:displayItems.length,scrollSize:h?.scrollSize,offset:h?.scrollOffset,viewportSize:h?.viewportSize},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
          // #endregion
          requestAnimationFrame(() => {
            if (scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
              const pendingAnchor = pendingShiftAnchorRestoreRef.current;
              if (pendingAnchor && !pendingAnchor.suppressRestore) {
                pendingAnchor.suppressRestore = true;
              }
              // #region agent log
              fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:layoutEffect-rAF-fallback',message:'rAF fallback unhide',data:{},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
              // #endregion
            }
          });
        }
      }
    }

    if (pendingShiftRestoreFrameRef.current) {
      pendingShiftRestoreFrameRef.current = false;
    }

    const pendingAnchorRestore = pendingShiftAnchorRestoreRef.current;
    if (pendingAnchorRestore) {
      const now = Date.now();
      if (now >= pendingAnchorRestore.watchUntilAt) {
        clearPendingShiftAnchorRestore();
      } else {
        const handle = vlistRef.current;
        if (handle) {
          const currentOffset = handle.scrollOffset;
          // #region agent log
          const prevGeomLayout = lastScrollGeometryRef.current;
          const layoutSizeDelta = prevGeomLayout ? handle.scrollSize - prevGeomLayout.scrollSize : 0;
          const layoutOffsetDelta = prevGeomLayout ? currentOffset - prevGeomLayout.offset : 0;
          if (
            pendingAnchorRestore.reason === "events-only-growth"
            && prevGeomLayout
            && layoutSizeDelta > 50
            && Math.abs(layoutOffsetDelta - layoutSizeDelta) < 100
            && currentOffset > pendingAnchorRestore.targetOffset + 50
          ) {
            pendingAnchorRestore.suppressRestore = true;
            shiftBaselineDfbRef.current = null;
            const wrapper = scrollWrapperRef.current;
            if (wrapper) {
              const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
              if (scrollerEl && scrollerEl.style.visibility === "hidden") {
                scrollerEl.style.visibility = "";
              }
            }
          }
          // #endregion
          if (pendingAnchorRestore?.suppressRestore) {
            // Shift mode is handling visual stability; skip all restore logic.
          } else {
            const movedAwayFromTopDuringEventsGrowth = pendingAnchorRestore.reason === "events-only-growth"
              && currentOffset > pendingAnchorRestore.targetOffset + TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            if (movedAwayFromTopDuringEventsGrowth && !topLoadTransactionActiveRef.current) {
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: "events-growth-away-from-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: currentOffset,
                deltaFromTarget: Math.abs(currentOffset - pendingAnchorRestore.targetOffset),
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
              return;
            }
            const movedTowardTop = currentOffset
              < pendingAnchorRestore.targetOffset - TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const shouldCancelTowardTop = movedTowardTop
              && !topLoadTransactionActiveRef.current
              && pendingAnchorRestore.reason !== "events-only-growth";
            if (shouldCancelTowardTop) {
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: "toward-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: currentOffset,
                deltaFromTarget: Math.abs(currentOffset - pendingAnchorRestore.targetOffset),
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
              return;
            }
            const delta = Math.abs(currentOffset - pendingAnchorRestore.targetOffset);
            const withinLockWindow = now <= pendingAnchorRestore.lockUntilAt;
            const prevGeometry = lastScrollGeometryRef.current;
            const currentScrollSize = handle.scrollSize;
            const currentViewportSize = handle.viewportSize;
            const currentMaxScroll = Math.max(currentScrollSize - currentViewportSize, 0);
            const sizeDelta = prevGeometry ? currentScrollSize - prevGeometry.scrollSize : 0;
            const maxScrollDelta = prevGeometry ? currentMaxScroll - prevGeometry.maxScroll : 0;
            const layoutShrinkDetected = prevGeometry != null
              && (sizeDelta < -1 || maxScrollDelta < -1);
            const lockTolerancePx = pendingAnchorRestore.reason === "events-only-growth"
              ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
              : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const eventsOnlyShrinkRestore = pendingAnchorRestore.reason === "events-only-growth"
              && layoutShrinkDetected
              && delta > lockTolerancePx;
            const shouldRestore = pendingAnchorRestore.reason === "events-only-growth"
              ? eventsOnlyShrinkRestore
              : withinLockWindow
                ? delta > lockTolerancePx
                : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
            if (shouldRestore) {
              debugLog("ChatMessageList", "load-older-release-anchor-restore", {
                reason: pendingAnchorRestore.reason,
                restoreMode: eventsOnlyShrinkRestore
                  ? "layout-events-shrink"
                  : withinLockWindow
                    ? "layout-lock"
                    : "layout-watch",
                fromOffset: currentOffset,
                targetOffset: pendingAnchorRestore.targetOffset,
                delta,
                sizeDelta,
                maxScrollDelta,
                releaseAnchorDistanceFromTop: pendingAnchorRestore.releaseAnchorDistanceFromTop,
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              handle.scrollTo(pendingAnchorRestore.targetOffset);
              return;
            }
          }
        }
      }
    }

    if (shiftReleasePendingRef.current) {
      shiftReleasePendingRef.current = false;
    }

    const pending = pendingShiftReleaseRef.current;
    if (!pending || !pending.loadFinished || pending.releaseQueued) {
      return;
    }

    const renderableGrew = renderableItems.length > pending.baselineRenderableCount;
    const firstKeyChanged = firstRenderableKey !== pending.baselineFirstRenderableKey;
    const prependCommitted = firstKeyChanged;
    const nonPrependGrowth = renderableGrew && !firstKeyChanged;
    const hasExplicitNoGrowth = isExplicitNoGrowthResult({
      completionReason: pending.completionReason,
      estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
      messagesAdded: pending.messagesAdded,
      eventsAdded: pending.eventsAdded,
    });
    const noGrowthFinal = hasExplicitNoGrowth && !prependCommitted && !nonPrependGrowth;

    if (!prependCommitted && !nonPrependGrowth && !noGrowthFinal) {
      return;
    }

    const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
    const releaseAnchorDistanceFromTop = releaseAnchorOffset;
    pending.releaseAnchorOffset = releaseAnchorOffset;
    pending.releaseAnchorDistanceFromTop = releaseAnchorDistanceFromTop;

    debugLog("ChatMessageList", "load-older-prepend-eval", {
      cycleId: pending.cycleId,
      requestId: pending.requestId,
      renderableCount: renderableItems.length,
      baselineRenderableCount: pending.baselineRenderableCount,
      firstRenderableKey,
      baselineFirstRenderableKey: pending.baselineFirstRenderableKey,
      prependCommitted,
      nonPrependGrowth,
      noGrowthFinal,
      completionReason: pending.completionReason,
      messagesAdded: pending.messagesAdded,
      eventsAdded: pending.eventsAdded,
      estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
      releaseAnchorOffset,
      releaseAnchorDistanceFromTop,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      shiftActive,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
    });

    pending.releaseQueued = true;
    releaseShift(nonPrependGrowth
      ? "non-prepend-growth"
      : prependCommitted
        ? "prepend-commit"
        : "no-growth");
  }, [
    clearPendingShiftAnchorRestore,
    displayItems.length,
    firstRenderableKey,
    readScrollSnapshot,
    releaseShift,
    renderableItems.length,
    shiftActive,
  ]);

  // Normal scroll direction: offset 0 = top (oldest), max offset = bottom (newest).
  const handleScroll = useCallback((offset: number) => {
    const handle = vlistRef.current;
    if (!handle) return;

    const { scrollSize, viewportSize } = handle;
    const maxScroll = scrollSize - viewportSize;
    const prevGeometry = lastScrollGeometryRef.current;

    // #region agent log
    const shiftJustFired = prevGeometry && Math.abs(offset - prevGeometry.offset) > 200;
    const recentShift = prevGeometry && prevGeometry.scrollSize > 5500 && scrollSize > 5500;
    const scrollSizeChanged = prevGeometry && Math.abs(scrollSize - prevGeometry.scrollSize) > 1;
    const inAnchorWindow = pendingShiftAnchorRestoreRef.current != null;
    const scrollSizeDelta = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
    if (offset <= 500 || shiftJustFired || recentShift || scrollSizeChanged || inAnchorWindow) {
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-track',message:'scroll track',data:{offset,prevOffset:prevGeometry?.offset??null,jumpDelta:prevGeometry?offset-prevGeometry.offset:null,scrollSize,scrollSizeDelta,viewportSize,maxScroll,shiftTxActive:topLoadTransactionActiveRef.current,pendingAnchor:inAnchorWindow,pendingAnchorTarget:pendingShiftAnchorRestoreRef.current?.targetOffset??null,driftGuardActive:Date.now()<=eventsOnlyLateDriftGuardUntilRef.current,scrollSizeChanged:!!scrollSizeChanged,shiftActive},timestamp:Date.now(),hypothesisId:'H6'})}).catch(()=>{});
    }
    if (scrollSizeChanged && Math.abs(scrollSizeDelta) > 50 && !inAnchorWindow) {
      const ftC = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
      const innerEl = ftC?.firstElementChild as HTMLElement | null;
      const innerStyle = innerEl ? (innerEl.style.top || innerEl.style.transform || '') : '';
      const innerRect = innerEl?.getBoundingClientRect();
      const parentRect = ftC?.getBoundingClientRect();
      const innerVisualTop = innerRect && parentRect ? innerRect.top - parentRect.top : null;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-remeasure',message:'remeasure event',data:{offset,prevOffset:prevGeometry?.offset??null,jumpDelta:prevGeometry?offset-prevGeometry.offset:null,scrollSize,scrollSizeDelta,innerStyle,innerVisualTop},timestamp:Date.now(),hypothesisId:'H10'})}).catch(()=>{});
    }
    // #endregion

    // Hide-and-reveal: when VList remeasures items and makes a large scrollTop
    // adjustment, React hasn't yet re-rendered item positions. The browser would
    // paint 1 frame with items at wrong positions (the visible "jump"). Hide the
    // inner container during this gap, reveal after React re-renders.
    if (
      prevGeometry
      && !scrollJumpCompensationActiveRef.current
      && !pendingShiftAnchorRestoreRef.current
      && !topLoadTransactionActiveRef.current
    ) {
      const jumpDelta = offset - prevGeometry.offset;
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const isRemeasureJump = Math.abs(sizeDelta) > 80 && Math.abs(jumpDelta) > 80 && Math.abs(jumpDelta - sizeDelta) < 50;

      if (isRemeasureJump) {
        const scroller = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
        const innerContainer = scroller?.firstElementChild as HTMLElement | null;
        if (innerContainer) {
          scrollJumpCompensationActiveRef.current = true;
          innerContainer.style.visibility = "hidden";

          // #region agent log
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:jump-hide',message:'hiding inner for remeasure',data:{jumpDelta,sizeDelta},timestamp:Date.now(),hypothesisId:'H13'})}).catch(()=>{});
          // #endregion

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              innerContainer.style.visibility = "";
              scrollJumpCompensationActiveRef.current = false;
              // #region agent log
              fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:jump-reveal',message:'revealing inner after re-render',data:{},timestamp:Date.now(),hypothesisId:'H13'})}).catch(()=>{});
              // #endregion
            });
          });
        }
      }
    }

    const pendingAnchorRestore = pendingShiftAnchorRestoreRef.current;
    if (pendingAnchorRestore) {
      const now = Date.now();
      const withinLockWindow = now <= pendingAnchorRestore.lockUntilAt;
      if (now >= pendingAnchorRestore.watchUntilAt) {
        clearPendingShiftAnchorRestore();
      } else {
        // #region agent log
        const sizeDeltaForAnchorAdj = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
        const offsetDeltaForAnchorAdj = prevGeometry ? offset - prevGeometry.offset : 0;
        const shiftGrowthDetected =
          pendingAnchorRestore.reason === "events-only-growth"
          && prevGeometry
          && sizeDeltaForAnchorAdj > 50
          && Math.abs(offsetDeltaForAnchorAdj - sizeDeltaForAnchorAdj) < 100
          && offset > pendingAnchorRestore.targetOffset + 50;
        if (shiftGrowthDetected && !pendingAnchorRestore.suppressRestore) {
          pendingAnchorRestore.suppressRestore = true;
          shiftBaselineDfbRef.current = null;
          // #region agent log
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-shift-suppress',message:'shift growth: suppress restore, let VList shift handle remeasurement',data:{oldTarget:pendingAnchorRestore.targetOffset,sizeDelta:sizeDeltaForAnchorAdj,offsetDelta:offsetDeltaForAnchorAdj,offset,prevOffset:prevGeometry.offset},timestamp:Date.now(),hypothesisId:'FIX4'})}).catch(()=>{});
          // #endregion
          const wrapper = scrollWrapperRef.current;
          if (wrapper) {
            const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
            if (scrollerEl && scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
            }
          }
        }
        // #endregion
        if (!shiftGrowthDetected && !pendingAnchorRestore.suppressRestore) {
          const movedAwayFromTopDuringEventsGrowth = pendingAnchorRestore.reason === "events-only-growth"
            && offset > pendingAnchorRestore.targetOffset + TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
          const allowEventsGrowthUserCancel = pendingAnchorRestore.reason !== "events-only-growth"
            || !withinLockWindow;
          if (
            movedAwayFromTopDuringEventsGrowth
            && !topLoadTransactionActiveRef.current
            && allowEventsGrowthUserCancel
          ) {
            debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
              reason: pendingAnchorRestore.reason,
              cancelMode: "events-growth-away-from-top",
              targetOffset: pendingAnchorRestore.targetOffset,
              fromOffset: offset,
              deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
            });
            clearPendingShiftAnchorRestore();
          } else {
            const sizeDelta = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
            const maxScrollDelta = prevGeometry ? maxScroll - prevGeometry.maxScroll : 0;
            const viewportDelta = prevGeometry ? viewportSize - prevGeometry.viewportSize : 0;
            const offsetDelta = prevGeometry ? offset - prevGeometry.offset : 0;
            const layoutShrinkDetected = prevGeometry != null
              && (sizeDelta < -1 || maxScrollDelta < -1);
            const movedTowardTop = offset
              < pendingAnchorRestore.targetOffset - TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const shouldCancelTowardTop = movedTowardTop
              && !topLoadTransactionActiveRef.current
              && pendingAnchorRestore.reason !== "events-only-growth"
              && (
                !layoutShrinkDetected
                || allowEventsGrowthUserCancel
              );
            if (shouldCancelTowardTop) {
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: pendingAnchorRestore.reason === "events-only-growth"
                  ? "toward-top-user-intent"
                  : "toward-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: offset,
                deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
                sizeDelta,
                maxScrollDelta,
                viewportDelta,
                offsetDelta,
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
            } else {
              const movingAwayFromAnchor = prevGeometry
                ? Math.abs(offset - pendingAnchorRestore.targetOffset)
                > Math.abs(prevGeometry.offset - pendingAnchorRestore.targetOffset) + 0.5
                : false;
              const likelyUserScrollIntent = prevGeometry != null
                && Math.abs(sizeDelta) <= 1
                && Math.abs(maxScrollDelta) <= 1
                && Math.abs(viewportDelta) <= 1
                && Math.abs(offsetDelta) > TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX
                && movingAwayFromAnchor;
              if (
                likelyUserScrollIntent
                && !topLoadTransactionActiveRef.current
                && allowEventsGrowthUserCancel
              ) {
                debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
                  reason: pendingAnchorRestore.reason,
                  cancelMode: "user-scroll-intent",
                  targetOffset: pendingAnchorRestore.targetOffset,
                  fromOffset: offset,
                  deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
                  offsetDelta,
                  sizeDelta,
                  maxScrollDelta,
                  viewportDelta,
                  ...readScrollSnapshot(),
                  atTop: atTopRef.current,
                  atBottom: atBottomRef.current,
                  stickyBottom: stickyBottomRef.current,
                  topLoadTransactionActive: topLoadTransactionActiveRef.current,
                });
                clearPendingShiftAnchorRestore();
              } else {
                const delta = Math.abs(offset - pendingAnchorRestore.targetOffset);
                const lockTolerancePx = pendingAnchorRestore.reason === "events-only-growth"
                  ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
                  : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
                const eventsOnlyShrinkRestore = pendingAnchorRestore.reason === "events-only-growth"
                  && layoutShrinkDetected
                  && delta > lockTolerancePx;
                const shouldRestore = pendingAnchorRestore.reason === "events-only-growth"
                  ? eventsOnlyShrinkRestore
                  : withinLockWindow
                    ? delta > lockTolerancePx
                    : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
                if (shouldRestore) {
                  debugLog("ChatMessageList", "load-older-release-anchor-restore", {
                    reason: pendingAnchorRestore.reason,
                    restoreMode: eventsOnlyShrinkRestore
                      ? "on-scroll-events-shrink"
                      : withinLockWindow
                        ? "on-scroll-lock"
                        : "on-scroll-watch",
                    fromOffset: offset,
                    targetOffset: pendingAnchorRestore.targetOffset,
                    delta,
                    releaseAnchorDistanceFromTop: pendingAnchorRestore.releaseAnchorDistanceFromTop,
                    ...readScrollSnapshot(),
                    atTop: atTopRef.current,
                    atBottom: atBottomRef.current,
                    stickyBottom: stickyBottomRef.current,
                    topLoadTransactionActive: topLoadTransactionActiveRef.current,
                  });
                  // #region agent log
                  fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-anchor-scrollTo',message:'handleScroll anchor restore scrollTo',data:{from:offset,to:pendingAnchorRestore.targetOffset,reason:pendingAnchorRestore.reason,scrollSize,maxScroll},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
                  // #endregion
                  handle.scrollTo(pendingAnchorRestore.targetOffset);
                  return;
                }
              }
            }
          }
        }
      }
    }

    const now = Date.now();
    if (
      !pendingAnchorRestore
      && now <= eventsOnlyLateDriftGuardUntilRef.current
      && now >= eventsOnlyLateDriftRestoreCooldownUntilRef.current
      && prevGeometry
      && !topLoadTransactionActiveRef.current
    ) {
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const maxScrollDelta = maxScroll - prevGeometry.maxScroll;
      const viewportDelta = viewportSize - prevGeometry.viewportSize;
      const offsetDelta = offset - prevGeometry.offset;
      const noLayoutChange =
        Math.abs(sizeDelta) <= 1
        && Math.abs(maxScrollDelta) <= 1
        && Math.abs(viewportDelta) <= 1;
      const collapseToAbsoluteTop =
        offset <= TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX
        && prevGeometry.offset >= TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_MIN_PREV_OFFSET_PX
        && offsetDelta <= -TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX;
      const recentUserScrollIntent =
        now - lastUserScrollIntentAtRef.current <= TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_USER_INPUT_GRACE_MS;
      if (noLayoutChange && collapseToAbsoluteTop && !recentUserScrollIntent) {
        eventsOnlyLateDriftRestoreCooldownUntilRef.current = now + TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_RESTORE_COOLDOWN_MS;
        debugLog("ChatMessageList", "load-older-post-release-drift-restore", {
          restoreMode: "events-only-late-drift",
          fromOffset: offset,
          targetOffset: prevGeometry.offset,
          offsetDelta,
          sizeDelta,
          maxScrollDelta,
          viewportDelta,
          guardUntil: eventsOnlyLateDriftGuardUntilRef.current,
          lastUserScrollIntentAt: lastUserScrollIntentAtRef.current,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
          topLoadTransactionActive: topLoadTransactionActiveRef.current,
        });
        // #region agent log
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:lateDriftGuard-scrollTo',message:'late drift guard scrollTo',data:{from:offset,to:prevGeometry.offset,offsetDelta,guardUntil:eventsOnlyLateDriftGuardUntilRef.current,recentUserIntent:now-lastUserScrollIntentAtRef.current},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
        // #endregion
        handle.scrollTo(prevGeometry.offset);
        return;
      }
    }

    const prevAtTop = atTopRef.current;
    const isAtTop = prevAtTop
      ? offset <= TOP_LOAD_LEAVE_THRESHOLD
      : offset <= TOP_LOAD_ENTER_THRESHOLD;
    const isAtBottom = maxScroll > 0 ? offset >= maxScroll - AT_BOTTOM_THRESHOLD : true;

    const prevSize = lastScrollSizeRef.current;
    const contentGrew = scrollSize > prevSize && prevSize > 0;

    // Only flip stickyBottom off when the user has scrolled far enough from
    // the bottom that it's clearly intentional. Small drifts near the bottom
    // are VList measurement artifacts, not user scrolling.
    const distFromBottom = maxScroll > 0 ? maxScroll - offset : 0;
    const STICKY_OFF_THRESHOLD = viewportSize * 0.25;
    if (!isAtBottom && distFromBottom > STICKY_OFF_THRESHOLD && !contentGrew) {
      stickyBottomRef.current = false;
    }
    if (isAtBottom) {
      stickyBottomRef.current = true;
    }

    if (prevGeometry) {
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const maxScrollDelta = maxScroll - prevGeometry.maxScroll;
      const offsetDelta = offset - prevGeometry.offset;
      const viewportDelta = viewportSize - prevGeometry.viewportSize;
      const geometryChanged = Math.abs(sizeDelta) > 1
        || Math.abs(maxScrollDelta) > 1
        || Math.abs(offsetDelta) > 1
        || Math.abs(viewportDelta) > 1;
      const suspiciousShrinkRebound =
        prevGeometry.scrollSize > scrollSize
        && prevGeometry.distanceFromTop <= TOP_LOAD_LEAVE_THRESHOLD
        && Math.abs(offsetDelta) > 120;
      const suspiciousScrollOnlyDrift =
        Math.abs(sizeDelta) <= 1
        && Math.abs(maxScrollDelta) <= 1
        && Math.abs(offsetDelta) >= 12
        && prevGeometry.distanceFromTop <= TOP_LOAD_LEAVE_THRESHOLD;

      if (geometryChanged) {
        debugLog("ChatMessageList", "scroll-geometry-update", {
          offset,
          scrollSize,
          viewportSize,
          maxScroll,
          distanceFromTop: Math.max(offset, 0),
          distanceFromBottom: Math.max(maxScroll - offset, 0),
          prevOffset: prevGeometry.offset,
          prevScrollSize: prevGeometry.scrollSize,
          prevViewportSize: prevGeometry.viewportSize,
          prevMaxScroll: prevGeometry.maxScroll,
          prevDistanceFromTop: prevGeometry.distanceFromTop,
          prevDistanceFromBottom: prevGeometry.distanceFromBottom,
          offsetDelta,
          sizeDelta,
          maxScrollDelta,
          viewportDelta,
          suspiciousShrinkRebound,
          suspiciousScrollOnlyDrift,
          shiftActive: topLoadTransactionActiveRef.current,
          pendingShiftRestore: pendingShiftAnchorRestoreRef.current != null,
          pendingShiftRestoreFrame: pendingShiftRestoreFrameRef.current,
          topLoadPostReleaseCooldownUntil: topLoadPostReleaseCooldownUntilRef.current,
          eventsOnlyLateDriftGuardUntil: eventsOnlyLateDriftGuardUntilRef.current,
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
        });
      }
    }

    // If content grew while sticky but we're no longer at bottom, re-scroll.
    // Skip this correction while top-prepend transaction is active.
    if (contentGrew && stickyBottomRef.current && !isAtBottom && viewportSize > 0) {
      if (topLoadTransactionActiveRef.current) {
        debugLog("ChatMessageList", "sticky-bottom-correction-skipped", {
          reason: "top-load-transaction-active",
          offset,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          shiftActive: topLoadTransactionActiveRef.current,
          stickyBottom: stickyBottomRef.current,
        });
      } else {
        debugLog("ChatMessageList", "sticky-bottom-correction-applied", {
          reason: "content-grew-while-sticky",
          offset,
          beforeScrollOffset: handle.scrollOffset,
          targetScrollOffset: maxScroll,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          shiftActive: topLoadTransactionActiveRef.current,
          stickyBottom: stickyBottomRef.current,
        });
        handle.scrollTo(maxScroll);
      }
    }

    lastScrollSizeRef.current = scrollSize;
    lastScrollGeometryRef.current = {
      scrollSize,
      viewportSize,
      maxScroll,
      offset,
      distanceFromTop: Math.max(offset, 0),
      distanceFromBottom: Math.max(maxScroll - offset, 0),
      timestamp: Date.now(),
    };

    const nowForBottom = Date.now();
    const msSinceItemChange = nowForBottom - lastItemCountChangeRef.current;
    const suppressBottom = isAtBottom && userScrolledAwayRef.current && msSinceItemChange < 300;

    if (!suppressBottom) {
      if (!isAtBottom) userScrolledAwayRef.current = true;
      if (isAtBottom) userScrolledAwayRef.current = false;
      if (atBottomRef.current !== isAtBottom) {
        atBottomRef.current = isAtBottom;
        setAtBottom(isAtBottom);
      }
    }

    if (atTopRef.current !== isAtTop) {
      // #region agent log
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-atTop-change',message:'atTop transition',data:{from:atTopRef.current,to:isAtTop,offset,scrollSize,viewportSize,maxScroll,shiftActive:topLoadTransactionActiveRef.current},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
      // #endregion
      if (!isAtTop) {
        leftTopZoneRef.current = true;
      }
      atTopRef.current = isAtTop;
      setAtTop(isAtTop);
    }
  }, []);

  useEffect(() => {
    atTopRef.current = atTop;
  }, [atTop]);

  // Scroll to bottom helper — uses scrollToIndex after a rAF to ensure VList
  // has measured items. Without this delay, scrollToIndex fires before layout
  // and the scroll lands at the wrong position.
  const scrollToBottom = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle || displayItems.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      if (!vlistRef.current) return;
      vlistRef.current.scrollToIndex(displayItems.length - 1, { align: "end" });
    });
  }, [displayItems.length]);

  // On mount (or when component re-keys on thread switch), scroll to bottom.
  // useEffect (not useLayoutEffect) so VList has rendered and measured items.
  const mountedRef = useRef(false);
  // Tracks whether we intend to stay pinned to the bottom. Unlike atBottomRef
  // (which is derived from scroll offset and can flip false when VList items
  // resize), this only flips false on genuine upward user scrolls.
  const stickyBottomRef = useRef(true);
  const lastScrollSizeRef = useRef(0);
  const lastScrollGeometryRef = useRef<{
    scrollSize: number;
    viewportSize: number;
    maxScroll: number;
    offset: number;
    distanceFromTop: number;
    distanceFromBottom: number;
    timestamp: number;
  } | null>(null);
  useEffect(() => {
    if (mountedRef.current) return;
    if (displayItems.length === 0) return;
    mountedRef.current = true;
    stickyBottomRef.current = true;
    scrollToBottom();
  }, [displayItems.length, scrollToBottom]);

  // When VList fires onScrollEnd and we're still logically sticky, ensure
  // we're actually at the bottom. This catches cases where content resized
  // during scroll settling and the final position isn't quite at bottom.
  const handleScrollEnd = useCallback(() => {
    const baselineDfb = shiftBaselineDfbRef.current;
    if (baselineDfb != null) {
      const h = vlistRef.current;
      if (h) {
        const curOff = h.scrollOffset;
        const curMax = h.scrollSize - h.viewportSize;
        const targetOff = curMax - baselineDfb;
        const correction = targetOff - curOff;
        shiftBaselineDfbRef.current = null;
        if (Math.abs(correction) > 3 && targetOff >= 0 && targetOff <= curMax) {
          h.scrollTo(targetOff);
        }
        // #region agent log
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:scrollEnd-correction',message:'scrollEnd drift correction',data:{baselineDfb,correction,targetOff,currentOffset:curOff},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
        // #endregion
      }
    }
    if (topLoadTransactionActiveRef.current) {
      debugLog("ChatMessageList", "sticky-bottom-correction-skipped", {
        reason: "top-load-transaction-active-scroll-end",
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        shiftActive: topLoadTransactionActiveRef.current,
        stickyBottom: stickyBottomRef.current,
      });
      return;
    }
    if (!stickyBottomRef.current) return;
    const h = vlistRef.current;
    if (!h) return;
    const { scrollSize, viewportSize, scrollOffset } = h;
    const maxScroll = scrollSize - viewportSize;
    if (viewportSize > 0 && maxScroll > 0 && scrollOffset < maxScroll - AT_BOTTOM_THRESHOLD) {
      debugLog("ChatMessageList", "sticky-bottom-correction-applied", {
        reason: "scroll-end-not-at-bottom",
        beforeScrollOffset: scrollOffset,
        targetScrollOffset: maxScroll,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        shiftActive: topLoadTransactionActiveRef.current,
        stickyBottom: stickyBottomRef.current,
      });
      h.scrollTo(maxScroll);
    }
  }, [readScrollSnapshot]);

  // Auto-scroll to bottom when new items are appended and user is at bottom
  useEffect(() => {
    if (!mountedRef.current) return;
    if ((!atBottomRef.current && !stickyBottomRef.current) || displayItems.length === 0) return;
    scrollToBottom();
    // Only react to item count changes, not atBottom state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayItems.length, scrollToBottom]);

  // When sending a new message, snap to bottom
  useEffect(() => {
    if (sendingMessage && displayItems.length > 0) {
      userScrolledAwayRef.current = false;
      atBottomRef.current = true;
      stickyBottomRef.current = true;
      setAtBottom(true);
      scrollToBottom();
    }
  }, [sendingMessage, displayItems.length, scrollToBottom]);

  // Rearm cooldown timer for top-load
  useEffect(() => {
    if (topLoadRearmTimeoutRef.current != null) return;

    const now = Date.now();
    const cooldownUntil = Math.max(
      topLoadCooldownUntilRef.current,
      topLoadPostReleaseCooldownUntilRef.current,
    );

    if (!atTop && now >= cooldownUntil) {
      topLoadArmedRef.current = true;
      return;
    }

    const waitMs = Math.max(cooldownUntil - now, 0);
    if (waitMs === 0) {
      if (!atTop) topLoadArmedRef.current = true;
      return;
    }

    topLoadRearmTimeoutRef.current = window.setTimeout(() => {
      topLoadRearmTimeoutRef.current = null;
      if (!atTopRef.current) topLoadArmedRef.current = true;
    }, waitMs);

    return () => {
      if (topLoadRearmTimeoutRef.current != null) {
        window.clearTimeout(topLoadRearmTimeoutRef.current);
        topLoadRearmTimeoutRef.current = null;
      }
    };
  }, [atTop]);

  useEffect(() => {
    debugLog("ChatMessageList", "list-state", {
      itemCount: displayItems.length,
      renderableCount: renderableItems.length,
      loadingOlderHistory,
      hasOlderHistory,
      topPaginationInteractionReady,
      atTop,
      atBottom,
      shiftActive,
      effectiveShiftActive: topLoadTransactionActiveRef.current
        || (shiftActive
          && !shiftForceDisabledRef.current
          && pendingShiftAnchorRestoreRef.current != null),
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
      ...readScrollSnapshot(),
      stickyBottom: stickyBottomRef.current,
      leftTopZone: leftTopZoneRef.current,
      topLoadArmed: topLoadArmedRef.current,
      topLoadCooldownUntil: topLoadCooldownUntilRef.current,
      pendingShiftRestore: pendingShiftAnchorRestoreRef.current != null,
      pendingShiftRestoreFrame: pendingShiftRestoreFrameRef.current,
      shiftForceDisabled: shiftForceDisabledRef.current,
      topLoadPostReleaseCooldownUntil: topLoadPostReleaseCooldownUntilRef.current,
      eventsOnlyLateDriftGuardUntil: eventsOnlyLateDriftGuardUntilRef.current,
    });
  }, [
    atBottom,
    atTop,
    hasOlderHistory,
    topPaginationInteractionReady,
    displayItems.length,
    loadingOlderHistory,
    readScrollSnapshot,
    renderableItems.length,
    shiftActive,
  ]);

  const loadOlder = useCallback(async () => {
    const hasOlderHistoryCurrent = hasOlderHistoryRef.current;
    const loadingOlderHistoryCurrent = loadingOlderHistoryPropRef.current;
    const onLoadOlderHistoryCurrent = onLoadOlderHistoryRef.current;
    const renderableCount = renderableCountRef.current;
    const baselineFirstRenderableKey = renderableFirstKeyRef.current;

    if (loadCycleInFlightRef.current) return;
    if (!hasOlderHistoryCurrent || loadingOlderHistoryCurrent || loadingOlderRef.current) return;
    if (!onLoadOlderHistoryCurrent) return;

    const now = Date.now();
    const cooldownUntil = Math.max(
      topLoadCooldownUntilRef.current,
      topLoadPostReleaseCooldownUntilRef.current,
    );
    if (now < cooldownUntil) return;

    const cycleId = loadCycleCounterRef.current + 1;
    loadCycleCounterRef.current = cycleId;
    const requestId = `older-${cycleId}`;

    loadCycleInFlightRef.current = true;
    loadingOlderRef.current = true;
    topLoadArmedRef.current = false;
    topLoadCooldownUntilRef.current = now + TOP_LOAD_REARM_COOLDOWN_MS;

    if (topLoadRearmTimeoutRef.current != null) {
      window.clearTimeout(topLoadRearmTimeoutRef.current);
      topLoadRearmTimeoutRef.current = null;
    }

    // Enable shift before prepend so VList anchors scroll from the end.
    // Keep it active until prepend commit/no-growth confirmation.
    shiftForceDisabledRef.current = false;
    eventsOnlyLateDriftGuardUntilRef.current = 0;
    eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
    // #region agent log
    const preShiftHandle = vlistRef.current;
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:loadOlder-pre-shift',message:'about to enable shift',data:{scrollOffset:preShiftHandle?.scrollOffset,scrollSize:preShiftHandle?.scrollSize,viewportSize:preShiftHandle?.viewportSize,cycleId,renderableCount},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
    const prePagContainer = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
    if (prePagContainer) {
      prePaginationDomGeoRef.current = { scrollTop: prePagContainer.scrollTop, scrollHeight: prePagContainer.scrollHeight };
    }
    // #endregion
    setShiftActive(true);
    topLoadTransactionActiveRef.current = true;
    pendingShiftReleaseRef.current = {
      cycleId,
      requestId,
      baselineRenderableCount: renderableCount,
      baselineFirstRenderableKey,
      completionReason: null,
      messagesAdded: 0,
      eventsAdded: 0,
      estimatedRenderableGrowth: null,
      loadFinished: false,
      releaseQueued: false,
      releaseAnchorOffset: null,
      releaseAnchorDistanceFromTop: null,
    };

    debugLog("ChatMessageList", "load-older-start", {
      cycleId,
      requestId,
      renderableCount,
      baselineFirstRenderableKey,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
    });

    try {
      const result = await onLoadOlderHistoryCurrent({ cycleId, requestId });
      const pending = pendingShiftReleaseRef.current;
      const isCurrentCyclePending =
        pending != null && pending.cycleId === cycleId && pending.requestId === requestId;

      if (isCurrentCyclePending && result) {
        pending.completionReason = result.completionReason ?? null;
        pending.messagesAdded = result.messagesAdded ?? 0;
        pending.eventsAdded = result.eventsAdded ?? 0;
        pending.estimatedRenderableGrowth = result.estimatedRenderableGrowth ?? null;
      }

      if (isCurrentCyclePending) {
        pending.loadFinished = true;

        const explicitNoGrowthResult = isExplicitNoGrowthResult({
          completionReason: pending.completionReason,
          estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
          messagesAdded: pending.messagesAdded,
          eventsAdded: pending.eventsAdded,
        });

        if (explicitNoGrowthResult) {
          pending.releaseQueued = true;
          requestAnimationFrame(() => {
            releaseShift("no-growth");
          });
        } else {
          const likelyNonPrependGrowth = pending.completionReason === "applied"
            && pending.messagesAdded <= 0
            && pending.eventsAdded > 0
            && pending.estimatedRenderableGrowth !== false;
          if (likelyNonPrependGrowth) {
            const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
            pending.releaseAnchorOffset = releaseAnchorOffset;
            pending.releaseAnchorDistanceFromTop = releaseAnchorOffset;
            pending.releaseQueued = true;
            debugLog("ChatMessageList", "load-older-preemptive-release", {
              cycleId,
              requestId,
              reason: "events-only-growth",
              completionReason: pending.completionReason,
              messagesAdded: pending.messagesAdded,
              eventsAdded: pending.eventsAdded,
              estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
              releaseAnchorOffset,
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
            });
            releaseShift("events-only-growth");
          }
        }
      }
    } catch (error) {
      debugLog("ChatMessageList", "load-older-error", {
        cycleId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      releaseShift("load-error");
      throw error;
    } finally {
      loadCycleInFlightRef.current = false;
      loadingOlderRef.current = false;
      const pending = pendingShiftReleaseRef.current;
      const isCurrentCyclePending =
        pending != null && pending.cycleId === cycleId && pending.requestId === requestId;
      if (isCurrentCyclePending) {
        if (shiftReleaseTimeoutRef.current != null) {
          window.clearTimeout(shiftReleaseTimeoutRef.current);
        }
        shiftReleaseTimeoutRef.current = window.setTimeout(() => {
          shiftReleaseTimeoutRef.current = null;
          releaseShift("timeout-fallback");
        }, 220);
      }
      debugLog("ChatMessageList", "load-older-finished", {
        cycleId,
        requestId,
        completionReason: pending?.completionReason ?? null,
        messagesAdded: pending?.messagesAdded ?? null,
        eventsAdded: pending?.eventsAdded ?? null,
        estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        stickyBottom: stickyBottomRef.current,
        topLoadTransactionActive: topLoadTransactionActiveRef.current,
      });
    }
  }, [readScrollSnapshot, releaseShift]);

  // Trigger load-older when user scrolls to top (oldest messages)
  useEffect(() => {
    if (!atTop) {
      if (
        Date.now() >= topLoadCooldownUntilRef.current
        && Date.now() >= topLoadPostReleaseCooldownUntilRef.current
        && topLoadRearmTimeoutRef.current == null
      ) {
        topLoadArmedRef.current = true;
      }
      return;
    }

    if (!leftTopZoneRef.current) return;
    if (!hasOlderHistoryRef.current || loadingOlderHistoryPropRef.current || !onLoadOlderHistoryRef.current) return;
    if (!topPaginationInteractionReadyRef.current) {
      debugLog("ChatMessageList", "top-load-skipped", {
        reason: "interaction-not-ready",
        atTop,
        hasOlderHistory: hasOlderHistoryRef.current,
        loadingOlderHistory: loadingOlderHistoryPropRef.current,
      });
      return;
    }
    if (loadCycleInFlightRef.current || !topLoadArmedRef.current) return;

    topLoadArmedRef.current = false;
    leftTopZoneRef.current = false;
    const triggeredAt = new Date();
    const triggeredAtIso = triggeredAt.toISOString();
    const triggeredAtDisplay = triggeredAt.toLocaleString();

    debugLog("ChatMessageList", "top-trigger-load-older", {
      trigger: "user-scroll-top",
      atTop,
      hasOlderHistory: hasOlderHistoryRef.current,
      loadingOlderHistory: loadingOlderHistoryPropRef.current,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
      triggeredAtIso,
      triggeredAtDisplay,
      ...readScrollSnapshot(),
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
    });

    void loadOlder();
  }, [atTop, loadOlder]);

  useEffect(() => {
    return () => {
      shiftForceDisabledRef.current = true;
      shiftDeactivateTokenRef.current += 1;
      if (shiftReleaseTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseTimeoutRef.current);
        shiftReleaseTimeoutRef.current = null;
      }
      if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
        shiftReleaseAnchorWatchTimeoutRef.current = null;
      }
      if (shiftReleaseAnchorWatchRafRef.current != null) {
        window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
        shiftReleaseAnchorWatchRafRef.current = null;
      }
      pendingShiftAnchorRestoreRef.current = null;
      topLoadPostReleaseCooldownUntilRef.current = 0;
      eventsOnlyLateDriftGuardUntilRef.current = 0;
      eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
      lastScrollGeometryRef.current = null;
      if (topLoadRearmTimeoutRef.current != null) {
        window.clearTimeout(topLoadRearmTimeoutRef.current);
        topLoadRearmTimeoutRef.current = null;
      }
    };
  }, []);

  function toggleRawOutput(messageId: string) {
    setRawOutputMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function copyOutput(messageId: string, content: string) {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }

    void navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);
    setTimeout(() => {
      setCopiedMessageId((current) => (current === messageId ? null : current));
    }, 1200);
  }

  async function copyDebugLog() {
    const copied = await copyRenderDebugLog();
    setCopiedDebug(copied);
    if (!copied) {
      return;
    }
    setTimeout(() => {
      setCopiedDebug(false);
    }, 1200);
  }

  const timelineCtx = useMemo<TimelineCtx>(
    () => ({
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      toggleRawOutput,
      copyOutput,
      copyDebugLog,
      onOpenReadFile,
      bashExpandedById,
      setBashExpandedById,
      editedExpandedById,
      setEditedExpandedById,
      exploreActivityExpandedById,
      setExploreActivityExpandedById,
      subagentExpandedById,
      setSubagentExpandedById,
      subagentPromptExpandedById,
      setSubagentPromptExpandedById,
      subagentExploreExpandedById,
      setSubagentExploreExpandedById,
      lastRenderSignatureByMessageIdRef,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      onOpenReadFile,
      bashExpandedById,
      editedExpandedById,
      exploreActivityExpandedById,
      subagentExpandedById,
      subagentPromptExpandedById,
      subagentExploreExpandedById,
    ],
  );

  const effectiveShiftActive = topLoadTransactionActiveRef.current
    || (shiftActive
      && !shiftForceDisabledRef.current
      && pendingShiftAnchorRestoreRef.current != null);

  return (
    <div
      ref={scrollWrapperRef}
      className="relative h-full min-h-0"
      data-testid="chat-scroll"
      onWheelCapture={markUserScrollIntent}
      onTouchStartCapture={markUserScrollIntent}
      onTouchMoveCapture={markUserScrollIntent}
      onPointerDownCapture={markUserScrollIntent}
    >
      {items.length === 0 && !showThinkingPlaceholder ? (
        <div className="py-10 text-center text-xs text-muted-foreground">No messages yet. Send a prompt to start.</div>
      ) : (
        <VList
          ref={vlistRef}
          shift={effectiveShiftActive}
          itemSize={50}
          style={{ height: "100%", overflowAnchor: "none" }}
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
        >
          {displayItems.map((item) => {
            if (item === "thinking-placeholder") {
              return (
                <div key="thinking-placeholder" className="mx-auto max-w-3xl px-3 pb-4">
                  <ThinkingPlaceholder />
                </div>
              );
            }
            return (
              <div key={getTimelineItemKey(item)} className="mx-auto max-w-3xl px-3 pb-4">
                <TimelineItem item={item} ctx={timelineCtx} />
              </div>
            );
          })}
        </VList>
      )}
    </div>
  );
}
