import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Menu, Play, Settings, Square, X } from "lucide-react";
import type { ModelProvider } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/Composer";
import { ChatMessageList } from "../components/workspace/ChatMessageList";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { GitChangesPanel } from "../components/workspace/GitChangesPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { FileBrowserModal } from "../components/workspace/FileBrowserModal";
import { SettingsDialog } from "../components/workspace/SettingsDialog";
import { TeardownErrorDialog } from "../components/workspace/TeardownErrorDialog";
import type { ScriptOutputEntry } from "../components/workspace/ScriptOutputTab";

const DiffReviewPanel = lazy(() =>
  import("../components/workspace/DiffReviewPanel").then(m => ({ default: m.DiffReviewPanel }))
);
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { debugLog } from "../lib/debugLog";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import type { TeardownErrorState, ScriptUpdateEvent } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/useChatSession";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useSidebarResize } from "./workspace/hooks/useSidebarResize";
import { useGitChanges } from "./workspace/hooks/useGitChanges";
import { useFileIndex } from "./workspace/hooks/useFileIndex";
import { useWorkspaceSearchParams } from "./workspace/hooks/useWorkspaceSearchParams";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";

type RepoManager = ReturnType<typeof useRepositoryManager>;
type GitChangesData = ReturnType<typeof useGitChanges>;

const WorkspaceSidebar = memo(function WorkspaceSidebar({ repos, onOpenSettings }: { repos: RepoManager; onOpenSettings: () => void }) {
  const { sidebarWidth, sidebarDragging, handleSidebarMouseDown, panelRef } = useSidebarResize(300);

  return (
    <>
      <aside
        ref={panelRef}
        className="mb-1 hidden min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl bg-card/75 p-2 sm:mb-2 lg:mb-3 lg:flex lg:p-3"
        style={{ width: `${sidebarWidth}px` }}
      >
        <div className="mb-3">
          <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
          <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <RepositoryPanel
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={repos.openFileBrowser}
            onSelectRepository={repos.setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              repos.setSelectedRepositoryId(repositoryId);
              repos.setSelectedWorktreeId(worktreeId);
            }}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
            onRenameWorktreeBranch={(worktreeId, newBranch) => void repos.renameWorktreeBranch(worktreeId, newBranch)}
          />
        </div>

        <div className="shrink-0 border-t border-border/30 pt-2 pb-1 px-0">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </aside>

      {/* ── Sidebar resize handle ── */}
      <div
        className={`hidden w-1 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20 lg:flex ${sidebarDragging ? "bg-primary/30" : ""
          }`}
        onMouseDown={handleSidebarMouseDown}
      >
        <div
          className={`h-8 w-[2px] rounded-full transition-colors ${sidebarDragging ? "bg-primary/60" : "bg-border/30"
            }`}
        />
      </div>
    </>
  );
});

const WorkspaceRightPanel = memo(function WorkspaceRightPanel({
  rightPanelId,
  gitChanges,
  selectedDiffFilePath,
  onOpenReview,
  onSelectDiffFile,
  onUpdatePanel,
  onOpenReadFile,
}: {
  rightPanelId: string | null;
  gitChanges: GitChangesData;
  selectedDiffFilePath: string | null;
  onOpenReview: () => void;
  onSelectDiffFile: (filePath: string) => void;
  onUpdatePanel: (panel: "git" | undefined) => void;
  onOpenReadFile: (path: string) => void | Promise<void>;
}) {
  const {
    sidebarWidth: rightPanelWidth,
    sidebarDragging: rightDragging,
    handleSidebarMouseDown: handleRightPanelMouseDown,
    panelRef: rightPanelRef,
  } = useSidebarResize(320, true);

  return (
    <>
      {/* ── Right panel resize handle ── */}
      {rightPanelId && (
        <div
          className={cn(
            "hidden w-1 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20 lg:flex",
            rightDragging && "bg-primary/30",
          )}
          onMouseDown={handleRightPanelMouseDown}
        >
          <div
            className={cn(
              "h-8 w-[2px] rounded-full transition-colors",
              rightDragging ? "bg-primary/60" : "bg-border/30",
            )}
          />
        </div>
      )}

      {/* ── Right Sidebar ── */}
      <div className="mb-1 hidden min-h-0 shrink-0 flex-row rounded-2xl bg-card/75 sm:mb-2 lg:mb-3 lg:flex">
        {/* ── Right panel content ── */}
        {rightPanelId && (
          <aside
            ref={rightPanelRef}
            id="source-control-panel"
            aria-label="Source Control panel"
            className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border/30"
            style={{ width: `${rightPanelWidth}px` }}
          >
            {rightPanelId === "git" && (
              <GitChangesPanel
                entries={gitChanges.entries}
                branch={gitChanges.branch}
                loading={gitChanges.loading}
                committing={gitChanges.committing}
                error={gitChanges.error}
                selectedFilePath={selectedDiffFilePath}
                onCommit={(msg) => void gitChanges.commit(msg)}
                onReview={onOpenReview}
                onRefresh={() => void gitChanges.refresh()}
                onClose={() => onUpdatePanel(undefined)}
                onSelectFile={onSelectDiffFile}
                onDiscardChange={(path) => void gitChanges.discardChange(path)}
                onOpenFile={(path) => void onOpenReadFile(path)}
              />
            )}
          </aside>
        )}

        {/* ── Right icon bar ── */}
        <nav className="flex w-[48px] shrink-0 flex-col items-center pt-[10px] lg:pt-[14px]">
          <button
            type="button"
            title="Source Control"
            aria-label="Source Control"
            aria-expanded={rightPanelId === "git"}
            aria-controls="source-control-panel"
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
              rightPanelId === "git" && "bg-secondary text-foreground",
            )}
            onClick={() => onUpdatePanel(rightPanelId === "git" ? undefined : "git")}
          >
            <GitBranch className="h-[18px] w-[18px]" />
            {gitChanges.entries.length > 0 && (
              <span className="absolute right-0.5 top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
                {gitChanges.entries.length > 99 ? "99+" : gitChanges.entries.length}
              </span>
            )}
          </button>
        </nav>
      </div>
    </>
  );
});

export function WorkspacePage() {
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  const [error, setError] = useState<string | null>(null);
  const { search, updateSearch } = useWorkspaceSearchParams();

  const prevWorktreeIdRef = useRef<string | undefined>(search.worktreeId);

  const [scriptOutputs, setScriptOutputs] = useState<ScriptOutputEntry[]>([]);
  const [activeBottomTab, setActiveBottomTab] = useState("terminal");
  const [runScriptActive, setRunScriptActive] = useState(false);
  const [teardownError, setTeardownError] = useState<TeardownErrorState | null>(null);

  // ── Model/Provider state ──
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);

  const refreshModelProviders = useCallback(() => {
    api.listModelProviders()
      .then(setModelProviders)
      .catch(() => {});
  }, []);

  // Fetch model providers on mount
  useEffect(() => {
    refreshModelProviders();
  }, [refreshModelProviders]);

  const handleSelectProvider = useCallback(async (id: string | null) => {
    try {
      if (id === null) {
        await api.deactivateAllProviders();
      } else {
        await api.activateModelProvider(id);
      }
      refreshModelProviders();
    } catch {}
  }, [refreshModelProviders]);

  const handleScriptUpdate = useCallback((event: ScriptUpdateEvent) => {
    setScriptOutputs((prev) => {
      const entryId = `${event.worktreeId}-${event.type}`;
      const entry: ScriptOutputEntry = {
        id: entryId,
        worktreeId: event.worktreeId,
        worktreeName: event.worktreeName,
        type: event.type,
        timestamp: Date.now(),
        output: event.result?.output ?? "",
        success: event.result?.success ?? false,
        status: event.status,
      };
      const idx = prev.findIndex((e) => e.id === entryId);
      if (idx >= 0) {
        const existing = prev[idx];
        const copy = [...prev];
        // Preserve accumulated output when transitioning to completed
        copy[idx] = { ...entry, output: entry.output || existing.output, timestamp: existing.timestamp };
        return copy;
      }
      return [...prev, entry];
    });
    setActiveBottomTab("output");
    if (event.type === "setup" || event.type === "teardown") {
    }
  }, []);

  const handleTeardownError = useCallback((state: TeardownErrorState) => {
    setTeardownError(state);
  }, []);

  const handleScriptOutputChunk = useCallback(({ worktreeId, chunk }: { worktreeId: string; chunk: string }) => {
    setScriptOutputs((prev) => prev.map((entry) =>
      entry.worktreeId === worktreeId && entry.status === "running"
        ? { ...entry, output: entry.output + chunk }
        : entry
    ));
  }, []);

  const repos = useRepositoryManager(setError, {
    initialRepoId: search.repoId,
    initialWorktreeId: search.worktreeId,
    onScriptUpdate: handleScriptUpdate,
    onScriptOutputChunk: handleScriptOutputChunk,
    onTeardownError: handleTeardownError,
    onSelectionChange: useCallback(
      (selection: { repoId: string | null; worktreeId: string | null }) => {
        const worktreeChanged = (selection.worktreeId ?? undefined) !== prevWorktreeIdRef.current;
        debugLog("WorkspacePage", "onSelectionChange", {
          repoId: selection.repoId,
          worktreeId: selection.worktreeId,
          prevWorktreeId: prevWorktreeIdRef.current,
          worktreeChanged,
        });
        prevWorktreeIdRef.current = selection.worktreeId ?? undefined;
        updateSearch({
          repoId: selection.repoId ?? undefined,
          worktreeId: selection.worktreeId ?? undefined,
          ...(worktreeChanged ? { threadId: undefined } : {}),
        });
      },
      [updateSearch],
    ),
  });
  const chat = useChatSession(repos.selectedWorktreeId, setError, repos.updateWorktreeBranch, {
    initialThreadId: search.threadId,
    onThreadChange: useCallback(
      (threadId: string | null) => {
        debugLog("WorkspacePage", "onThreadChange", { threadId });
        updateSearch({ threadId: threadId ?? undefined });
      },
      [updateSearch],
    ),
  });
  const gates = usePendingGates(chat.events, chat.selectedThreadId, {
    onError: setError,
    startWaitingAssistant: chat.startWaitingAssistant,
    clearWaitingAssistantForThread: chat.clearWaitingAssistantForThread,
  });
  const rightPanelId = search.panel ?? null;
  const [mobilePanelOpen, setMobilePanelOpen] = useState<"repos" | "git" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const gitChanges = useGitChanges(repos.selectedWorktreeId, !!repos.selectedWorktreeId);

  // ── What-changed detector ──
  const prevRefsRef = useRef<Record<string, unknown>>({});
  const trackables: Record<string, unknown> = {
    error,
    search,
    updateSearch,
    "repos.selectedRepositoryId": repos.selectedRepositoryId,
    "repos.selectedWorktreeId": repos.selectedWorktreeId,
    "repos.repositories": repos.repositories,
    "repos.loadingRepos": repos.loadingRepos,
    "repos.submittingRepo": repos.submittingRepo,
    "repos.updateWorktreeBranch": repos.updateWorktreeBranch,
    "chat.threads": chat.threads,
    "chat.selectedThreadId": chat.selectedThreadId,
    "chat.messages": chat.messages,
    "chat.events": chat.events,
    "chat.timelineItems": chat.timelineItems,
    "chat.sendingMessage": chat.sendingMessage,
    "chat.waitingAssistant": chat.waitingAssistant,
    "chat.showStopAction": chat.showStopAction,
    "chat.stoppingRun": chat.stoppingRun,
    "chat.chatInput": chat.chatInput,
    "chat.chatMode": chat.chatMode,
    "gates.pendingPermissionRequests": gates.pendingPermissionRequests,
    "gates.pendingQuestionRequests": gates.pendingQuestionRequests,
    "gates.isWaitingForUserGate": gates.isWaitingForUserGate,
    "gates.showPlanDecisionComposer": gates.showPlanDecisionComposer,
    "gates.planActionBusy": gates.planActionBusy,
    "gates.resolvingPermissionIds": gates.resolvingPermissionIds,
    "gates.answeringQuestionIds": gates.answeringQuestionIds,
    "gitChanges.entries": gitChanges.entries,
    "gitChanges.branch": gitChanges.branch,
    "gitChanges.loading": gitChanges.loading,
    mobilePanelOpen,
  };
  const changed: string[] = [];
  for (const [key, val] of Object.entries(trackables)) {
    if (prevRefsRef.current[key] !== val) changed.push(key);
  }
  prevRefsRef.current = { ...trackables };
  debugLog("WorkspacePage", "render", { renderCount: renderCountRef.current, changed });
  const fileIndex = useFileIndex(repos.selectedWorktreeId);

  const activeView = search.view ?? "chat";
  const selectedDiffFilePath = search.file ?? null;
  const reviewTabOpen = activeView === "review";

  // Close mobile drawer on Escape key
  useEffect(() => {
    if (!mobilePanelOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobilePanelOpen(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobilePanelOpen]);

  const showThinkingPlaceholder =
    chat.waitingAssistant?.threadId === chat.selectedThreadId && !gates.isWaitingForUserGate;

  const openReadFile = useCallback(
    async (filePath: string) => {
      if (!repos.selectedWorktreeId) {
        setError("Worktree is not selected");
        return;
      }
      try {
        await api.openWorktreeFile(repos.selectedWorktreeId, { path: filePath });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to open file");
      }
    },
    [repos.selectedWorktreeId],
  );

  const handleOpenReview = useCallback(() => {
    updateSearch({ file: undefined, view: "review" });
  }, [updateSearch]);

  const forceDeleteQueryClient = useQueryClient();

  const handleForceDelete = useCallback(async (worktreeId: string) => {
    try {
      await api.deleteWorktree(worktreeId, { force: true });
      setTeardownError(null);
      if (repos.selectedWorktreeId === worktreeId) {
        repos.setSelectedWorktreeId(null);
      }
      void forceDeleteQueryClient.invalidateQueries({ queryKey: queryKeys.repositories.all });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Force delete failed");
      setTeardownError(null);
    }
  }, [repos.selectedWorktreeId, repos.setSelectedWorktreeId, forceDeleteQueryClient]);

  const handleRerunSetup = useCallback(() => {
    if (!repos.selectedWorktreeId) return;
    setActiveBottomTab("output");
    void repos.rerunSetup(repos.selectedWorktreeId);
  }, [repos.rerunSetup, repos.selectedWorktreeId]);

  const resolveRunScriptSessionId = useCallback(() => {
    if (!repos.selectedWorktreeId) return null;
    return `${repos.selectedWorktreeId}:script-runner`;
  }, [repos.selectedWorktreeId]);

  useEffect(() => {
    setRunScriptActive(false);
  }, [repos.selectedWorktreeId]);

  const handleRunScript = useCallback(async () => {
    if (!repos.selectedWorktreeId || !repos.selectedWorktree) return;
    const runCommands = (repos.selectedRepository?.runScript ?? [])
      .map((command) => command.trim())
      .filter((command) => command.length > 0);
    if (runCommands.length === 0) {
      setSettingsOpen(true);
      return;
    }
    const command = runCommands.join("\n");
    const sessionId = resolveRunScriptSessionId();
    if (!sessionId) return;

    try {
      setActiveBottomTab("output");
      await api.runTerminalCommand({
        sessionId,
        command,
        cwd: repos.selectedWorktree.path,
      });
      setRunScriptActive(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run script");
    }
  }, [repos.selectedWorktreeId, repos.selectedWorktree, repos.selectedRepository, resolveRunScriptSessionId]);

  const handleStopRunScript = useCallback(async () => {
    const sessionId = resolveRunScriptSessionId();
    if (!sessionId) return;
    try {
      setActiveBottomTab("output");
      await api.interruptTerminalSession(sessionId);
      setRunScriptActive(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop script");
    }
  }, [resolveRunScriptSessionId]);

  const handleToggleRunScript = useCallback(() => {
    if (runScriptActive) {
      void handleStopRunScript();
      return;
    }
    void handleRunScript();
  }, [handleRunScript, handleStopRunScript, runScriptActive]);

  const handleSelectDiffFile = useCallback((filePath: string) => {
    updateSearch({ file: filePath, view: "review" });
  }, [updateSearch]);

  const handleCloseReview = useCallback(() => {
    updateSearch({ view: undefined, file: undefined });
  }, [updateSearch]);

  const handleSelectThread = useCallback(
    (threadId: string | null) => {
      chat.setSelectedThreadId(threadId);
      updateSearch({ view: undefined, threadId: threadId ?? undefined });
    },
    [chat.setSelectedThreadId, updateSearch],
  );

  return (
    <div className="flex h-full p-1 pb-0 safe-top sm:p-2 sm:pb-0 lg:p-3 lg:pb-0">
      <div className="mx-auto flex min-h-0 w-full max-w-[1860px]">
        <WorkspaceSidebar repos={repos} onOpenSettings={() => setSettingsOpen(true)} />

        {/* ── Main content area (chat + bottom panel) ── */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-1.5 pb-0 sm:p-2.5 sm:pb-0 lg:p-3 lg:pb-0">
          {/* ── Mobile top bar ── */}
          <div className="flex items-center gap-2 pb-1.5 lg:hidden">
            <button
              type="button"
              onClick={() => setMobilePanelOpen("repos")}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label="Open repositories"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[13px] font-semibold tracking-wide">CodeSymphony</h1>
              <p className="truncate text-[10px] text-muted-foreground">
                {repos.selectedRepository?.name ?? "No repository"}{repos.selectedWorktree ? ` · ${repos.selectedWorktree.branch}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleRunScript}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label={runScriptActive ? "Stop script" : "Run script"}
            >
              {runScriptActive ? (
                <Square className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setMobilePanelOpen("git")}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label="Open source control"
            >
              <GitBranch className="h-4 w-4" />
              {gitChanges.entries.length > 0 && (
                <span className="absolute right-0.5 top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
                  {gitChanges.entries.length > 99 ? "99+" : gitChanges.entries.length}
                </span>
              )}
            </button>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 lg:gap-2">
            <WorkspaceHeader
              selectedRepositoryName={repos.selectedRepository?.name ?? "No repository selected"}
              selectedWorktreeLabel={repos.selectedWorktree ? `Worktree: ${repos.selectedWorktree.branch}` : "Choose a worktree"}
              worktreePath={repos.selectedWorktree?.path ?? null}
              threads={chat.threads}
              selectedThreadId={chat.selectedThreadId}
              disabled={!repos.selectedWorktreeId}
              closingThreadId={chat.closingThreadId}
              showReviewTab={reviewTabOpen}
              reviewTabActive={activeView === "review"}
              onSelectThread={handleSelectThread}
              onCreateThread={() => void chat.createAdditionalThread()}
              onCloseThread={(threadId) => void chat.closeThread(threadId)}
              onSelectReviewTab={() => updateSearch({ view: "review" })}
              onCloseReviewTab={handleCloseReview}
              runScriptRunning={runScriptActive}
              onToggleRunScript={handleToggleRunScript}
            />

            {error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {error}
              </div>
            ) : null}

            {activeView === "review" && reviewTabOpen && repos.selectedWorktreeId ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading review...</div>}>
                  <DiffReviewPanel worktreeId={repos.selectedWorktreeId} selectedFilePath={selectedDiffFilePath} />
                </Suspense>
              </section>
            ) : (
              <>
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="min-h-0 min-w-0 flex-1">
                    <ChatMessageList
                      key={chat.selectedThreadId ?? "empty"}
                      items={chat.timelineItems}
                      showThinkingPlaceholder={showThinkingPlaceholder}
                      sendingMessage={chat.sendingMessage}
                      onOpenReadFile={openReadFile}
                    />
                  </div>
                </section>
                {gates.pendingPermissionRequests.length > 0 ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="permission-prompts-container">
                    <div className="space-y-2">
                      {gates.pendingPermissionRequests.map((request) => (
                        <PermissionPromptCard
                          key={request.requestId}
                          requestId={request.requestId}
                          toolName={request.toolName}
                          command={request.command}
                          editTarget={request.editTarget}
                          blockedPath={request.blockedPath}
                          decisionReason={request.decisionReason}
                          busy={gates.resolvingPermissionIds.has(request.requestId)}
                          canAlwaysAllow={Boolean(request.command)}
                          onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                          onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                          onDeny={(requestId) => void gates.resolvePermission(requestId, "deny")}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
                {gates.pendingQuestionRequests.length > 0 ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="question-prompts-container">
                    <div className="space-y-2">
                      {gates.pendingQuestionRequests.map((request) => (
                        <QuestionCard
                          key={request.requestId}
                          requestId={request.requestId}
                          questions={request.questions}
                          busy={gates.answeringQuestionIds.has(request.requestId)}
                          onAnswer={(requestId, answers) => void gates.answerQuestion(requestId, answers)}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
                {!gates.showPlanDecisionComposer && gates.isWaitingForUserGate ? <div className="pb-2 pt-1" /> : null}

                {gates.showPlanDecisionComposer ? (
                  <PlanDecisionComposer
                    busy={gates.planActionBusy}
                    onApprove={() => void gates.handleApprovePlan()}
                    onRevise={(feedback) => void gates.handleRevisePlan(feedback)}
                    onDismiss={() => gates.handleDismissPlan()}
                  />
                ) : !gates.isWaitingForUserGate ? (
                  <Composer
                    value={chat.chatInput}
                    disabled={!chat.selectedThreadId || chat.sendingMessage || gates.planActionBusy}
                    sending={chat.sendingMessage}
                    showStop={chat.showStopAction}
                    stopping={chat.stoppingRun}
                    mode={chat.chatMode}
                    worktreeId={repos.selectedWorktreeId}
                    fileIndex={fileIndex.entries}
                    fileIndexLoading={fileIndex.loading}
                    providers={modelProviders}
                    hasMessages={chat.messages.length > 0}
                    attachments={chat.pendingAttachments}
                    onAttachmentsChange={chat.setPendingAttachments}
                    onChange={chat.setChatInput}
                    onModeChange={chat.setChatMode}
                    onSubmitMessage={(content, attachments) => void chat.submitMessage(content, attachments)}
                    onStop={() => void chat.stopAssistantRun()}
                    onSelectProvider={(id) => void handleSelectProvider(id)}
                  />
                ) : null}
              </>
            )}
          </div>

          <BottomPanel
            worktreeId={repos.selectedWorktreeId}
            worktreePath={repos.selectedWorktree?.path ?? null}
            selectedThreadId={chat.selectedThreadId}
            scriptOutputs={scriptOutputs}
            activeTab={activeBottomTab}
            onTabChange={setActiveBottomTab}
            onRerunSetup={handleRerunSetup}
          />
        </main>

        <WorkspaceRightPanel
          rightPanelId={rightPanelId}
          gitChanges={gitChanges}
          selectedDiffFilePath={selectedDiffFilePath}
          onOpenReview={handleOpenReview}
          onSelectDiffFile={handleSelectDiffFile}
          onUpdatePanel={(panel) => updateSearch({ panel })}
          onOpenReadFile={openReadFile}
        />
      </div>

      {/* ── Mobile drawer backdrop ── */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          mobilePanelOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setMobilePanelOpen(null)}
        aria-hidden="true"
      />

      {/* ── Mobile repos drawer (slide from left) ── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-[320px] flex-col bg-card shadow-2xl drawer-slide safe-top lg:hidden",
          mobilePanelOpen === "repos" ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <div>
            <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
            <p className="text-xs text-muted-foreground">Multi-agent orchestrator</p>
          </div>
          <button
            type="button"
            onClick={() => setMobilePanelOpen(null)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-secondary/60"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2">
          <RepositoryPanel
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={repos.openFileBrowser}
            onSelectRepository={repos.setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              repos.setSelectedRepositoryId(repositoryId);
              repos.setSelectedWorktreeId(worktreeId);
              setMobilePanelOpen(null);
            }}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
            onRenameWorktreeBranch={(worktreeId, newBranch) => void repos.renameWorktreeBranch(worktreeId, newBranch)}
          />
        </div>
        <div className="shrink-0 border-t border-border/30 px-4 pt-2 pb-3 safe-bottom">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-muted-foreground transition-colors active:bg-secondary/60"
            onClick={() => {
              setMobilePanelOpen(null);
              setSettingsOpen(true);
            }}
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </aside>

      {/* ── Mobile git drawer (slide from right) ── */}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-[360px] flex-col bg-card shadow-2xl drawer-slide safe-top safe-bottom lg:hidden",
          mobilePanelOpen === "git" ? "translate-x-0" : "translate-x-full",
        )}
      >
        {mobilePanelOpen === "git" && (
          <GitChangesPanel
            entries={gitChanges.entries}
            branch={gitChanges.branch}
            loading={gitChanges.loading}
            committing={gitChanges.committing}
            error={gitChanges.error}
            selectedFilePath={selectedDiffFilePath}
            onCommit={(msg) => void gitChanges.commit(msg)}
            onReview={() => {
              handleOpenReview();
              setMobilePanelOpen(null);
            }}
            onRefresh={() => void gitChanges.refresh()}
            onClose={() => setMobilePanelOpen(null)}
            onSelectFile={(path) => {
              handleSelectDiffFile(path);
              setMobilePanelOpen(null);
            }}
            onDiscardChange={(path) => void gitChanges.discardChange(path)}
            onOpenFile={(path) => {
              void openReadFile(path);
              setMobilePanelOpen(null);
            }}
          />
        )}
      </aside>

      <FileBrowserModal
        open={repos.fileBrowserOpen}
        onClose={() => repos.setFileBrowserOpen(false)}
        onSelect={(path) => void repos.attachRepositoryFromPath(path)}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        repositories={repos.repositories}
        onRemoveRepository={(id) => {
          setSettingsOpen(false);
          void repos.removeRepository(id);
        }}
        onProvidersChanged={refreshModelProviders}
      />

      <TeardownErrorDialog
        open={teardownError !== null}
        worktreeId={teardownError?.worktreeId ?? null}
        worktreeName={teardownError?.worktreeName ?? ""}
        output={teardownError?.output ?? ""}
        onForceDelete={(id) => void handleForceDelete(id)}
        onClose={() => setTeardownError(null)}
      />
    </div>
  );
}
