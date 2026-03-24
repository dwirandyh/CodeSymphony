import { memo } from "react";
import { Bot, Brain, CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { cn } from "../../../lib/utils";
import { isExploreLikeBashCommand } from "../../../pages/workspace/eventUtils";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { pushRenderDebug } from "../../../lib/renderDebug";
import type { ChatTimelineItem, TimelineCtx } from "./ChatMessageList.types";
import { TerminalOutputPre } from "./ansiUtils";
import { SafePatchDiff } from "./diffUtils";
import {
  toolTitle,
  toolSubtitle,
  formatCompactDurationSeconds,
  shortenCommandForSummary,
  getChangedFiles,
  getDiffPreview,
  editedSummaryLabel,
} from "./toolEventUtils";
import { AssistantContent, MarkdownBody } from "./AssistantContent";
import { UserMessageContent, PlanInlineMessage } from "./UserMessageContent";

export const ThinkingPlaceholder = memo(function ThinkingPlaceholder() {
  return (
    <article className="flex w-full justify-start" data-testid="thinking-placeholder">
      <div className="max-w-[85%] px-1 text-sm text-muted-foreground">
        <span className="thinking-shimmer font-medium">Thinking...</span>
      </div>
    </article>
  );
});

export const TimelineItem = memo(function TimelineItem({
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
    const primaryEvent = item.event;
    const sourceEvents = item.sourceEvents ?? (primaryEvent ? [primaryEvent] : []);
    const changedFiles = primaryEvent ? getChangedFiles(primaryEvent) : [];
    const diffPreview = primaryEvent ? getDiffPreview(primaryEvent) : null;
    const expanded = ctx.toolExpandedById.get(item.id) ?? false;
    const shortCommandLabel = shortenCommandForSummary(item.command ?? null);
    const durationLabel = formatCompactDurationSeconds(item.durationSeconds ?? null);
    const status = item.status
      ?? (item.rejectedByUser ? "failed" : primaryEvent?.type === "tool.started" ? "running" : "success");
    const isFailed = status === "failed" || item.rejectedByUser === true;
    const statusLabel = item.rejectedByUser
      ? "Rejected by user"
      : status === "failed"
        ? "Failed"
        : status === "running"
          ? "Running"
          : "Success";
    const isBashTool = item.shell === "bash" || item.toolName?.toLowerCase() === "bash";
    const title = isBashTool
      ? "Bash"
      : primaryEvent
        ? toolTitle(primaryEvent)
        : item.toolName ?? "Tool";
    const subtitle = isBashTool
      ? item.summary
        ?? shortCommandLabel
        ?? item.command
        ?? "Command activity"
      : primaryEvent
        ? toolSubtitle(primaryEvent)
        : item.summary
          ?? shortCommandLabel
          ?? item.command
          ?? "Tool activity";
    const summaryPrefix = item.command
      ? expanded
        ? "Ran commands"
        : shortCommandLabel
          ? `Ran ${shortCommandLabel}`
          : "Ran command"
      : `${title} · ${subtitle}`;
    const summaryLabel = item.command && durationLabel ? `${summaryPrefix} for ${durationLabel}` : summaryPrefix;

    return (
      <article className="px-1 text-xs" data-testid="timeline-tool">
        <details
          open={expanded}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            ctx.setToolExpandedById((current) => {
              const next = new Map(current);
              next.set(item.id, nextOpen);
              return next;
            });
          }}
        >
          <summary
            className={cn(
              "group/tool-summary inline-flex list-none cursor-pointer items-center gap-1 rounded-md text-[12px] transition-colors [&::-webkit-details-marker]:hidden",
              isFailed && !expanded
                ? "text-destructive"
                : expanded ? "text-muted-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {isFailed && !expanded ? <XCircle className="h-3.5 w-3.5 shrink-0" /> : null}
            <span className="font-medium">{summaryLabel}</span>
            <span
              className={cn(
                "inline-flex shrink-0 text-[11px] leading-none opacity-0 transition-[opacity,transform,color] group-hover/tool-summary:opacity-100",
                expanded
                  ? "rotate-90 text-muted-foreground"
                  : "text-muted-foreground group-hover/tool-summary:text-foreground",
              )}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </summary>

          <div className="mt-2 overflow-hidden rounded-2xl border border-border/35 bg-secondary/20">
            <div className="flex items-center justify-between gap-2 border-b border-border/25 px-3 py-2 text-xs text-muted-foreground">
              <div className="min-w-0">
                <div className="font-semibold text-foreground">{title}</div>
                <div className="truncate">{subtitle}</div>
              </div>
              <span
                className={cn(
                  "shrink-0 font-medium",
                  status === "failed"
                    ? "text-destructive"
                    : status === "running"
                      ? "text-muted-foreground"
                      : "text-foreground",
                )}
              >
                {statusLabel}
              </span>
            </div>

            {item.shell ? (
              <div className="px-3 pt-2 pb-1 text-xs font-semibold lowercase tracking-wide text-muted-foreground">
                {item.shell}
              </div>
            ) : null}

            {item.command ? (
              <pre className="px-4 py-2.5 overflow-x-auto whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">
                <span style={{ color: "#98c379" }}>$</span>
                <span> </span>
                <span style={{ color: "#61afef" }}>{item.command}</span>
              </pre>
            ) : null}

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

            {!item.command && !item.output && !item.error && item.summary ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">{item.summary}</div>
            ) : null}

            {item.truncated ? (
              <div className="mt-1 px-3 py-2 text-[11px] text-muted-foreground">... [output truncated]</div>
            ) : null}

            {changedFiles.length > 0 ? (
              <div className="border-t border-border/25 px-4 py-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Files</div>
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-foreground/90">
                  {changedFiles.map((file) => (
                    <li key={file} className="break-all">{file}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {diffPreview ? (
              <details className="border-t border-border/25 px-4 py-3" data-testid="timeline-tool-diff-preview">
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

            {sourceEvents.length > 0 ? (
              <details className="border-t border-border/25 px-4 py-3" data-testid="timeline-tool-payload-details">
                <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Raw payload
                </summary>
                <div className="mt-2 space-y-2">
                  {sourceEvents.map((sourceEvent) => (
                    <details key={sourceEvent.id} className="border-l border-border/50 pl-2 text-xs" open={sourceEvent.type === "chat.failed"}>
                      <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-foreground">
                        <span className="text-[10px] text-muted-foreground">#{sourceEvent.idx}</span>
                        <span>{isBashTool ? "Bash" : sourceEvent.type}</span>
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {JSON.stringify(sourceEvent.payload, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              </details>
            ) : null}
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
    const expanded = ctx.exploreActivityExpandedById.get(item.id) === true;
    const isRunning = item.status === "running";
    const entries = item.entries ?? [];

    if (entries.length === 0) {
      pushRenderDebug({
        source: "TimelineItem",
        event: "emptyExploreCardRendered",
        details: {
          id: item.id,
          status: item.status,
          fileCount: item.fileCount,
          searchCount: item.searchCount,
        },
      });
    }

    const summaryParts: string[] = [];
    if (item.fileCount > 0) {
      summaryParts.push(`${item.fileCount} file${item.fileCount !== 1 ? "s" : ""}`);
    }
    if (item.searchCount > 0) {
      summaryParts.push(`${item.searchCount} search${item.searchCount !== 1 ? "es" : ""}`);
    }

    const summaryPrefix = isRunning ? "Exploring" : "Explored";
    const summaryText = summaryParts.length > 0 ? `${summaryPrefix} ${summaryParts.join(", ")}` : summaryPrefix;

    return (
      <article
        className="px-1"
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
          <summary className="flex cursor-pointer items-center gap-1.5 select-none list-none text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
            <span>{summaryText}</span>
            <span className={cn("inline-flex shrink-0 transition-transform duration-150", expanded ? "rotate-90" : "")}>
              <ChevronRight className="h-3 w-3" />
            </span>
          </summary>

          <div
            className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground"
            data-testid="timeline-explore-activity-entries"
          >
            {entries.map((entry, idx) => (
              <span key={`${entry.kind}:${entry.orderIdx}:${idx}`}>
                {entry.kind === "read" ? (
                  <>
                    Read{" "}
                    {entry.openPath && ctx.onOpenReadFile ? (
                      <button
                        type="button"
                        className="inline text-muted-foreground transition-colors hover:text-foreground hover:underline underline-offset-2"
                        onClick={() => {
                          if (entry.openPath && ctx.onOpenReadFile) {
                            void ctx.onOpenReadFile(entry.openPath);
                          }
                        }}
                      >
                        {entry.label}
                      </button>
                    ) : (
                      <span>{entry.label}</span>
                    )}
                  </>
                ) : (
                  entry.label
                )}
              </span>
            ))}

            {entries.length === 0 ? null : null}
          </div>
        </details>
      </article>
    );
  }

  if (item.kind === "subagent-activity") {
    const expanded = ctx.subagentExpandedById.get(item.id) === true;
    const isRunning = item.status === "running";
    const steps = item.steps ?? [];

    if (steps.length > 0 && item.description.trim().length === 0) {
      pushRenderDebug({
        source: "TimelineItem",
        event: "subagentPromptMissingAtRender",
        details: {
          id: item.id,
          toolUseId: item.toolUseId,
          stepCount: steps.length,
          lastMessageLen: item.lastMessage?.length ?? 0,
        },
      });
    }

    const EXPLORE_TOOL_NAMES = new Set(["Read", "Grep", "Search", "Glob", "ListDir"]);
    const isExploreStep = (s: { toolName: string; label?: string }) => {
      if (EXPLORE_TOOL_NAMES.has(s.toolName)) return true;
      if (s.toolName.trim().toLowerCase() === "bash" && s.label) {
        const cmd = s.label.replace(/^Ran\s+/i, "").trim();
        return isExploreLikeBashCommand(cmd);
      }
      return false;
    };
    const readSteps = steps.filter(isExploreStep);
    const otherSteps = steps.filter((s) => !isExploreStep(s));
    const readCount = readSteps.filter((s) => s.toolName === "Read").length;
    const searchCount = readSteps.filter((s) => s.toolName !== "Read").length;
    const hasExploreSteps = readSteps.length > 0;

    const stepCount = steps.length;
    const durationText = item.durationSeconds != null ? `${item.durationSeconds}s` : "";
    const fallbackLastMessage = !item.lastMessage && !isRunning && steps.length > 0
      ? steps[steps.length - 1]?.label ?? null
      : null;
    const resolvedLastMessage = item.lastMessage ?? fallbackLastMessage;
    const statusParts = [
      stepCount > 0 ? `${stepCount} step${stepCount !== 1 ? "s" : ""}` : "",
      durationText,
    ].filter(Boolean).join(" · ");
    const statusText = isRunning
      ? `Running${statusParts ? ` · ${statusParts}` : ""}`
      : `Done${statusParts ? ` · ${statusParts}` : ""}`;

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
          <summary className="flex cursor-pointer items-center gap-1.5 select-none list-none text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className={cn("truncate", isRunning ? "thinking-shimmer" : "") }>
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

          <div className="mt-2 ml-1 rounded-xl border border-border/30 bg-secondary/5 overflow-hidden">
            <div className="flex flex-col gap-3 p-3">
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

              {resolvedLastMessage && (
                <div className="px-1 text-sm text-foreground">
                  <MarkdownBody content={resolvedLastMessage} testId="subagent-response-markdown" />
                </div>
              )}

            </div>

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
              {item.isStreaming ? "Thinking\u2026" : "Thought process"}
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
