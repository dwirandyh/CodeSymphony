import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatThread } from "@codesymphony/shared-types";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { debugLog } from "../../lib/debugLog";
import {
  logWorkspaceUiIssueReportSignal,
  probeSingleHeaderTabAlignment,
  scheduleWorkspaceUiGeometryProbe,
} from "../../lib/workspaceUiDiagnose";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import { AgentIcon } from "./composer/AgentModelSelector";
import { OpenInAppButton } from "./OpenInAppButton";
import { CreateSessionButton } from "./CreateSessionButton";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip";
import type { TabItem } from "../../pages/workspace/editorGroups";

export type WorkspaceFileTab = {
  path: string;
  dirty: boolean;
  pinned: boolean;
};

export type WorkspaceTerminalTab = {
  id: string;
  title: string;
  sessionId: string;
};

type WorkspaceHeaderProps = {
  desktopApp?: boolean;
  selectedWorktreeBranch: string | null;
  selectedIsRootWorkspace?: boolean;
  targetBranch?: string | null;
  targetBranchOptions?: string[];
  targetBranchLoading?: boolean;
  targetBranchDisabled?: boolean;
  enableInstalledAppsQuery?: boolean;
  worktreePath: string | null;
  threads: ChatThread[];
  closedThreads?: ChatThread[];
  terminalTabs?: WorkspaceTerminalTab[];
  activeTerminalTabId?: string | null;
  terminalTabActive?: boolean;
  selectedThreadId: string | null;
  selectedThreadFallbackTitle?: string | null;
  fileTabs: WorkspaceFileTab[];
  activeFilePath: string | null;
  disabled: boolean;
  createThreadDisabled?: boolean;
  createTerminalDisabled?: boolean;
  closingThreadId: string | null;
  protectedThreadId?: string | null;
  showReviewTab?: boolean;
  reviewTabActive?: boolean;
  onSelectThread: (threadId: string | null) => void;
  onSelectTerminalTab?: (terminalTabId: string) => void;
  onPrefetchThread?: (threadId: string) => void;
  onSelectFileTab: (path: string) => void;
  onPinFileTab: (path: string) => void;
  onCloseFileTab: (path: string) => void;
  onCreateThread: () => void;
  onCreateTerminal?: () => void;
  onCloseThread: (threadId: string) => void;
  onReopenThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onCloseTerminalTab?: (terminalTabId: string) => void;
  onRenameTerminalTab?: (terminalTabId: string, title: string) => Promise<void> | void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onSelectTargetBranch?: (branch: string) => void;
  onSelectReviewTab?: () => void;
  onCloseReviewTab?: () => void;
  runScriptRunning?: boolean;
  onToggleRunScript?: () => void;
  leftPanelVisible?: boolean;
  onToggleLeftPanel?: () => void;
  mergeWithContent?: boolean;
  resourceMonitor?: ReactNode;
  /** When provided (split mode), replaces the single default strip with caller-supplied per-pane strips while keeping the add + history controls in the same row. */
  splitTabStrips?: ReactNode;
  /** When provided, drives the visible tab order (e.g. from the active editor group) instead of the legacy section order. */
  orderedTabs?: TabItem[];
  /** Reorder a tab within the header row; enables in-row drag reordering when provided. */
  onReorderTab?: (tabId: string, toIndex: number) => void;
  onTabDragStart?: () => void;
  onTabDragEnd?: () => void;
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
  enableInstalledAppsQuery = true,
  worktreePath,
  threads,
  closedThreads = [],
  terminalTabs = [],
  activeTerminalTabId = null,
  terminalTabActive = false,
  selectedThreadId,
  selectedThreadFallbackTitle,
  fileTabs,
  activeFilePath,
  disabled,
  createThreadDisabled,
  createTerminalDisabled,
  closingThreadId,
  protectedThreadId,
  showReviewTab,
  reviewTabActive,
  onSelectThread,
  onSelectTerminalTab,
  onPrefetchThread,
  onSelectFileTab,
  onPinFileTab,
  onCloseFileTab,
  onCreateThread,
  onCreateTerminal,
  onCloseThread,
  onReopenThread,
  onCloseTerminalTab,
  onRenameTerminalTab,
  onRenameThread,
  onSelectTargetBranch,
  onSelectReviewTab,
  onCloseReviewTab,
  runScriptRunning,
  onToggleRunScript,
  leftPanelVisible = true,
  onToggleLeftPanel,
  resourceMonitor,
  splitTabStrips,
  orderedTabs,
  onReorderTab,
  onTabDragStart,
  onTabDragEnd,
  mergeWithContent = false,
}: WorkspaceHeaderProps) {
  const [targetBranchSelectorOpen, setTargetBranchSelectorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [targetBranchFilter, setTargetBranchFilter] = useState("");
  const targetBranchFilterInputRef = useRef<HTMLInputElement | null>(null);
  const lastLoggedTabStateRef = useRef<string | null>(null);

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
  const canChooseTargetBranch = !!onSelectTargetBranch;
  const normalizedTargetBranchFilter = targetBranchFilter.trim().toLowerCase();
  const filteredTargetBranchOptions = normalizedTargetBranchFilter
    ? targetBranchOptions.filter((branchOption) => branchOption.toLowerCase().includes(normalizedTargetBranchFilter))
    : targetBranchOptions;
  const selectedThreadMissingFromTabs =
    splitTabStrips == null
    && !!selectedThreadId
    && !threads.some((thread) => thread.id === selectedThreadId);
  const pendingThread = selectedThreadMissingFromTabs && selectedThreadId
    ? { id: selectedThreadId, title: selectedThreadFallbackTitle || "Loading thread..." }
    : null;

  // The currently active tab id, derived from the selection-style props.
  const activeTabId: string | null = reviewTabActive
    ? "review"
    : activeFilePath
      ? activeFilePath
      : terminalTabActive
        ? activeTerminalTabId
        : selectedThreadId;

  // Build the ordered tab list. When `orderedTabs` is provided (driven by the active
  // editor group) we use it verbatim; otherwise we fall back to the legacy section
  // order: threads -> terminals -> review -> files.
  const fallbackTabs: TabItem[] = [
    ...threads.map((thread): TabItem => ({ type: "chat", id: thread.id })),
    ...(pendingThread ? [{ type: "chat", id: pendingThread.id } as TabItem] : []),
    ...terminalTabs.map((tab): TabItem => ({ type: "terminal", id: tab.id })),
    ...(showReviewTab ? [{ type: "review", id: "review" } as TabItem] : []),
    ...fileTabs.map((tab): TabItem => ({ type: "file", id: tab.path })),
  ];
  const stripTabs = orderedTabs != null && orderedTabs.length > 0 ? orderedTabs : fallbackTabs;
  const renderedThreadIds = stripTabs.filter((tab) => tab.type === "chat").map((tab) => tab.id);

  useEffect(() => {
    const tabState = {
      selectedThreadId,
      renderedThreadIds,
      sourceThreadIds: threads.map((thread) => thread.id),
      activeFilePath,
      activeTerminalTabId,
      terminalTabActive,
      reviewTabActive,
      selectedThreadMissingFromTabs,
    };
    const signature = JSON.stringify(tabState);
    if (lastLoggedTabStateRef.current === signature) {
      return;
    }
    lastLoggedTabStateRef.current = signature;

    logWorkspaceUiIssueReportSignal(
      "header.tabs",
      {
        orderedTabsProvided: orderedTabs != null,
        orderedTabsLength: orderedTabs?.length ?? null,
        stripTabsLength: stripTabs.length,
        renderedThreadCount: renderedThreadIds.length,
        splitTabStripsActive: splitTabStrips != null,
        selectedThreadMissingFromTabs,
      },
      { threadId: selectedThreadId },
    );

    debugLog("workspace.header.tabs", "tabs.state.changed", {
      ...tabState,
      renderedThreadCount: renderedThreadIds.length,
      sourceThreadCount: threads.length,
      fileTabCount: fileTabs.length,
      fileTabPaths: fileTabs.map((tab) => tab.path),
      terminalTabCount: terminalTabs.length,
      terminalTabIds: terminalTabs.map((tab) => tab.id),
      selectedThreadFallbackTitle: selectedThreadFallbackTitle ?? null,
      branch: selectedWorktreeBranch,
      targetBranch,
      disabled,
    }, {
      threadId: selectedThreadId,
      force: selectedThreadMissingFromTabs,
    });
  }, [
    activeFilePath,
    activeTerminalTabId,
    disabled,
    fileTabs,
    reviewTabActive,
    selectedThreadFallbackTitle,
    selectedThreadId,
    selectedThreadMissingFromTabs,
    selectedWorktreeBranch,
    targetBranch,
    terminalTabActive,
    terminalTabs,
    orderedTabs,
    renderedThreadIds,
    splitTabStrips,
    stripTabs.length,
    threads,
  ]);

  useEffect(() => {
    if (splitTabStrips) {
      return;
    }
    scheduleWorkspaceUiGeometryProbe(() => {
      probeSingleHeaderTabAlignment(mergeWithContent);
    });
  }, [
    activeTabId,
    mergeWithContent,
    splitTabStrips,
    stripTabs.length,
  ]);

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

  const historyPopover = (
    <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Closed session history"
          title="Closed sessions"
          disabled={disabled}
        >
          <History className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[260px] p-1">
        {closedThreads.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No closed sessions</p>
        ) : (
          <ScrollArea className="max-h-64">
            <div className="flex flex-col">
              {closedThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  title={`Reopen ${thread.title}`}
                  onClick={() => {
                    setHistoryOpen(false);
                    onReopenThread?.(thread.id);
                  }}
                >
                  <AgentIcon
                    agent={thread.agent ?? "claude"}
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{thread.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(thread.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );

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
          {resourceMonitor}

          {worktreePath && (
            <OpenInAppButton
              key={worktreePath}
              targetPath={worktreePath}
              enableInstalledAppsQuery={enableInstalledAppsQuery}
            />
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

      <div
        className={cn(
          "flex gap-1",
          splitTabStrips ? "relative w-full min-w-0 shrink-0 items-center" : "items-center",
        )}
      >
        {splitTabStrips ? (
          <>
            <div
              className="flex min-w-0 flex-1 items-center overflow-hidden"
              data-testid="split-tab-strips-host"
            >
              {splitTabStrips}
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center gap-1 bg-gradient-to-l from-background via-background to-transparent pl-6"
              data-testid="split-tab-strips-trailing-controls"
            >
              <div className="pointer-events-auto flex items-center gap-1">
                <CreateSessionButton
                  preferenceScopeKey={worktreePath}
                  threadDisabled={createThreadDisabled ?? disabled}
                  terminalDisabled={createTerminalDisabled ?? disabled}
                  onCreateThread={onCreateThread}
                  onCreateTerminal={onCreateTerminal ?? onCreateThread}
                  className="shrink-0"
                />
                {historyPopover}
              </div>
            </div>
          </>
        ) : (
          <WorkspaceTabStrip
            groupId="topLeft"
            tabs={stripTabs}
            activeTabId={activeTabId}
            threads={threads}
            pendingThread={pendingThread}
            terminalTabs={terminalTabs}
            fileTabs={fileTabs}
            disabled={disabled}
            closingThreadId={closingThreadId}
            protectedThreadId={protectedThreadId}
            desktopApp={desktopApp}
            enableScrollIntoView
            onSelectTab={(tab) => {
              if (tab.type === "chat") {
                onSelectThread(tab.id);
              } else if (tab.type === "terminal") {
                onSelectTerminalTab?.(tab.id);
              } else if (tab.type === "review") {
                onSelectReviewTab?.();
              } else {
                onSelectFileTab(tab.id);
              }
            }}
            onCloseTab={(tab) => {
              if (tab.type === "chat") {
                onCloseThread(tab.id);
              } else if (tab.type === "terminal") {
                onCloseTerminalTab?.(tab.id);
              } else if (tab.type === "review") {
                onCloseReviewTab?.();
              } else {
                onCloseFileTab(tab.id);
              }
            }}
            onReorderTab={onReorderTab}
            onPinFileTab={onPinFileTab}
            onRenameThread={onRenameThread}
            onRenameTerminalTab={onRenameTerminalTab}
            onPrefetchThread={onPrefetchThread}
            onTabDragStart={onTabDragStart}
            onTabDragEnd={onTabDragEnd}
          />
        )}

        {!splitTabStrips ? (
          <CreateSessionButton
            preferenceScopeKey={worktreePath}
            threadDisabled={createThreadDisabled ?? disabled}
            terminalDisabled={createTerminalDisabled ?? disabled}
            onCreateThread={onCreateThread}
            onCreateTerminal={onCreateTerminal ?? onCreateThread}
            className="shrink-0"
          />
        ) : null}

        {!splitTabStrips ? <div className="ml-auto shrink-0">{historyPopover}</div> : null}
      </div>
    </section>
  );
}
