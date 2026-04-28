import { useEffect, useRef, useState } from "react";
import type { ChatThread } from "@codesymphony/shared-types";
import {
  ChevronDown,
  ChevronRight,
  Dot,
  GitBranch,
  GitPullRequestArrow,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  X,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { OpenInAppButton } from "./OpenInAppButton";

export type WorkspaceFileTab = {
  path: string;
  dirty: boolean;
  pinned: boolean;
};

function fileTabLabel(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

type WorkspaceHeaderProps = {
  desktopApp?: boolean;
  selectedWorktreeBranch: string | null;
  selectedIsRootWorkspace?: boolean;
  targetBranch?: string | null;
  targetBranchOptions?: string[];
  targetBranchLoading?: boolean;
  targetBranchDisabled?: boolean;
  worktreePath: string | null;
  threads: ChatThread[];
  selectedThreadId: string | null;
  fileTabs: WorkspaceFileTab[];
  activeFilePath: string | null;
  disabled: boolean;
  createThreadDisabled?: boolean;
  closingThreadId: string | null;
  protectedThreadId?: string | null;
  showReviewTab?: boolean;
  reviewTabActive?: boolean;
  onSelectThread: (threadId: string | null) => void;
  onPrefetchThread?: (threadId: string) => void;
  onSelectFileTab: (path: string) => void;
  onPinFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onCreateThread: () => void;
  onCloseThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onSelectTargetBranch?: (branch: string) => void;
  onSelectReviewTab?: () => void;
  onCloseReviewTab?: () => void;
  runScriptRunning?: boolean;
  onToggleRunScript?: () => void;
  leftPanelVisible?: boolean;
  onToggleLeftPanel?: () => void;
  mergeWithContent?: boolean;
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
  desktopApp = false,
  selectedWorktreeBranch,
  selectedIsRootWorkspace = false,
  targetBranch,
  targetBranchOptions = [],
  targetBranchLoading = false,
  targetBranchDisabled = false,
  worktreePath,
  threads,
  selectedThreadId,
  fileTabs,
  activeFilePath,
  disabled,
  createThreadDisabled,
  closingThreadId,
  protectedThreadId,
  showReviewTab,
  reviewTabActive,
  onSelectThread,
  onPrefetchThread,
  onSelectFileTab,
  onPinFileTab,
  onCloseFileTab,
  onCreateThread,
  onCloseThread,
  onRenameThread,
  onSelectTargetBranch,
  onSelectReviewTab,
  onCloseReviewTab,
  runScriptRunning,
  onToggleRunScript,
  leftPanelVisible = true,
  onToggleLeftPanel,
}: WorkspaceHeaderProps) {
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [targetBranchSelectorOpen, setTargetBranchSelectorOpen] = useState(false);
  const [targetBranchFilter, setTargetBranchFilter] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const targetBranchFilterInputRef = useRef<HTMLInputElement | null>(null);

  const branchContextLabel = selectedWorktreeBranch
    ?? (selectedIsRootWorkspace ? "Root worktree" : "Worktree");
  const branchContextTitle = selectedIsRootWorkspace
    ? selectedWorktreeBranch
      ? `Current branch: ${selectedWorktreeBranch} (root worktree)`
      : "Root worktree"
    : selectedWorktreeBranch
      ? `Current branch: ${selectedWorktreeBranch}`
      : "Worktree";
  const targetBranchLabel = targetBranch ? `origin/${targetBranch}` : "Select target branch";
  const canChooseTargetBranch = !!onSelectTargetBranch && (targetBranchOptions.length > 0 || targetBranchLoading);
  const normalizedTargetBranchFilter = targetBranchFilter.trim().toLowerCase();
  const filteredTargetBranchOptions = normalizedTargetBranchFilter
    ? targetBranchOptions.filter((branchOption) => branchOption.toLowerCase().includes(normalizedTargetBranchFilter))
    : targetBranchOptions;

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

  useEffect(() => {
    if (!targetBranchSelectorOpen) {
      setTargetBranchFilter("");
      return;
    }

    const timeoutId = window.setTimeout(() => {
      targetBranchFilterInputRef.current?.focus();
      targetBranchFilterInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [targetBranchSelectorOpen]);

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
    <section className={cn(
      "workspace-header space-y-1 lg:space-y-1.5",
    )}>
      <div className={cn("items-center justify-between gap-3", desktopApp ? "flex" : "hidden lg:flex")} data-testid="workspace-header-desktop-bar">
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5">
          {onToggleLeftPanel ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={leftPanelVisible ? "Hide left panel" : "Show left panel"}
              title={leftPanelVisible ? "Hide left panel" : "Show left panel"}
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onToggleLeftPanel}
            >
              {leftPanelVisible ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
            </Button>
          ) : null}

          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
          <span
            className="min-w-0 truncate font-medium text-foreground/90"
            title={branchContextTitle}
            data-testid="workspace-header-context"
          >
            {branchContextLabel}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          {canChooseTargetBranch ? (
            <Popover open={targetBranchSelectorOpen} onOpenChange={setTargetBranchSelectorOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 min-w-0 shrink-0 gap-1 rounded-md px-2 text-[12px] font-medium text-foreground/80 hover:bg-secondary/40 hover:text-foreground"
                  aria-label="Select target branch"
                  title={targetBranchLoading ? "Loading branches" : `Target branch: ${targetBranchLabel}`}
                  disabled={targetBranchDisabled}
                  data-testid="workspace-target-branch-trigger"
                >
                  {targetBranchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  <span className="truncate">{targetBranchLabel}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={8}
                className="w-[236px] rounded-lg border-border/60 bg-popover/95 p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.16)]"
              >
                <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/85">
                  Target branch
                </div>
                <Input
                  ref={targetBranchFilterInputRef}
                  value={targetBranchFilter}
                  onChange={(event) => setTargetBranchFilter(event.target.value)}
                  placeholder="Filter branches..."
                  className="mb-1.5 h-7 border-border/60 px-2 text-[11px] focus-visible:border-border/60 focus-visible:ring-0 focus-visible:ring-offset-0"
                  aria-label="Filter target branches"
                  data-testid="workspace-target-branch-filter"
                />
                <ScrollArea className="max-h-48">
                  <div className="space-y-0.5 pr-0.5">
                    {filteredTargetBranchOptions.length > 0 ? filteredTargetBranchOptions.map((branchOption) => {
                      const selected = branchOption === targetBranch;
                      return (
                        <button
                          key={branchOption}
                          type="button"
                          className={cn(
                            "flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                            selected
                              ? "bg-secondary/70 text-foreground"
                              : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                          )}
                          onClick={() => {
                            if (!onSelectTargetBranch || branchOption === targetBranch) {
                              setTargetBranchSelectorOpen(false);
                              return;
                            }
                            onSelectTargetBranch(branchOption);
                            setTargetBranchSelectorOpen(false);
                          }}
                          data-testid={`workspace-target-branch-option-${branchOption}`}
                        >
                          <span className="truncate">{`origin/${branchOption}`}</span>
                          {selected ? <span className="ml-2 shrink-0 text-[9px] uppercase tracking-[0.08em] text-foreground/65">Current</span> : null}
                        </button>
                      );
                    }) : (
                      <div
                        className="px-2 py-2 text-[11px] text-muted-foreground"
                        data-testid="workspace-target-branch-empty"
                      >
                        No branches found
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
          ) : (
            <span
              className="truncate text-[12px] font-medium text-foreground/80"
              title={`Target branch: ${targetBranchLabel}`}
              data-testid="workspace-target-branch-label"
            >
              {targetBranchLabel}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {worktreePath && (
            <OpenInAppButton key={worktreePath} targetPath={worktreePath} />
          )}

          {onToggleRunScript && (
            <Button
              type="button"
              variant="secondary"
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
        <div
          className={cn(
            "min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-color:hsl(var(--border))_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-[3px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/60 hover:[&::-webkit-scrollbar-thumb]:bg-border/80",
          )}
          role="tablist"
          aria-label="Sessions"
          data-testid="session-tabs-scroll"
        >
          <div className="flex w-max min-w-full items-center gap-0.5 whitespace-nowrap">
            {threads.map((thread) => {
              const isSelected = thread.id === selectedThreadId && !reviewTabActive && !activeFilePath;
              const isAnyThreadClosing = closingThreadId !== null;
              const isProtected = protectedThreadId === thread.id;
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
                      onPointerEnter={() => onPrefetchThread?.(thread.id)}
                      onFocus={() => onPrefetchThread?.(thread.id)}
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
                      isSelected ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                    )}
                    onClick={() => onCloseThread(thread.id)}
                    disabled={disabled || isAnyThreadClosing || isEditing || isProtected}
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

            {fileTabs.map((fileTab) => {
              const label = fileTabLabel(fileTab.path);
              const isSelected = activeFilePath === fileTab.path;

              return (
                <div
                  key={fileTab.path}
                  className={cn(
                    "group flex shrink-0 items-center border-b-2 border-b-transparent text-muted-foreground",
                    isSelected && "border-b-primary text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    title={fileTab.path}
                    className={cn(
                      "max-w-[180px] truncate px-2 py-1.5 text-xs font-medium transition-colors",
                      !fileTab.pinned && "italic text-muted-foreground/90",
                      isSelected && "text-foreground",
                    )}
                    onClick={() => onSelectFileTab(fileTab.path)}
                    onDoubleClick={() => onPinFileTab(fileTab.path)}
                    disabled={disabled}
                  >
                    <span>{label}</span>
                    {fileTab.dirty ? <Dot className="ml-1 inline h-4 w-4 align-middle text-amber-500" /> : null}
                  </button>

                  <button
                    type="button"
                    aria-label={`Close file ${label}`}
                    title={`Close ${label}`}
                    className={cn(
                      "rounded-sm p-1 text-muted-foreground transition-opacity hover:text-destructive",
                      isSelected ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                    )}
                    onClick={() => onCloseFileTab(fileTab.path)}
                    disabled={disabled}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
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
