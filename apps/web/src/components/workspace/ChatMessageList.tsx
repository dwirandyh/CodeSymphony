import { useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { ChevronDown, ChevronRight, ChevronUp, Copy, Download, FileText, Folder } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import { cn } from "../../lib/utils";
import { copyRenderDebugLog, isRenderDebugEnabled, pushRenderDebug } from "../../lib/renderDebug";

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
  };

type ChatMessageListProps = {
  items: ChatTimelineItem[];
  showThinkingPlaceholder?: boolean;
  onOpenReadFile?: (path: string) => void | Promise<void>;
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
  const pattern = /\u001b\[([0-9;]*)m/g;
  let state: AnsiStyleState = {
    fgColor: null,
    bold: false,
    dim: false,
  };
  let cursor = 0;

  while (true) {
    const match = pattern.exec(input);
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
    cursor = pattern.lastIndex;
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

function TerminalOutputPre({ text, className }: { text: string; className: string }) {
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
}

function isLikelyDiff(code: string, language?: string): boolean {
  if (language === "diff") {
    return true;
  }

  return /^(diff --git .+|--- [^\r\n]+|\+\+\+ [^\r\n]+|@@ .+ @@)/m.test(code);
}

function hasUnclosedCodeFence(content: string): boolean {
  const fenceCount = (content.match(/(^|\n)```/g) ?? []).length;
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
  if (!/^`{3,}$/.test(closeFenceLine)) {
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

    if (/\s/.test(char)) {
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

type DiffLineKind = "addition" | "deletion" | "hunk" | "meta" | "context";

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }

  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }

  if (line.startsWith("+")) {
    return "addition";
  }

  if (line.startsWith("-")) {
    return "deletion";
  }

  return "context";
}

function diffLineClassName(kind: DiffLineKind): string {
  if (kind === "addition") {
    return "bg-emerald-500/10 text-emerald-300";
  }

  if (kind === "deletion") {
    return "bg-red-500/10 text-red-300";
  }

  if (kind === "hunk") {
    return "bg-sky-500/10 text-sky-300";
  }

  if (kind === "meta") {
    return "text-muted-foreground";
  }

  return "text-foreground";
}

type DiffLineNumber = {
  oldLine: number | null;
  newLine: number | null;
};

function computeDiffLineNumbers(lines: string[]): DiffLineNumber[] {
  const result: DiffLineNumber[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const kind = classifyDiffLine(line);

    if (kind === "hunk") {
      const match = /^@@ -(?<oldStart>\d+)(?:,\d+)? \+(?<newStart>\d+)(?:,\d+)? @@/.exec(line);
      if (match?.groups) {
        oldLine = Number(match.groups.oldStart);
        newLine = Number(match.groups.newStart);
      }
      result.push({ oldLine: null, newLine: null });
    } else if (kind === "meta") {
      result.push({ oldLine: null, newLine: null });
    } else if (kind === "addition") {
      result.push({ oldLine: null, newLine });
      newLine += 1;
    } else if (kind === "deletion") {
      result.push({ oldLine, newLine: null });
      oldLine += 1;
    } else {
      result.push({ oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
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
  const firstFile = changedFiles[0] ?? "file";
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

  if (diffKind !== "actual") {
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

type FileDiffSection = {
  fileName: string;
  additions: number;
  deletions: number;
  lines: string[];
};

function splitDiffByFile(diff: string): FileDiffSection[] {
  const sections: FileDiffSection[] = [];
  const rawLines = diff.split(/\r?\n/);
  let current: FileDiffSection | null = null;

  for (const line of rawLines) {
    if (line.startsWith("diff --git ")) {
      if (current) {
        sections.push(current);
      }
      const match = /diff --git a\/.+ b\/(.+)/.exec(line);
      const fileName = match ? match[1] : "unknown";
      current = { fileName, additions: 0, deletions: 0, lines: [line] };
      continue;
    }

    if (!current) {
      current = { fileName: "changes", additions: 0, deletions: 0, lines: [line] };
      continue;
    }

    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      current.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      current.deletions += 1;
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

export function MarkdownBody({
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
        components={{
          p: ({ children }) => <p className="mb-2 whitespace-pre-wrap leading-relaxed last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          h1: ({ children }) => <h1 className="mb-2 text-lg font-semibold last:mb-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 text-base font-semibold last:mb-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold last:mb-0">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l border-border/60 pl-3 text-muted-foreground">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto last:mb-0">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-border/50">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-border/30 last:border-b-0">{children}</tr>,
          th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,
          code: ({ className, children }) => {
            const language = className?.replace("language-", "").trim();
            const text = String(children).replace(/\n$/, "");
            const inline = !className && !text.includes("\n");

            if (inline) {
              return <code className="rounded bg-secondary/45 px-1 font-mono text-xs text-foreground">{text}</code>;
            }

            if (isLikelyDiff(text, language)) {
              return (
                <div className="my-2 rounded-lg border border-border/40 bg-secondary/20 p-3 last:mb-0">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                    Diff
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                    {text}
                  </pre>
                </div>
              );
            }

            return (
              <pre className="my-2 overflow-x-auto rounded-lg border border-border/40 bg-secondary/20 p-3 font-mono text-xs leading-relaxed text-foreground last:mb-0">
                <code>{text}</code>
              </pre>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function AssistantContent({
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
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {content}
        </pre>
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
}

type MentionSegment = { kind: "text"; value: string } | { kind: "mention"; path: string; name: string; isDirectory: boolean };

function parseUserMentions(content: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const mentionRegex = /@(file|dir):([\w./_-][\w./_-]*[\w._-])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: content.slice(lastIndex, match.index) });
    }

    const typeTag = match[1];
    const fullPath = match[2];
    const name = fullPath.split("/").pop() ?? fullPath;
    segments.push({ kind: "mention", path: fullPath, name, isDirectory: typeTag === "dir" });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ kind: "text", value: content.slice(lastIndex) });
  }

  return segments;
}

function UserMessageContent({ content }: { content: string }) {
  const segments = parseUserMentions(content);

  if (segments.length === 1 && segments[0].kind === "text") {
    return <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>;
  }

  return (
    <p className="whitespace-pre-wrap break-words leading-relaxed">
      {segments.map((seg, i) => {
        if (seg.kind === "text") {
          return <span key={i}>{seg.value}</span>;
        }

        return (
          <span
            key={i}
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
      })}
    </p>
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

function PlanInlineMessage({
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
}

export function ChatMessageList({ items, showThinkingPlaceholder = false, onOpenReadFile }: ChatMessageListProps) {
  const [rawOutputMessageIds, setRawOutputMessageIds] = useState<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [activityExpandedByMessageId, setActivityExpandedByMessageId] = useState<Map<string, boolean>>(new Map());
  const [bashExpandedById, setBashExpandedById] = useState<Map<string, boolean>>(new Map());
  const [editedExpandedById, setEditedExpandedById] = useState<Map<string, boolean>>(new Map());
  const [exploreActivityExpandedById, setExploreActivityExpandedById] = useState<Map<string, boolean>>(new Map());
  const lastRenderSignatureByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDebugEnabled = isRenderDebugEnabled();

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

  function isActivityExpanded(messageId: string, defaultExpanded: boolean): boolean {
    const explicit = activityExpandedByMessageId.get(messageId);
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return defaultExpanded;
  }

  function isBashExpanded(id: string, defaultExpanded: boolean): boolean {
    const explicit = bashExpandedById.get(id);
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return defaultExpanded;
  }

  function isEditedExpanded(id: string, defaultExpanded: boolean): boolean {
    const explicit = editedExpandedById.get(id);
    if (typeof explicit === "boolean") {
      return explicit;
    }
    return defaultExpanded;
  }

  function isExploreActivityExpanded(id: string): boolean {
    return exploreActivityExpandedById.get(id) === true;
  }

  return (
    <ScrollArea className="h-full" data-testid="chat-scroll">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pb-6 pt-3">
        {items.length === 0 && !showThinkingPlaceholder ? (
          <div className="py-10 text-center text-xs text-muted-foreground">No messages yet. Send a prompt to start.</div>
        ) : null}

        {items.map((item) => {
          if (item.kind === "plan-file-output") {
            return (
              <article key={`plan-file-${item.id}`} className="flex w-full justify-start" data-testid="timeline-plan-file-output">
                <div className="w-full px-1 text-sm text-foreground">
                  <PlanInlineMessage
                    id={item.id}
                    content={item.content}
                    filePath={item.filePath}
                    copied={copiedMessageId === item.id}
                    onCopy={() => copyOutput(item.id, item.content)}
                  />
                </div>
              </article>
            );
          }

          if (item.kind === "activity") {
            return null;
          }

          if (item.kind === "tool") {
            const changedFiles = getChangedFiles(item.event);
            const diffPreview = getDiffPreview(item.event);

            return (
              <article
                key={`tool-${item.event.id}`}
                className="rounded-md border border-border/30 bg-background/20 px-3 py-2 text-xs"
                data-testid={`timeline-${item.event.type}`}
              >
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="font-semibold text-foreground">{toolTitle(item.event)}</span>
                  <span>·</span>
                  <span>{toolSubtitle(item.event)}</span>
                </div>

                {changedFiles.length > 0 ? (
                  <div className="mt-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Files</div>
                    <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-foreground/90">
                      {changedFiles.map((file) => (
                        <li key={file}>{file}</li>
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
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                      {diffPreview}
                    </pre>
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
            const defaultExpanded = item.status === "failed";
            const expanded = isBashExpanded(item.id, defaultExpanded);
            const durationLabel = formatCompactDurationSeconds(item.durationSeconds);
            const shortCommandLabel = shortenCommandForSummary(item.command);
            const summaryPrefix = expanded ? "Ran commands" : shortCommandLabel ? `Ran ${shortCommandLabel}` : "Ran command";
            const summaryLabel = durationLabel ? `${summaryPrefix} for ${durationLabel}` : summaryPrefix;

            return (
              <article
                key={`bash-${item.id}`}
                className="px-1 text-xs"
                data-testid="timeline-bash-command"
              >
                <details
                  open={expanded}
                  onToggle={(event) => {
                    const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setBashExpandedById((current) => {
                      const next = new Map(current);
                      next.set(item.id, nextOpen);
                      return next;
                    });
                  }}
                >
                  <summary
                    className={cn(
                      "group/bash-summary inline-flex list-none cursor-pointer items-center gap-1 rounded-md text-[12px] transition-colors [&::-webkit-details-marker]:hidden",
                      expanded ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
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

                    <pre className="px-4 py-2.5 font-mono text-sm leading-relaxed text-foreground">
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
            const expanded = hasDiffContent ? isEditedExpanded(item.id, true) : false;
            const fileSections = hasDiffContent ? splitDiffByFile(item.diff) : [];
            // Prefer backend-changedFiles (delta per run). Fall back to diff
            // parsing for compatibility with older payloads.
            const diffFileNames = fileSections
              .map((s) => s.fileName)
              .filter((n) => n !== "changes" && n !== "unknown");
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

            if (!hasDiffContent && !item.diffTruncated) {
              return (
                <article
                  key={`edited-diff-${item.id}`}
                  className="px-1 text-xs"
                  data-testid="timeline-edited-diff"
                >
                  <div className="inline-flex items-center text-[12px] text-muted-foreground">
                    <span className="font-medium">{summaryLabel}</span>
                  </div>
                </article>
              );
            }

            return (
              <article
                key={`edited-diff-${item.id}`}
                className="px-1 text-xs"
                data-testid="timeline-edited-diff"
              >
                <details
                  open={expanded}
                  onToggle={(event) => {
                    const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setEditedExpandedById((current) => {
                      const next = new Map(current);
                      next.set(item.id, nextOpen);
                      return next;
                    });
                  }}
                >
                  <summary
                    className={cn(
                      "group/edited-summary inline-flex list-none cursor-pointer items-center gap-1 rounded-md text-[12px] transition-colors [&::-webkit-details-marker]:hidden",
                      expanded ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
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
                    {fileSections.map((section, sectionIndex) => (
                      <div key={`${item.id}:section:${sectionIndex}`}>
                        <div className="flex items-center gap-2 border-b border-border/25 px-3 py-1.5 text-xs">
                          <span className="font-semibold text-foreground">{section.fileName}</span>
                          <span className="text-muted-foreground">
                            <span className="text-emerald-400">+{section.additions}</span>
                            {" "}
                            <span className="text-red-400">-{section.deletions}</span>
                          </span>
                        </div>
                        <div className="max-h-72 overflow-auto font-mono text-xs leading-relaxed">
                          {(() => {
                            const lineNumbers = computeDiffLineNumbers(section.lines);
                            return section.lines.map((line, lineIndex) => {
                              const kind = classifyDiffLine(line);
                              if (kind === "meta") {
                                return null;
                              }
                              const ln = lineNumbers[lineIndex];
                              return (
                                <div
                                  key={`${item.id}:${sectionIndex}:line:${lineIndex}`}
                                  data-line-kind={kind}
                                  className={cn("flex whitespace-pre-wrap break-words", diffLineClassName(kind))}
                                >
                                  <span className="inline-block w-8 shrink-0 select-none text-right text-muted-foreground/40 pr-1">
                                    {ln?.oldLine ?? ""}
                                  </span>
                                  <span className="inline-block w-8 shrink-0 select-none text-right text-muted-foreground/40 pr-2">
                                    {ln?.newLine ?? ""}
                                  </span>
                                  <span className="flex-1 px-1">{line.length > 0 ? line : " "}</span>
                                </div>
                              );
                            });
                          })()}
                        </div>
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
                {entry.openPath && onOpenReadFile ? (
                  <button
                    type="button"
                    className="inline text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-2"
                    onClick={() => {
                      const openPath = entry.openPath;
                      if (!openPath) {
                        return;
                      }
                      void onOpenReadFile(openPath);
                    }}
                  >
                    {entry.label}
                  </button>
                ) : (
                  <span>{entry.label}</span>
                )}
              </span>
            );
            const expanded = isExploreActivityExpanded(item.id);
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
                key={`explore-activity-${item.id}`}
                className="px-1 text-xs"
                data-testid="timeline-explore-activity"
              >
                <details
                  open={expanded}
                  onToggle={(event) => {
                    const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setExploreActivityExpandedById((current) => {
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
                        ? <span key={`${item.id}:pending:${idx}`}>{entry.label}</span>
                        : entry.kind === "read"
                          ? renderReadLabel(entry, `${item.id}:${idx}`)
                          : <span key={`${item.id}:${idx}`}>{entry.label}</span>
                    ))}
                  </div>
                </details>
              </article>
            );
          }
          const message = item.message;
          const isRawOutputMode = message.role === "assistant" && rawOutputMessageIds.has(message.id);
          if (message.role === "assistant") {
            const signature = [
              isRawOutputMode ? "raw" : "beauty",
              item.renderHint ?? "none",
              item.isCompleted ? "done" : "stream",
              item.rawFileLanguage ?? "lang:none",
              `len:${message.content.length}`,
            ].join("|");
            const previousSignature = lastRenderSignatureByMessageIdRef.current.get(message.id);
            if (signature !== previousSignature) {
              lastRenderSignatureByMessageIdRef.current.set(message.id, signature);
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
              key={`message-${message.id}`}
              className={cn("flex w-full", message.role === "user" ? "justify-end" : "justify-start")}
              data-testid={`message-${message.role}`}
            >
              <div
                className={cn(
                  "max-w-[85%] text-sm",
                  message.role === "assistant" && "px-1 text-foreground",
                  message.role === "user" && "rounded-2xl bg-secondary/55 px-4 py-2.5 text-foreground",
                  message.role === "system" && "rounded-xl border border-border/40 px-3 py-2 text-muted-foreground",
                )}
              >
                {message.role === "assistant" ? (
                  <div className="space-y-2">
                    {renderDebugEnabled ? (
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <button
                          type="button"
                          aria-label="Copy output"
                          className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                          onClick={() => copyOutput(message.id, message.content)}
                        >
                          {copiedMessageId === message.id ? "Copied" : "Copy"}
                        </button>
                        <button
                          type="button"
                          aria-label="Toggle raw output"
                          className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                          onClick={() => toggleRawOutput(message.id)}
                        >
                          {isRawOutputMode ? "Beauty View" : "Raw Claude"}
                        </button>
                        <button
                          type="button"
                          aria-label="Copy render debug log"
                          className="rounded-md border border-border/50 px-2 py-0.5 transition-colors hover:text-foreground"
                          onClick={() => {
                            void copyDebugLog();
                          }}
                        >
                          {copiedDebug ? "Debug Copied" : "Copy Debug"}
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
                  <UserMessageContent content={message.content} />
                )}
              </div>
            </article>
          );
        })}

        {showThinkingPlaceholder ? (
          <article className="flex w-full justify-start" data-testid="thinking-placeholder">
            <div className="max-w-[85%] px-1 text-sm text-muted-foreground">
              <span className="thinking-shimmer font-medium">Thinking...</span>
            </div>
          </article>
        ) : null}
      </div>
    </ScrollArea>
  );
}
