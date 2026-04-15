import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { Clock3, FileCode2, Files, FolderGit2, GitBranch, Grip, Loader2, MessageSquareText, Play, Save, Search, Settings2, TerminalSquare, Wrench, X } from "lucide-react";
import type { GitChangeEntry, ReviewKind, ReviewRef } from "@codesymphony/shared-types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { cn } from "../../lib/utils";
import { WorkspaceExplorerPanel } from "./WorkspaceExplorerPanel";
import { GitChangesPanel } from "./GitChangesPanel";
import type { WorkspaceFileTab } from "./WorkspaceHeader";
import { buildQuickFileItems, filterQuickFileItems } from "./quickFilePickerUtils";
import type { ScriptOutputEntry } from "./ScriptOutputTab";
import { ScriptOutputTab } from "./ScriptOutputTab";
import { DebugConsoleTab } from "./DebugConsoleTab";

const TerminalTab = lazy(() =>
  import("./TerminalTab").then((module) => ({ default: module.TerminalTab }))
);

function fileName(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
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

export function MobileActionBar({
  visible = true,
  hasWorktree,
  gitChangeCount,
  activeSection,
  onShowChat,
  onOpenFiles,
  onOpenGit,
  onOpenMore,
}: {
  visible?: boolean;
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

  if (!visible) {
    return null;
  }

  return (
    <nav className="shrink-0 border-t border-border/30 bg-[hsl(220,18%,10%)]/95 px-1.5 pb-2 pt-1 backdrop-blur-md safe-bottom lg:hidden sm:px-2.5">
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
  error,
  selectedFilePath,
  onCommit,
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
  error: string | null;
  selectedFilePath?: string | null;
  onCommit: (message: string) => void;
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

  return (
    <MobilePanelShell open={open}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="grid grid-cols-2 gap-2 border-b border-border/20 px-4 py-3">
          <div className="rounded-2xl border border-border/30 bg-background/55 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Changed Files</div>
            <div className="mt-1 text-2xl font-semibold text-foreground">{summary.total}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {summary.modified} modified · {summary.added + summary.untracked} added · {summary.deleted} deleted
            </div>
          </div>
          <div className="rounded-2xl border border-border/30 bg-background/55 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Line Delta</div>
            <div className="mt-1 flex items-end gap-3">
              <span className="text-xl font-semibold text-emerald-400">+{summary.insertions}</span>
              <span className="text-xl font-semibold text-rose-400">-{summary.deletions}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">Quick snapshot before review or commit.</div>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <GitChangesPanel
            entries={entries}
            branch={branch}
            loading={loading}
            committing={committing}
            error={error}
            selectedFilePath={selectedFilePath}
            onCommit={onCommit}
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

          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Utilities</div>
            <SectionButton
              icon={Wrench}
              title="Setup Script"
              description="Inspect workspace setup and rerun initialization output."
              onClick={() => onOpenUtility("setup-script")}
              disabled={!hasWorktree}
            />
            <SectionButton
              icon={TerminalSquare}
              title="Terminal"
              description="Open the worktree terminal in a dedicated mobile view."
              onClick={() => onOpenUtility("terminal")}
              disabled={!hasWorktree}
            />
            <SectionButton
              icon={Play}
              title="Run"
              description="Watch run-script output and current run session."
              badge={runScriptActive ? "Running" : undefined}
              onClick={() => onOpenUtility("run")}
              disabled={!hasWorktree}
            />
            <SectionButton
              icon={GitBranch}
              title="Debug Console"
              description="Inspect client/server debug logs for this worktree."
              onClick={() => onOpenUtility("debug")}
              disabled={!hasWorktree}
            />
          </div>
        </div>
      </ScrollArea>
    </MobilePanelShell>
  );
}

export function MobileUtilitiesSheet({
  open,
  onOpenChange,
  worktreeId,
  worktreePath,
  selectedThreadId,
  scriptOutputs,
  activeTab,
  onTabChange,
  onRerunSetup,
  runScriptActive,
  onRunScriptExit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktreeId: string | null;
  worktreePath: string | null;
  selectedThreadId: string | null;
  scriptOutputs: ScriptOutputEntry[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  onRerunSetup?: () => void;
  runScriptActive: boolean;
  onRunScriptExit?: (event: { exitCode: number; signal: number }) => void;
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
  const runSessionId = worktreeId && runScriptActive ? `${worktreeId}:script-runner` : null;

  return (
    <MobilePanelShell open={open}>
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/20 px-4 py-3">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-xl bg-secondary/60 p-1 text-xs">
            <TabsTrigger value="setup-script" className="rounded-lg px-2 py-2 text-[11px]">Setup</TabsTrigger>
            <TabsTrigger value="terminal" className="rounded-lg px-2 py-2 text-[11px]">Terminal</TabsTrigger>
            <TabsTrigger value="run" className="rounded-lg px-2 py-2 text-[11px]">
              <span className="inline-flex items-center gap-1">
                Run
                {runScriptActive ? <span className="h-2 w-2 rounded-full bg-primary" /> : null}
              </span>
            </TabsTrigger>
            <TabsTrigger value="debug" className="rounded-lg px-2 py-2 text-[11px]">Debug</TabsTrigger>
          </TabsList>
          {latestSetupOutput ? (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Latest setup: {latestSetupOutput.status === "completed" && !latestSetupOutput.success ? "failed" : latestSetupOutput.status}
            </div>
          ) : null}
        </div>

        <TabsContent value="setup-script" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <ScriptOutputTab
            entries={setupOutputs}
            onRerunSetup={onRerunSetup}
            rerunning={setupOutputs.some((entry) => entry.status === "running")}
          />
        </TabsContent>

        <TabsContent value="terminal" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading terminal...</div>}>
            <TerminalTab sessionId={worktreeId ? `${worktreeId}:terminal` : "default"} cwd={worktreePath} />
          </Suspense>
        </TabsContent>

        <TabsContent value="run" className="mt-0 min-h-0 flex-1 overflow-hidden">
          {runSessionId ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading run session...</div>}>
              <TerminalTab sessionId={runSessionId} cwd={worktreePath} onSessionExit={onRunScriptExit} />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              No run session is active for this worktree.
            </div>
          )}
        </TabsContent>

        <TabsContent value="debug" className="mt-0 min-h-0 flex-1 overflow-hidden">
          <DebugConsoleTab worktreeId={worktreeId} selectedThreadId={selectedThreadId} />
        </TabsContent>
      </Tabs>
    </MobilePanelShell>
  );
}

export function MobileSavePill({
  visible,
  saving,
  onSave,
}: {
  visible: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  if (!visible) {
    return null;
  }

  return (
    <div className="shrink-0 px-3 pb-2 lg:hidden sm:px-4">
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
