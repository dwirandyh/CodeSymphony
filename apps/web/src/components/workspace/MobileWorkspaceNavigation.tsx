import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Bug, ChevronRight, Clock3, FileCode2, Files, FolderGit2, GitBranch, GitPullRequestArrow, Grip, Loader2, MessageSquareText, Play, Save, Search, Settings2, TerminalSquare, Wrench, X } from "lucide-react";
import type { GitChangeEntry, ReviewKind, ReviewRef } from "@codesymphony/shared-types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { debugLog } from "../../lib/debugLog";
import { WorkspaceExplorerPanel } from "./WorkspaceExplorerPanel";
import { GitChangesPanel } from "./GitChangesPanel";
import type { WorkspaceFileTab } from "./WorkspaceHeader";
import { buildQuickFileItems, filterQuickFileItems } from "./quickFilePickerUtils";
import type { ScriptOutputEntry } from "./ScriptOutputTab";
import { ScriptOutputTab } from "./ScriptOutputTab";
import { DebugConsoleTab } from "./DebugConsoleTab";
import { TerminalTab, type TerminalTabHandle } from "./TerminalTab";

function fileName(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

function toCtrlChar(data: string): string | null {
  if (data.length !== 1) {
    return null;
  }

  const char = data.toUpperCase();
  if (char >= "A" && char <= "Z") {
    return String.fromCharCode(char.charCodeAt(0) - 64);
  }

  if (char === " ") {
    return "\u0000";
  }

  if (data === "[") {
    return "\u001b";
  }

  if (data === "\\") {
    return "\u001c";
  }

  if (data === "]") {
    return "\u001d";
  }

  return null;
}

function fileDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
}

function summarizeGitEntries(entries: GitChangeEntry[]) {
  return entries.reduce(
    (acc, entry) => {
      acc.total += 1;
      acc.insertions += entry.insertions;
      acc.deletions += entry.deletions;
      acc[entry.status] += 1;
      return acc;
    },
    {
      total: 0,
      insertions: 0,
      deletions: 0,
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      untracked: 0,
    },
  );
}

function getReviewActionLabel(reviewKind?: ReviewKind | null, reviewRef?: ReviewRef | null) {
  if (reviewRef) {
    return `Open ${reviewRef.display}`;
  }

  return reviewKind === "mr" ? "Create MR" : "Create PR";
}

type MobileUtilityTab = "setup-script" | "terminal" | "run" | "debug";

type MobileUtilityMeta = {
  title: string;
  subtitle: string;
  badge: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline";
};

function normalizeMobileUtilityTab(tab: string): MobileUtilityTab {
  if (tab === "terminal" || tab === "run" || tab === "debug") {
    return tab;
  }

  return "setup-script";
}

function getSetupOutputState(entry: ScriptOutputEntry | null): Pick<MobileUtilityMeta, "badge" | "badgeVariant"> {
  if (!entry) {
    return {
      badge: "Idle",
      badgeVariant: "outline",
    };
  }

  if (entry.status === "running") {
    return {
      badge: "Running",
      badgeVariant: "default",
    };
  }

  if (!entry.success) {
    return {
      badge: "Failed",
      badgeVariant: "destructive",
    };
  }

  return {
    badge: "Ready",
    badgeVariant: "secondary",
  };
}

function getMobileUtilityMeta({
  tab,
  latestSetupOutput,
  runScriptActive,
  worktreePath,
  selectedThreadId,
}: {
  tab: MobileUtilityTab;
  latestSetupOutput: ScriptOutputEntry | null;
  runScriptActive: boolean;
  worktreePath: string | null;
  selectedThreadId: string | null;
}): MobileUtilityMeta {
  const worktreeLabel = worktreePath ? fileName(worktreePath) : "this worktree";

  if (tab === "terminal") {
    return {
      title: "Terminal",
      subtitle: `Interactive shell rooted in ${worktreeLabel}.`,
      badge: "Shell",
      badgeVariant: "secondary",
    };
  }

  if (tab === "run") {
    return {
      title: "Run Script",
      subtitle: runScriptActive
        ? "Attached to the live run session and ready for interactive input."
        : "Monitor the run console here when a script session is started.",
      badge: runScriptActive ? "Running" : "Standby",
      badgeVariant: runScriptActive ? "default" : "outline",
    };
  }

  if (tab === "debug") {
    return {
      title: "Debug Console",
      subtitle: selectedThreadId
        ? "Frontend and runtime logs, scoped to the active thread when possible."
        : "Frontend and runtime logs for the current worktree.",
      badge: "Logs",
      badgeVariant: "secondary",
    };
  }

  const setupState = getSetupOutputState(latestSetupOutput);
  return {
    title: "Setup Script",
    subtitle: "Bootstrap output and rerun controls for workspace initialization.",
    badge: setupState.badge,
    badgeVariant: setupState.badgeVariant,
  };
}

function SectionButton({
  icon: Icon,
  title,
  description,
  badge,
  onClick,
  disabled = false,
}: {
  icon: typeof MessageSquareText;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border border-border/40 bg-background/50 px-3 py-3 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-secondary/50",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/70 text-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge ? <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">{badge}</Badge> : null}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function MobileUtilityRow({
  icon: Icon,
  title,
  description,
  badge,
  badgeVariant = "secondary",
  onClick,
  disabled = false,
}: {
  icon: typeof MessageSquareText;
  title: string;
  description: string;
  badge?: string;
  badgeVariant?: "default" | "secondary" | "destructive" | "outline";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-secondary/35",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-background/60 text-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {badge ? (
            <Badge variant={badgeVariant} className="h-5 rounded-full px-1.5 text-[10px]">
              {badge}
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{description}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

function MobilePanelShell({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[hsl(220,18%,10%)] lg:hidden">
      {children}
    </section>
  );
}

function MobileTerminalToolbar({
  bottomOffset = 0,
  ctrlArmed,
  ctrlLocked,
  moreOpen,
  onKeepTerminalFocus,
  onToggleCtrl,
  onSendEscape,
  onSendTab,
  onSendArrow,
  onToggleMore,
  onQuickAction,
  onRestartTerminal,
  canRestartTerminal,
}: {
  bottomOffset?: number;
  ctrlArmed: boolean;
  ctrlLocked: boolean;
  moreOpen: boolean;
  onKeepTerminalFocus: () => void;
  onToggleCtrl: () => void;
  onSendEscape: () => void;
  onSendTab: () => void;
  onSendArrow: (direction: "up" | "down" | "left" | "right") => void;
  onToggleMore: () => void;
  onQuickAction: (value: string) => void;
  onRestartTerminal: () => void;
  canRestartTerminal: boolean;
}) {
  const ctrlActive = ctrlArmed || ctrlLocked;
  const runToolbarAction = useCallback((actionId: string, action: () => void) => {
    debugLog("mobile.terminal.toolbar", "action", {
      actionId,
      ctrlArmed,
      ctrlLocked,
      moreOpen,
    });
    action();
    onKeepTerminalFocus();
  }, [ctrlArmed, ctrlLocked, moreOpen, onKeepTerminalFocus]);

  const createPressHandlers = useCallback((actionId: string, action: () => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      runToolbarAction(actionId, action);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      runToolbarAction(actionId, action);
    },
  }), [runToolbarAction]);

  return (
    <div
      className={cn(
        "inset-x-0 z-10 border-t border-border/40 bg-[hsl(220,18%,10%)]/95 px-2 py-1.5 backdrop-blur-md",
        bottomOffset > 0
          ? "fixed bottom-0 z-40 shadow-[0_-10px_30px_rgba(0,0,0,0.28)]"
          : "absolute bottom-0 safe-bottom",
      )}
      style={{ bottom: bottomOffset > 0 ? "var(--cs-mobile-keyboard-offset, 0px)" : undefined }}
    >
      <div className="grid grid-cols-6 gap-1">
        <button
          type="button"
          {...createPressHandlers("ctrl", onToggleCtrl)}
          className={cn(
            "inline-flex h-9 items-center justify-center rounded-lg border text-[11px] font-semibold transition-colors",
            ctrlActive
              ? "border-primary/60 bg-primary/12 text-primary"
              : "border-transparent text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
          )}
          aria-pressed={ctrlActive}
          title={ctrlLocked ? "Ctrl locked" : ctrlArmed ? "Ctrl armed" : "Ctrl"}
        >
          CTRL
        </button>
        <button
          type="button"
          {...createPressHandlers("tab", onSendTab)}
          className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
          title="Tab"
        >
          <span className="text-[11px] font-semibold">TAB</span>
        </button>
        <button
          type="button"
          {...createPressHandlers("escape", onSendEscape)}
          className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
          title="Escape"
        >
          <span className="text-[11px] font-semibold">ESC</span>
        </button>
        <button
          type="button"
          {...createPressHandlers("arrow-up", () => onSendArrow("up"))}
          className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
          title="Arrow up"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          {...createPressHandlers("arrow-down", () => onSendArrow("down"))}
          className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
          title="Arrow down"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
        <button
          type="button"
          {...createPressHandlers("more", onToggleMore)}
          className={cn(
            "inline-flex h-9 items-center justify-center rounded-lg px-2 text-[12px] font-semibold transition-colors",
            moreOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
          )}
          title="More terminal keys"
        >
          <span>...</span>
        </button>
      </div>
      {moreOpen ? (
        <div className="mt-1 grid grid-cols-2 gap-1 border-t border-border/30 pt-1.5">
          {[
            { label: "Ctrl+C", actionId: "quick-Ctrl+C", onPress: () => onQuickAction("\u0003") },
            { label: "Ctrl+D", actionId: "quick-Ctrl+D", onPress: () => onQuickAction("\u0004") },
            { label: "Ctrl+L", actionId: "quick-Ctrl+L", onPress: () => onQuickAction("\u000c") },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              {...createPressHandlers(action.actionId, action.onPress)}
              className="inline-flex h-8 items-center justify-center rounded-lg text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
            >
              {action.label}
            </button>
          ))}
          {canRestartTerminal ? (
            <button
              type="button"
              {...createPressHandlers("restart-terminal", onRestartTerminal)}
              className="inline-flex h-8 items-center justify-center rounded-lg text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
            >
              Restart
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MobileActionBar({
  hasWorktree,
  gitChangeCount,
  activeSection,
  onShowChat,
  onOpenFiles,
  onOpenGit,
  onOpenMore,
}: {
  hasWorktree: boolean;
  gitChangeCount: number;
  activeSection: "chat" | "files" | "git" | "more";
  onShowChat: () => void;
  onOpenFiles: () => void;
  onOpenGit: () => void;
  onOpenMore: () => void;
}) {
  const buttons = [
    { key: "chat", label: "Chat", icon: MessageSquareText, onClick: onShowChat, disabled: false },
    { key: "files", label: "Files", icon: Files, onClick: onOpenFiles, disabled: !hasWorktree },
    { key: "git", label: "Git", icon: GitBranch, onClick: onOpenGit, disabled: !hasWorktree, badge: gitChangeCount > 0 ? `${Math.min(gitChangeCount, 99)}${gitChangeCount > 99 ? "+" : ""}` : undefined },
    { key: "more", label: "More", icon: Grip, onClick: onOpenMore, disabled: false },
  ] as Array<{
    key: "chat" | "files" | "git" | "more";
    label: string;
    icon: typeof MessageSquareText;
    onClick: () => void;
    disabled: boolean;
    badge?: string;
  }>;

  return (
    <nav
      data-mobile-action-bar="true"
      className="shrink-0 border-t border-border/30 bg-[hsl(220,18%,10%)]/95 px-1.5 pb-2 pt-1 backdrop-blur-md safe-bottom lg:hidden sm:px-2.5"
    >
      <div className="grid grid-cols-4 gap-1">
        {buttons.map((button) => {
          const isActive = activeSection === button.key;
          return (
            <button
              key={button.key}
              type="button"
              onClick={button.onClick}
              disabled={button.disabled}
              className={cn(
                "relative flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors",
                isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                button.disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <button.icon className="h-4 w-4" />
              <span>{button.label}</span>
              {button.badge ? (
                <span className="absolute right-3 top-1.5 inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground">
                  {button.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function MobileFilesSheet({
  open,
  onOpenChange,
  activeFilePath,
  fileTabs,
  recentFilePaths,
  fileEntries,
  loading,
  onOpenFile,
  onCloseFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeFilePath: string | null;
  fileTabs: WorkspaceFileTab[];
  recentFilePaths: string[];
  fileEntries: Array<{ path: string; type: "file" | "directory" }>;
  loading: boolean;
  onOpenFile: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  const [activeTab, setActiveTab] = useState("browse");
  const [query, setQuery] = useState("");
  const quickFileItems = useMemo(() => buildQuickFileItems(fileEntries), [fileEntries]);
  const results = useMemo(() => filterQuickFileItems(quickFileItems, query), [quickFileItems, query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setActiveTab("browse");
    setQuery("");
  }, [open]);

  return (
    <MobilePanelShell
      open={open}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/20 px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files in this worktree"
              className="h-11 rounded-xl border-border/40 bg-background/60 pl-9 text-sm"
            />
          </div>
        </div>

        {query.trim().length > 0 ? (
          <ScrollArea className="min-h-0 flex-1 px-2 py-2">
            {results.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No matching files.</div>
            ) : (
              <div className="space-y-1">
                {results.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-secondary/45"
                    onClick={() => {
                      onOpenFile(item.path);
                      onOpenChange(false);
                    }}
                  >
                    <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-primary/80" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{item.directory || "."}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border/20 px-4 py-3">
              <TabsList className="grid h-11 w-full grid-cols-3 rounded-xl bg-secondary/60 p-1 text-xs">
                <TabsTrigger value="browse" className="rounded-lg text-xs">Browse</TabsTrigger>
                <TabsTrigger value="open" className="rounded-lg text-xs">Open Files</TabsTrigger>
                <TabsTrigger value="recent" className="rounded-lg text-xs">Recent</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="open" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full px-2 py-2">
                {fileTabs.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">No open files yet.</div>
                ) : (
                  <div className="space-y-1">
                    {fileTabs.map((tab) => (
                      <div
                        key={tab.path}
                        className={cn(
                          "flex items-center gap-2 rounded-xl px-3 py-3 transition-colors",
                          activeFilePath === tab.path ? "bg-secondary text-foreground" : "hover:bg-secondary/45",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            onOpenFile(tab.path);
                            onOpenChange(false);
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn("truncate text-sm font-medium", !tab.pinned && "italic")}>{fileName(tab.path)}</span>
                            {tab.dirty ? <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" /> : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{fileDir(tab.path) || "."}</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => onCloseFile(tab.path)}
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
                          aria-label={`Close ${fileName(tab.path)}`}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="recent" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full px-2 py-2">
                {recentFilePaths.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">Your recent files will appear here.</div>
                ) : (
                  <div className="space-y-1">
                    {recentFilePaths.map((path) => (
                      <button
                        key={path}
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-secondary/45",
                          activeFilePath === path && "bg-secondary text-foreground",
                        )}
                        onClick={() => {
                          onOpenFile(path);
                          onOpenChange(false);
                        }}
                      >
                        <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{fileName(path)}</div>
                          <div className="truncate text-xs text-muted-foreground">{fileDir(path) || "."}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </TabsContent>

            <TabsContent value="browse" className="mt-0 min-h-0 flex-1 overflow-hidden">
              <WorkspaceExplorerPanel
                entries={fileEntries}
                gitEntries={[]}
                loading={loading}
                activeFilePath={activeFilePath}
                onOpenFile={(path) => {
                  onOpenFile(path);
                  onOpenChange(false);
                }}
                onClose={() => onOpenChange(false)}
                showHeader={false}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </MobilePanelShell>
  );
}

export function MobileGitSheet({
  open,
  onOpenChange,
  entries,
  branch,
  loading,
  committing,
  syncing,
  canSync,
  ahead,
  behind,
  error,
  selectedFilePath,
  onCommit,
  onSync,
  onReview,
  onRefresh,
  onSelectFile,
  onDiscardChange,
  onOpenFile,
  reviewKind,
  reviewRef,
  prMrActionDisabled,
  prMrActionTitle,
  prMrActionBusy,
  onPrMrAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: GitChangeEntry[];
  branch: string;
  loading: boolean;
  committing: boolean;
  syncing: boolean;
  canSync: boolean;
  ahead?: number;
  behind?: number;
  error: string | null;
  selectedFilePath?: string | null;
  onCommit: (message: string) => void;
  onSync: () => void;
  onReview: () => void;
  onRefresh: () => void;
  onSelectFile?: (path: string) => void;
  onDiscardChange?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  reviewKind?: ReviewKind | null;
  reviewRef?: ReviewRef | null;
  prMrActionDisabled?: boolean;
  prMrActionTitle?: string;
  prMrActionBusy?: boolean;
  onPrMrAction?: () => void;
}) {
  const summary = useMemo(() => summarizeGitEntries(entries), [entries]);
  const reviewActionLabel = getReviewActionLabel(reviewKind, reviewRef);
  const syncSummary = [
    ahead && ahead > 0 ? `${ahead} out` : null,
    behind && behind > 0 ? `${behind} in` : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");

  return (
    <MobilePanelShell open={open}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-2 border-b border-border/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="h-6 rounded-full px-2.5 text-[11px] font-medium">
              <GitBranch className="mr-1 h-3 w-3" />
              {branch || "Detached HEAD"}
            </Badge>
            {summary.total > 0 ? (
              <Badge variant="secondary" className="h-6 rounded-full px-2.5 text-[11px] font-medium">
                {summary.total} {summary.total === 1 ? "file" : "files"}
              </Badge>
            ) : null}
            {syncSummary ? (
              <Badge variant="secondary" className="h-6 rounded-full px-2.5 text-[11px] font-medium">
                {syncSummary}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {summary.modified > 0 ? <span>{summary.modified} modified</span> : null}
              {summary.added + summary.untracked > 0 ? <span>{summary.added + summary.untracked} added</span> : null}
              {summary.deleted > 0 ? <span>{summary.deleted} deleted</span> : null}
              {(summary.insertions > 0 || summary.deletions > 0) ? (
                <span>
                  <span className="font-medium text-emerald-400">+{summary.insertions}</span>
                  {" / "}
                  <span className="font-medium text-rose-400">-{summary.deletions}</span>
                </span>
              ) : null}
              {summary.total === 0 && !syncSummary ? <span>Working tree clean</span> : null}
            </div>

            {onPrMrAction && reviewKind ? (
              <Button
                variant="secondary"
                size="sm"
                className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-[11px] font-medium"
                onClick={onPrMrAction}
                disabled={prMrActionDisabled || prMrActionBusy}
                title={prMrActionTitle ?? reviewActionLabel}
              >
                <GitPullRequestArrow className="h-3.5 w-3.5" />
                <span>{prMrActionBusy ? "Working..." : reviewActionLabel}</span>
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <GitChangesPanel
            entries={entries}
            branch={branch}
            loading={loading}
            committing={committing}
            syncing={syncing}
            canSync={canSync}
            ahead={ahead}
            behind={behind}
            error={error}
            selectedFilePath={selectedFilePath}
            onCommit={onCommit}
            onSync={onSync}
            onReview={onReview}
            onRefresh={onRefresh}
            onClose={() => onOpenChange(false)}
            onSelectFile={onSelectFile}
            onDiscardChange={onDiscardChange}
            onOpenFile={onOpenFile}
            reviewKind={reviewKind}
            reviewRef={reviewRef}
            prMrActionDisabled={prMrActionDisabled}
            prMrActionTitle={prMrActionTitle}
            prMrActionBusy={prMrActionBusy}
            onPrMrAction={onPrMrAction}
            showHeader={false}
          />
        </div>
      </div>
    </MobilePanelShell>
  );
}

export function MobileMoreSheet({
  open,
  onOpenChange,
  hasWorktree,
  runScriptActive,
  onOpenRepositories,
  onOpenSettings,
  onOpenUtility,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasWorktree: boolean;
  runScriptActive: boolean;
  onOpenRepositories: () => void;
  onOpenSettings: () => void;
  onOpenUtility: (tab: string) => void;
}) {
  return (
    <MobilePanelShell open={open}>
      <ScrollArea className="h-full px-4 py-4">
        <div className="space-y-5">
          <div className="rounded-2xl border border-border/30 bg-background/45 p-3">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Workspace</div>
              <SectionButton
                icon={FolderGit2}
                title="Repositories & Worktrees"
                description="Switch repository, pick worktree, or manage workspace context."
                onClick={onOpenRepositories}
              />
              <SectionButton
                icon={Settings2}
                title="Settings"
                description="Open workspace and model settings."
                onClick={onOpenSettings}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border/30 bg-background/45">
            <div className="border-b border-border/20 px-3 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Utilities</div>
              <p className="mt-1 text-xs text-muted-foreground">Focused tools for setup, shell access, runs, and logs.</p>
            </div>
            <div className="divide-y divide-border/15">
              <MobileUtilityRow
                icon={Wrench}
                title="Setup Script"
                description="Bootstrap output and rerun controls."
                badge="Auto"
                badgeVariant="outline"
                onClick={() => onOpenUtility("setup-script")}
                disabled={!hasWorktree}
              />
              <MobileUtilityRow
                icon={TerminalSquare}
                title="Terminal"
                description="Interactive shell in a dedicated mobile view."
                badge="Shell"
                onClick={() => onOpenUtility("terminal")}
                disabled={!hasWorktree}
              />
              <MobileUtilityRow
                icon={Play}
                title="Run Script"
                description="Live run console for interactive scripts."
                badge={runScriptActive ? "Running" : "Standby"}
                badgeVariant={runScriptActive ? "default" : "outline"}
                onClick={() => onOpenUtility("run")}
                disabled={!hasWorktree}
              />
              <MobileUtilityRow
                icon={Bug}
                title="Debug Console"
                description="Runtime and frontend logs for this workspace."
                badge="Logs"
                onClick={() => onOpenUtility("debug")}
                disabled={!hasWorktree}
              />
            </div>
          </div>
        </div>
      </ScrollArea>
    </MobilePanelShell>
  );
}

export function MobileUtilitiesSheet({
  open,
  onOpenChange,
  onBack,
  worktreeId,
  worktreePath,
  selectedThreadId,
  scriptOutputs,
  activeTab,
  onRerunSetup,
  runScriptActive,
  runScriptSessionId,
  onRunScriptExit,
  bottomOffset = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBack: () => void;
  worktreeId: string | null;
  worktreePath: string | null;
  selectedThreadId: string | null;
  scriptOutputs: ScriptOutputEntry[];
  activeTab: string;
  onRerunSetup?: () => void;
  runScriptActive: boolean;
  runScriptSessionId: string | null;
  onRunScriptExit?: (event: { exitCode: number; signal: number }) => void;
  bottomOffset?: number;
}) {
  const filteredOutputs = useMemo(
    () => worktreeId ? scriptOutputs.filter((entry) => entry.worktreeId === worktreeId) : [],
    [scriptOutputs, worktreeId],
  );
  const setupOutputs = useMemo(
    () => filteredOutputs.filter((entry) => entry.type === "setup" || entry.type === "teardown"),
    [filteredOutputs],
  );
  const latestSetupOutput = setupOutputs[setupOutputs.length - 1] ?? null;
  const currentTab = normalizeMobileUtilityTab(activeTab);
  const utilityMeta = useMemo(() => getMobileUtilityMeta({
    tab: currentTab,
    latestSetupOutput,
    runScriptActive,
    worktreePath,
    selectedThreadId,
  }), [currentTab, latestSetupOutput, runScriptActive, selectedThreadId, worktreePath]);
  const [terminalSessionVersion, setTerminalSessionVersion] = useState(0);
  const terminalRef = useRef<TerminalTabHandle | null>(null);
  const runTerminalRef = useRef<TerminalTabHandle | null>(null);
  const ctrlArmedRef = useRef(false);
  const ctrlLockedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [ctrlLocked, setCtrlLocked] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const terminalToolbarVisible = currentTab === "terminal" || currentTab === "run";

  const getActiveTerminalRef = useCallback(() => {
    if (currentTab === "run") {
      return runTerminalRef.current;
    }

    if (currentTab === "terminal") {
      return terminalRef.current;
    }

    return null;
  }, [currentTab]);

  const sendTerminalInput = useCallback((data: string) => {
    const activeTerminal = getActiveTerminalRef();
    if (!activeTerminal) {
      return;
    }

    activeTerminal.sendInput(data);
    activeTerminal.focus();
  }, [getActiveTerminalRef]);

  const keepTerminalFocus = useCallback(() => {
    const activeTerminal = getActiveTerminalRef();
    if (!activeTerminal) {
      return;
    }

    requestAnimationFrame(() => {
      activeTerminal.focus();
    });
  }, [getActiveTerminalRef]);

  const updateCtrlState = useCallback((nextArmed: boolean, nextLocked: boolean) => {
    ctrlArmedRef.current = nextArmed;
    ctrlLockedRef.current = nextLocked;
    setCtrlArmed(nextArmed);
    setCtrlLocked(nextLocked);
  }, []);

  const resetCtrlState = useCallback(() => {
    updateCtrlState(false, false);
  }, [updateCtrlState]);

  const handleToggleCtrl = useCallback(() => {
    setMoreOpen(false);
    const beforeState = {
      armed: ctrlArmedRef.current,
      locked: ctrlLockedRef.current,
    };

    if (ctrlLockedRef.current) {
      resetCtrlState();
    } else if (ctrlArmedRef.current) {
      updateCtrlState(false, true);
    } else {
      updateCtrlState(true, false);
    }

    debugLog("mobile.terminal.ctrl", "toggle", {
      activeTab: currentTab,
      before: beforeState,
      after: {
        armed: ctrlArmedRef.current,
        locked: ctrlLockedRef.current,
      },
    });
    keepTerminalFocus();
  }, [currentTab, keepTerminalFocus, resetCtrlState, updateCtrlState]);

  const handleTerminalInputTransform = useCallback((data: string) => {
    const ctrlIsArmed = ctrlArmedRef.current;
    const ctrlIsLocked = ctrlLockedRef.current;

    if (!ctrlIsArmed && !ctrlIsLocked) {
      if (data.length === 1) {
        debugLog("mobile.terminal.ctrl", "transform.skip", {
          activeTab: currentTab,
          data,
          reason: "ctrl-inactive",
        });
      }
      return data;
    }

    const ctrlChar = toCtrlChar(data);
    if (!ctrlChar) {
      debugLog("mobile.terminal.ctrl", "transform.skip", {
        activeTab: currentTab,
        data,
        reason: "no-ctrl-mapping",
        armed: ctrlIsArmed,
        locked: ctrlIsLocked,
      });
      return data;
    }

    if (ctrlIsArmed && !ctrlIsLocked) {
      resetCtrlState();
    }

    debugLog("mobile.terminal.ctrl", "transform.apply", {
      activeTab: currentTab,
      data,
      armed: ctrlIsArmed,
      locked: ctrlIsLocked,
      transformedCode: ctrlChar.charCodeAt(0),
    });

    return ctrlChar;
  }, [currentTab, resetCtrlState]);

  const handleSendEscape = useCallback(() => {
    sendTerminalInput("\u001b");
    setMoreOpen(false);
  }, [sendTerminalInput]);

  const handleSendTab = useCallback(() => {
    sendTerminalInput("\t");
    setMoreOpen(false);
  }, [sendTerminalInput]);

  const handleSendArrow = useCallback((direction: "up" | "down" | "left" | "right") => {
    const keyMap: Record<"up" | "down" | "left" | "right", string> = {
      up: "\u001b[A",
      down: "\u001b[B",
      right: "\u001b[C",
      left: "\u001b[D",
    };

    sendTerminalInput(keyMap[direction]);
    setMoreOpen(false);
  }, [sendTerminalInput]);

  const handleQuickAction = useCallback((value: string) => {
    sendTerminalInput(value);
    setMoreOpen(false);
  }, [sendTerminalInput]);

  const handleRestartTerminal = useCallback(() => {
    if (currentTab !== "terminal") {
      return;
    }

    debugLog("mobile.terminal.toolbar", "restart", {
      activeTab: currentTab,
      worktreeId,
      terminalSessionVersion,
    });
    resetCtrlState();
    setMoreOpen(false);
    setTerminalSessionVersion((current) => current + 1);
  }, [currentTab, resetCtrlState, terminalSessionVersion, worktreeId]);

  useEffect(() => {
    if (terminalToolbarVisible) {
      return;
    }

    resetCtrlState();
    setMoreOpen(false);
  }, [resetCtrlState, terminalToolbarVisible]);

  useEffect(() => {
    if (open) {
      return;
    }

    resetCtrlState();
    setMoreOpen(false);
  }, [open, resetCtrlState]);

  return (
    <MobilePanelShell open={open}>
      <div className="relative flex h-full min-h-0 flex-col bg-background">
        <div className="shrink-0 border-b border-border/20 px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-sm font-semibold text-foreground">Utilities</span>
            </button>
          </div>
          <div className="mt-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-foreground">{utilityMeta.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{utilityMeta.subtitle}</p>
            </div>
            <Badge variant={utilityMeta.badgeVariant} className="mt-0.5 h-6 shrink-0 rounded-full px-2.5 text-[11px] font-medium">
              {utilityMeta.badge}
            </Badge>
          </div>
        </div>

        {currentTab === "setup-script" ? (
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 pt-1.5">
            <div className="h-full overflow-hidden rounded-t-[20px] border border-b-0 border-border/20 bg-card/30">
              <ScriptOutputTab
                entries={setupOutputs}
                onRerunSetup={onRerunSetup}
                rerunning={setupOutputs.some((entry) => entry.status === "running")}
                showHeader={false}
              />
            </div>
          </div>
        ) : null}

        {currentTab === "terminal" ? (
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 pt-1.5">
            <div className="h-full overflow-hidden rounded-t-[20px] border border-b-0 border-border/20 bg-[#0f1218]">
              <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
                <TerminalTab
                  ref={terminalRef}
                  sessionId={worktreeId ? `${worktreeId}:terminal:${terminalSessionVersion}` : `default:${terminalSessionVersion}`}
                  cwd={worktreePath}
                  transformInput={handleTerminalInputTransform}
                />
              </Suspense>
            </div>
          </div>
        ) : null}

        {currentTab === "run" ? (
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 pt-1.5">
            <div className="h-full overflow-hidden rounded-t-[20px] border border-b-0 border-border/20 bg-[#0f1218]">
              {runScriptSessionId ? (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading run session...</div>}>
                  <TerminalTab
                    ref={runTerminalRef}
                    sessionId={runScriptSessionId}
                    cwd={worktreePath}
                    onSessionExit={onRunScriptExit}
                    transformInput={handleTerminalInputTransform}
                  />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                  Start the run script from the workspace header to stream it here.
                </div>
              )}
            </div>
          </div>
        ) : null}

        {currentTab === "debug" ? (
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 pt-1.5">
            <div className="h-full overflow-hidden rounded-t-[20px] border border-b-0 border-border/20 bg-card/30">
              <DebugConsoleTab worktreeId={worktreeId} selectedThreadId={selectedThreadId} />
            </div>
          </div>
        ) : null}

        {terminalToolbarVisible ? (
          <MobileTerminalToolbar
            bottomOffset={bottomOffset}
            ctrlArmed={ctrlArmed}
            ctrlLocked={ctrlLocked}
            moreOpen={moreOpen}
            onKeepTerminalFocus={keepTerminalFocus}
            onToggleCtrl={handleToggleCtrl}
            onSendEscape={handleSendEscape}
            onSendTab={handleSendTab}
            onSendArrow={handleSendArrow}
            onToggleMore={() => {
              setMoreOpen((current) => !current);
              keepTerminalFocus();
            }}
            onQuickAction={handleQuickAction}
            onRestartTerminal={handleRestartTerminal}
            canRestartTerminal={currentTab === "terminal"}
          />
        ) : null}
      </div>
    </MobilePanelShell>
  );
}

export function MobileSavePill({
  visible,
  saving,
  bottomOffset = 0,
  onSave,
}: {
  visible: boolean;
  saving: boolean;
  bottomOffset?: number;
  onSave: () => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div
      className="shrink-0 px-3 pb-2 lg:hidden sm:px-4"
      style={{ marginBottom: bottomOffset > 0 ? "var(--cs-mobile-keyboard-offset, 0px)" : undefined }}
    >
      <button
        type="button"
        onClick={onSave}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        <span>{saving ? "Saving..." : "Save Changes"}</span>
      </button>
    </div>
  );
}
