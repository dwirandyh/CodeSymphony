import type { ChatThread } from "@codesymphony/shared-types";
import { GitPullRequestArrow, Play, Plus, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { OpenInAppButton } from "./OpenInAppButton";

type WorkspaceHeaderProps = {
  selectedRepositoryName: string;
  selectedWorktreeLabel: string;
  worktreePath: string | null;
  threads: ChatThread[];
  selectedThreadId: string | null;
  disabled: boolean;
  closingThreadId: string | null;
  showReviewTab?: boolean;
  reviewTabActive?: boolean;
  onSelectThread: (threadId: string | null) => void;
  onCreateThread: () => void;
  onCloseThread: (threadId: string) => void;
  onSelectReviewTab?: () => void;
  onCloseReviewTab?: () => void;
  runScriptRunning?: boolean;
  onToggleRunScript?: () => void;
};

export function WorkspaceHeader({
  selectedRepositoryName,
  selectedWorktreeLabel,
  worktreePath,
  threads,
  selectedThreadId,
  disabled,
  closingThreadId,
  showReviewTab,
  reviewTabActive,
  onSelectThread,
  onCreateThread,
  onCloseThread,
  onSelectReviewTab,
  onCloseReviewTab,
  runScriptRunning,
  onToggleRunScript,
}: WorkspaceHeaderProps) {
  return (
    <section className="space-y-1 pb-1 lg:space-y-1.5 lg:pb-2">
      <div className="hidden items-center justify-between gap-3 lg:flex">
        <div className="min-w-0 truncate text-[11px]">
          <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground">Session</span>
          <span className="px-1.5 text-muted-foreground/80">·</span>
          <span className="font-semibold text-foreground/90">{selectedRepositoryName}</span>
          <span className="px-1.5 text-muted-foreground/80">·</span>
          <span className="text-muted-foreground">{selectedWorktreeLabel}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {worktreePath && (
            <OpenInAppButton targetPath={worktreePath} />
          )}

          {onToggleRunScript && (
            <Button
              type="button"
              variant={runScriptRunning ? "ghost" : "secondary"}
              size="icon"
              disabled={disabled}
              aria-label={runScriptRunning ? "Stop script" : "Run script"}
              title={runScriptRunning ? "Stop script" : "Run script"}
              className="h-9 w-9 shrink-0"
              onClick={onToggleRunScript}
            >
              {runScriptRunning ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="Sessions" data-testid="session-tabs-scroll">
          <div className="flex w-max min-w-full items-center gap-0.5 whitespace-nowrap">
            {threads.map((thread) => {
              const isSelected = thread.id === selectedThreadId && !reviewTabActive;
              const isClosing = closingThreadId === thread.id;

              return (
                <div
                  key={thread.id}
                  className={cn(
                    "group flex shrink-0 items-center border-b-2 border-b-transparent text-muted-foreground",
                    isSelected && "border-b-primary text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    title={thread.title}
                    className={cn(
                      "max-w-[180px] truncate px-2 py-1.5 text-xs font-medium transition-colors",
                      isSelected && "text-foreground",
                    )}
                    onClick={() => onSelectThread(thread.id)}
                    disabled={disabled}
                  >
                    {thread.title}
                  </button>

                  <button
                    type="button"
                    aria-label={`Close session ${thread.title}`}
                    title={`Close ${thread.title}`}
                    className={cn(
                      "rounded-sm p-1 text-muted-foreground transition-opacity hover:text-destructive disabled:opacity-50",
                      isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    onClick={() => onCloseThread(thread.id)}
                    disabled={disabled || isClosing}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}

            {/* Review Changes tab */}
            {showReviewTab && (
              <div
                className={cn(
                  "group flex shrink-0 items-center border-b-2 border-b-transparent text-muted-foreground",
                  reviewTabActive && "border-b-primary text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={reviewTabActive}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium transition-colors",
                    reviewTabActive && "text-foreground",
                  )}
                  onClick={onSelectReviewTab}
                >
                  <GitPullRequestArrow className="h-3 w-3" />
                  Review Changes
                </button>
                <button
                  type="button"
                  aria-label="Close review tab"
                  title="Close review"
                  className={cn(
                    "rounded-sm p-1 text-muted-foreground transition-opacity hover:text-destructive",
                    reviewTabActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                  onClick={onCloseReviewTab}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Add session"
          title="Add session"
          disabled={disabled}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onCreateThread}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}
