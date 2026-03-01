import { useEffect, useRef, useState } from "react";
import type { ChatThread } from "@codesymphony/shared-types";
import { GitPullRequestArrow, Plus, X } from "lucide-react";
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
  createThreadDisabled?: boolean;
  closingThreadId: string | null;
  showReviewTab?: boolean;
  reviewTabActive?: boolean;
  onSelectThread: (threadId: string | null) => void;
  onCreateThread: () => void;
  onCloseThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onSelectReviewTab?: () => void;
  onCloseReviewTab?: () => void;
  runScriptRunning?: boolean;
  onToggleRunScript?: () => void;
};

function FilledPlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path fill="currentColor" d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function FilledPauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function WorkspaceHeader({
  selectedRepositoryName,
  selectedWorktreeLabel,
  worktreePath,
  threads,
  selectedThreadId,
  disabled,
  createThreadDisabled,
  closingThreadId,
  showReviewTab,
  reviewTabActive,
  onSelectThread,
  onCreateThread,
  onCloseThread,
  onRenameThread,
  onSelectReviewTab,
  onCloseReviewTab,
  runScriptRunning,
  onToggleRunScript,
}: WorkspaceHeaderProps) {
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingThreadId) {
      return;
    }

    if (!threads.some((thread) => thread.id === editingThreadId)) {
      setEditingThreadId(null);
    }
  }, [editingThreadId, threads]);

  useEffect(() => {
    if (!editingThreadId) {
      return;
    }

    const input = renameInputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  }, [editingThreadId]);

  function startThreadRename(threadId: string, isSelected: boolean) {
    if (!isSelected || disabled) {
      return;
    }

    setEditingThreadId(threadId);
  }

  function cancelThreadRename() {
    setEditingThreadId(null);
  }

  function saveThreadRename(threadId: string, currentTitle: string, rawTitle: string) {
    if (editingThreadId !== threadId) {
      return;
    }

    const nextTitle = rawTitle.trim();
    cancelThreadRename();

    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    void onRenameThread(threadId, nextTitle);
  }

  return (
    <section className="workspace-header space-y-1 pb-1 lg:space-y-1.5 lg:pb-2">
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
                <FilledPauseIcon className="h-3.5 w-3.5" />
              ) : (
                <FilledPlayIcon className="h-3.5 w-3.5" />
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
              const isEditing = editingThreadId === thread.id;

              return (
                <div
                  key={thread.id}
                  className={cn(
                    "group flex shrink-0 items-center border-b-2 border-b-transparent text-muted-foreground",
                    isSelected && "border-b-primary text-foreground",
                  )}
                >
                  {isEditing ? (
                    <input
                      ref={renameInputRef}
                      defaultValue={thread.title}
                      onBlur={(event) => saveThreadRename(thread.id, thread.title, event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          saveThreadRename(thread.id, thread.title, event.currentTarget.value);
                          return;
                        }

                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelThreadRename();
                        }
                      }}
                      aria-label="Rename thread title"
                      className="w-[180px] rounded-sm border border-border bg-background px-2 py-1 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : (
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
                      onDoubleClick={() => startThreadRename(thread.id, isSelected)}
                      disabled={disabled}
                    >
                      {thread.title}
                    </button>
                  )}

                  <button
                    type="button"
                    aria-label={`Close session ${thread.title}`}
                    title={`Close ${thread.title}`}
                    className={cn(
                      "rounded-sm p-1 text-muted-foreground transition-opacity hover:text-destructive disabled:opacity-50",
                      isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    onClick={() => onCloseThread(thread.id)}
                    disabled={disabled || isClosing || isEditing}
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
          disabled={createThreadDisabled ?? disabled}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onCreateThread}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </section>
  );
}
