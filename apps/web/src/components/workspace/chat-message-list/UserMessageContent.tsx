import { memo, useMemo, useState, useEffect, useRef, useCallback } from "react";
import type { ChatAttachment } from "@codesymphony/shared-types";
import { ChevronDown, ChevronUp, Copy, Download, FileText, Folder } from "lucide-react";
import { cn } from "../../../lib/utils";
import { parseUserMentions } from "../../../lib/mentions";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader } from "../../ui/card";
import { AttachmentBlock, InlineAttachmentChip } from "./AttachmentComponents";
import { MarkdownBody } from "./AssistantContent";
import { downloadTextFile } from "./toolEventUtils";

const ATTACHMENT_MARKER_RE = /\{\{attachment:([^}]+)\}\}/g;
const CURSOR_PLAN_FRONTMATTER_RE = /^(?:<!--[\s\S]*?-->\s*)?---\n([\s\S]*?)\n---\n*/;

type CursorPlanTodo = {
  content: string;
  status: string;
};

function isCursorPlanFilePath(filePath: string): boolean {
  return /(?:^|\/)\.cursor\/plans\/.+\.md$/i.test(filePath);
}

function parseYamlScalar(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, "\"")
      .replace(/\\'/g, "'")
      .replace(/\\n/g, "\n");
  }

  return trimmed;
}

function extractCursorPlanTodos(frontmatter: string): CursorPlanTodo[] {
  const todos: CursorPlanTodo[] = [];
  const lines = frontmatter.split("\n");
  let inTodos = false;
  let current: Partial<CursorPlanTodo> | null = null;

  const flushCurrent = () => {
    if (!current?.content) {
      current = null;
      return;
    }

    todos.push({
      content: current.content.trim(),
      status: (current.status ?? "pending").trim(),
    });
    current = null;
  };

  for (const line of lines) {
    if (!inTodos) {
      if (line.trim() === "todos:") {
        inTodos = true;
      }
      continue;
    }

    if (/^\S/.test(line)) {
      break;
    }

    if (/^\s*-\s+id:\s*/.test(line)) {
      flushCurrent();
      current = {};
      continue;
    }

    const contentMatch = /^\s+content:\s+(.+)\s*$/.exec(line);
    if (contentMatch) {
      current = current ?? {};
      current.content = parseYamlScalar(contentMatch[1]);
      continue;
    }

    const statusMatch = /^\s+status:\s+(.+)\s*$/.exec(line);
    if (statusMatch) {
      current = current ?? {};
      current.status = parseYamlScalar(statusMatch[1]);
    }
  }

  flushCurrent();
  return todos.filter((todo) => todo.content.length > 0);
}

function renderCursorPlanTodoMarkdown(todos: CursorPlanTodo[]): string {
  if (todos.length === 0) {
    return "";
  }

  return [
    "## Todo",
    ...todos.map((todo) => {
      const checked = todo.status.toLowerCase() === "completed" ? "x" : " ";
      const suffix = todo.status.toLowerCase() === "in_progress"
        ? " (in progress)"
        : todo.status.toLowerCase() === "cancelled"
          ? " (cancelled)"
          : "";
      return `- [${checked}] ${todo.content}${suffix}`;
    }),
  ].join("\n");
}

function normalizePlanInlineContent(filePath: string, content: string): string {
  if (!isCursorPlanFilePath(filePath)) {
    return content;
  }

  const frontmatterMatch = CURSOR_PLAN_FRONTMATTER_RE.exec(content);
  if (!frontmatterMatch) {
    return content;
  }

  const frontmatter = frontmatterMatch[1] ?? "";
  const body = content.slice(frontmatterMatch[0].length).trim();
  const todos = extractCursorPlanTodos(frontmatter);
  const todoMarkdown = renderCursorPlanTodoMarkdown(todos);

  if (!todoMarkdown) {
    return body || content;
  }

  if (!body) {
    return todoMarkdown;
  }

  return `${body}\n\n${todoMarkdown}`;
}

function renderMentionSegment(seg: ReturnType<typeof parseUserMentions>[number], key: number) {
  if (seg.kind === "text") {
    return <span key={key}>{seg.value}</span>;
  }

  if (seg.kind === "slash-command") {
    return (
      <span
        key={key}
        title={`${seg.trigger}${seg.name}`}
        className="inline-flex items-center rounded-md border border-blue-500/30 bg-blue-500/15 px-1.5 py-0 text-xs align-baseline text-blue-400"
      >
        <span className="max-w-[140px] truncate">{seg.trigger}{seg.name}</span>
      </span>
    );
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

export const UserMessageContent = memo(function UserMessageContent({ content, attachments }: { content: string; attachments?: ChatAttachment[] }) {
  const attachmentMap = useMemo(() => {
    const map = new Map<string, ChatAttachment>();
    if (attachments) {
      for (const att of attachments) map.set(att.id, att);
    }
    return map;
  }, [attachments]);

  const hasInlineMarkers = ATTACHMENT_MARKER_RE.test(content);
  ATTACHMENT_MARKER_RE.lastIndex = 0;

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

  const remainingAttachments = useMemo(
    () => (attachments ?? []).filter((att) => !inlineAttachmentIds.has(att.id)),
    [attachments, inlineAttachmentIds],
  );

  const clipboardTextAttachments = useMemo(
    () => remainingAttachments.filter((att) => att.source === "clipboard_text"),
    [remainingAttachments],
  );

  const blockAttachments = useMemo(
    () => remainingAttachments.filter((att) => att.source !== "clipboard_text"),
    [remainingAttachments],
  );

  const displayContent = useMemo(
    () => content.replace(ATTACHMENT_MARKER_RE, "").replace(/  +/g, " ").trim(),
    [content],
  );

  const renderContent = () => {
    if (!hasInlineMarkers) {
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

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let partKey = 0;

    while ((match = ATTACHMENT_MARKER_RE.exec(content)) !== null) {
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore) {
        const segments = parseUserMentions(textBefore);
        for (const seg of segments) {
          parts.push(renderMentionSegment(seg, partKey++));
        }
      }

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

    const remaining = content.slice(lastIndex);
    if (remaining) {
      const segments = parseUserMentions(remaining);
      for (const seg of segments) {
        parts.push(renderMentionSegment(seg, partKey++));
      }
    }

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
      <div className="space-y-1.5">
        {blockAttachments.map((att) => (
          <AttachmentBlock key={att.id} attachment={att} />
        ))}
      </div>
      {textContent}
    </div>
  );
});

export const PlanInlineMessage = memo(function PlanInlineMessage({
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
  onCopy: (content: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayContent = useMemo(() => normalizePlanInlineContent(filePath, content), [content, filePath]);
  const [canExpand, setCanExpand] = useState(displayContent.length > 900);
  const contentRef = useRef<HTMLDivElement>(null);
  const evaluateRafRef = useRef<number | null>(null);

  useEffect(() => {
    const contentEl = contentRef.current;
    const fallbackCanExpand = displayContent.length > 900;
    if (!contentEl) {
      setCanExpand((current) => (current === fallbackCanExpand ? current : fallbackCanExpand));
      return;
    }

    const evaluate = () => {
      const hasOverflow = contentEl.scrollHeight > contentEl.clientHeight + 4;
      const nextCanExpand = hasOverflow || fallbackCanExpand;
      setCanExpand((current) => (current === nextCanExpand ? current : nextCanExpand));
    };

    const scheduleEvaluate = () => {
      if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
        evaluate();
        return;
      }
      if (evaluateRafRef.current != null) {
        window.cancelAnimationFrame(evaluateRafRef.current);
      }
      evaluateRafRef.current = window.requestAnimationFrame(() => {
        evaluateRafRef.current = null;
        evaluate();
      });
    };

    evaluate();
    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (evaluateRafRef.current != null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(evaluateRafRef.current);
          evaluateRafRef.current = null;
        }
      };
    }

    const observer = new ResizeObserver(() => {
      scheduleEvaluate();
    });
    observer.observe(contentEl);

    return () => {
      if (evaluateRafRef.current != null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(evaluateRafRef.current);
        evaluateRafRef.current = null;
      }
      observer.disconnect();
    };
  }, [displayContent, expanded]);

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
            onClick={() => downloadTextFile(filePath.split("/").pop() ?? `plan-${id}.md`, displayContent)}
            aria-label="Download plan message"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:text-foreground"
            onClick={() => onCopy(displayContent)}
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
          <MarkdownBody content={displayContent} testId="assistant-render-plan-markdown" />
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
