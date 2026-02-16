import { useRef, useState } from "react";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import { Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { copyRenderDebugLog, isRenderDebugEnabled, pushRenderDebug } from "../../lib/renderDebug";

export type AssistantRenderHint = "markdown" | "raw-file" | "raw-fallback" | "diff";

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
    };

type ChatMessageListProps = {
  items: ChatTimelineItem[];
  showThinkingPlaceholder?: boolean;
};

function isLikelyDiff(code: string, language?: string): boolean {
  if (language === "diff") {
    return true;
  }

  return /^(diff --git|---\s|\+\+\+\s|@@\s)/m.test(code);
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
    return "tool.started";
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
    return String(event.payload.toolName ?? "Tool started");
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

function MarkdownBody({
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

export function ChatMessageList({ items, showThinkingPlaceholder = false }: ChatMessageListProps) {
  const [rawOutputMessageIds, setRawOutputMessageIds] = useState<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [activityExpandedByMessageId, setActivityExpandedByMessageId] = useState<Map<string, boolean>>(new Map());
  const [bashExpandedById, setBashExpandedById] = useState<Map<string, boolean>>(new Map());
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

  return (
    <ScrollArea className="h-full" data-testid="chat-scroll">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 pb-6 pt-3">
        {items.length === 0 && !showThinkingPlaceholder ? (
          <div className="py-10 text-center text-xs text-muted-foreground">No messages yet. Send a prompt to start.</div>
        ) : null}

        {items.map((item) => {
          if (item.kind === "activity") {
            const expanded = isActivityExpanded(item.messageId, item.defaultExpanded);
            return (
              <article
                key={`activity-${item.messageId}`}
                className="rounded-md border border-border/30 bg-background/20 px-3 py-2 text-xs"
                data-testid="timeline-activity"
              >
                <details
                  open={expanded}
                  onToggle={(event) => {
                    const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setActivityExpandedByMessageId((current) => {
                      const next = new Map(current);
                      next.set(item.messageId, nextOpen);
                      return next;
                    });
                  }}
                >
                  <summary className="cursor-pointer text-[12px] text-muted-foreground">
                    <span className="font-semibold text-foreground">Activity for {item.durationSeconds}s</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                    {item.introText ? <p className="text-[12px] text-foreground/90">{item.introText}</p> : null}
                    {item.steps.length > 0 ? (
                      <ul className="space-y-1.5">
                        {item.steps.map((step) => (
                          <li key={step.id} className="rounded-md border border-border/35 bg-secondary/20 px-2.5 py-1.5">
                            <div className="font-medium text-foreground">{step.label}</div>
                            <div className="text-muted-foreground">{step.detail}</div>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </details>
              </article>
            );
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
                  <div className="mt-2 rounded-md border border-border/40 bg-secondary/20 p-2.5">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Diff Preview
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                      {diffPreview}
                    </pre>
                  </div>
                ) : null}
              </article>
            );
          }

          if (item.kind === "bash-command") {
            const commandText = item.command ?? item.summary ?? "command";
            const statusLabel = item.status === "failed" ? "Failed" : item.status === "running" ? "Running" : "Success";
            const defaultExpanded = item.status === "running";
            const expanded = isBashExpanded(item.id, defaultExpanded);
            const summaryLabel = expanded ? "Ran command" : item.command ? `Ran ${item.command}` : "Ran command";

            return (
              <article
                key={`bash-${item.id}`}
                className="text-xs"
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
                  <summary className="cursor-pointer text-[12px] text-muted-foreground">
                    <span className="font-semibold text-foreground">{summaryLabel}</span>
                  </summary>

                  <div className="mt-2 overflow-hidden rounded-2xl border border-border/35 bg-secondary/20">
                    <div className="border-b border-border/35 px-3 py-2 text-xs font-semibold lowercase tracking-wide text-muted-foreground">
                      {item.shell}
                    </div>

                    <pre className="border-b border-border/35 px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
                      {`$ ${commandText}`}
                    </pre>

                    {item.output ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-relaxed text-foreground">
                        {item.output}
                      </pre>
                    ) : null}

                    {item.error ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-border/35 px-4 py-3 font-mono text-sm leading-relaxed text-destructive">
                        {item.error}
                      </pre>
                    ) : null}

                    {!item.output && !item.error && item.summary ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">{item.summary}</div>
                    ) : null}

                    {item.truncated ? (
                      <div className="border-t border-border/35 px-3 py-2 text-[11px] text-muted-foreground">... [output truncated]</div>
                    ) : null}

                    <div className="border-t border-border/35 px-3 py-2 text-right text-xs">
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
                      {renderDebugEnabled ? (
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
                      ) : null}
                    </div>

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
                  <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
                )}
              </div>
            </article>
          );
        })}

        {showThinkingPlaceholder ? (
          <article className="flex w-full justify-start" data-testid="thinking-placeholder">
            <div className="max-w-[85%] px-1 text-sm text-foreground">
              <div className="rounded-xl border border-border/35 bg-secondary/20 px-3 py-2.5">
                <span className="thinking-shimmer font-medium">Thinking...</span>
              </div>
            </div>
          </article>
        ) : null}
      </div>
    </ScrollArea>
  );
}
