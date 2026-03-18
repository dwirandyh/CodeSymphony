import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Menu, Settings, X } from "lucide-react";
import type { ModelProvider } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/composer";
import { ChatMessageList } from "../components/workspace/chat-message-list";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";

const DiffReviewPanel = lazy(() =>
  import("../components/workspace/DiffReviewPanel").then(m => ({ default: m.DiffReviewPanel }))
);
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { findRootWorktree, isRootWorktree } from "../lib/worktree";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import type { TeardownErrorState, ScriptUpdateEvent } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/chat-session";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useGitChanges } from "./workspace/hooks/useGitChanges";
import { useFileIndex } from "./workspace/hooks/useFileIndex";
import { useBackgroundWorktreeStatusStream } from "./workspace/hooks/useBackgroundWorktreeStatusStream";
import { useWorkspaceSearchParams } from "./workspace/hooks/useWorkspaceSearchParams";
import { shouldConfirmCloseThread } from "./workspace/closeThreadGuard";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";
import { WorkspaceSidebar } from "./workspace/WorkspaceSidebar";
import { WorkspaceRightPanel } from "./workspace/WorkspaceRightPanel";
import {
  resolveChatMessageListKey,
  FilledPlayIcon,
  FilledPauseIcon,
} from "./workspace/workspacePageUtils";

export { resolveChatMessageListKey } from "./workspace/workspacePageUtils";

function BackgroundWorktreeStatusStreamBridge({
  repositories,
  selectedWorktreeId,
  selectedThreadId,
}: {
  repositories: ReturnType<typeof useRepositoryManager>["repositories"];
  selectedWorktreeId: string | null;
  selectedThreadId: string | null;
}) {
  useBackgroundWorktreeStatusStream(repositories, selectedWorktreeId, selectedThreadId);
  return null;
}

export function WorkspacePage() {
  const [error, setError] = useState<string | null>(null);
  const { search, updateSearch } = useWorkspaceSearchParams();

  const prevWorktreeIdRef = useRef<string | undefined>(search.worktreeId);

  const [scriptOutputs, setScriptOutputs] = useState<ScriptOutputEntry[]>([]);
  const [activeBottomTab, setActiveBottomTab] = useState("terminal");
  const [bottomPanelOpenSignal, setBottomPanelOpenSignal] = useState(0);
  const [runScriptActive, setRunScriptActive] = useState(false);
  const [teardownError, setTeardownError] = useState<TeardownErrorState | null>(null);
  const runScriptWorktreeIdRef = useRef<string | null>(null);

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

  const handleRunScriptTerminalExit = useCallback(({ exitCode }: { exitCode: number; signal: number }) => {
    const targetWorktreeId = runScriptWorktreeIdRef.current;
    setRunScriptActive(false);

    if (targetWorktreeId) {
      setScriptOutputs((prev) => prev.map((entry) =>
        entry.worktreeId === targetWorktreeId && entry.type === "run" && entry.status === "running"
          ? { ...entry, status: "completed", success: exitCode === 0 }
          : entry,
      ));
    }

    runScriptWorktreeIdRef.current = null;
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
  const repositoriesLoadError = repos.repositoriesError instanceof Error
    ? repos.repositoriesError.message
    : null;
  const uiError = error ?? repositoriesLoadError;

  const handleSelectRepository = useCallback((repositoryId: string) => {
    repos.setSelectedRepositoryId(repositoryId);
    const repository = repos.repositories.find((entry) => entry.id === repositoryId);
    if (!repository) {
      repos.setSelectedWorktreeId(null);
      return;
    }

    const primaryWorktree = findRootWorktree(repository);
    repos.setSelectedWorktreeId(primaryWorktree?.id ?? null);
  }, [repos.repositories, repos.setSelectedRepositoryId, repos.setSelectedWorktreeId]);

  const selectedIsRootWorkspace = !!(
    repos.selectedRepository &&
    repos.selectedWorktree &&
    isRootWorktree(repos.selectedWorktree, repos.selectedRepository)
  );
  const selectedContextLabel = repos.selectedWorktree
    ? (selectedIsRootWorkspace
      ? "Root Workspace"
      : `Worktree ${repos.selectedWorktree.branch} from ${repos.selectedWorktree.baseBranch}`)
    : "Choose a workspace";

  const activeView = search.view ?? "chat";
  const selectedDiffFilePath = search.file ?? null;
  const reviewTabOpen = activeView === "review";

  const chat = useChatSession(repos.selectedWorktreeId, setError, repos.updateWorktreeBranch, {
    initialThreadId: search.threadId,
    selectedRepositoryId: repos.selectedRepositoryId,
    timelineEnabled: !reviewTabOpen,
    onWorktreeResolved: (worktreeId) => {
      repos.setSelectedWorktreeId(worktreeId);
    },
    onThreadChange: useCallback(
      (threadId: string | null) => {
        updateSearch({ threadId: threadId ?? undefined });
      },
      [updateSearch],
    ),
  });
  const prevSelectedThreadIdRef = useRef<string | null>(chat.selectedThreadId);
  const chatMessageListKeyRef = useRef<string>(chat.selectedThreadId ?? "empty");
  const chatMessageListKey = resolveChatMessageListKey({
    previousKey: chatMessageListKeyRef.current,
    previousThreadId: prevSelectedThreadIdRef.current,
    nextThreadId: chat.selectedThreadId,
  });

  if (chatMessageListKey !== chatMessageListKeyRef.current) {
    chatMessageListKeyRef.current = chatMessageListKey;
  }

  useEffect(() => {
    prevSelectedThreadIdRef.current = chat.selectedThreadId;
  }, [chat.selectedThreadId]);

  const gates = usePendingGates(chat.events, chat.selectedThreadId, {
    onError: setError,
    startWaitingAssistant: chat.startWaitingAssistant,
    clearWaitingAssistantForThread: chat.clearWaitingAssistantForThread,
  });
  const [activePermissionRequestId, setActivePermissionRequestId] = useState<string | null>(null);

  const activePermissionIndex = useMemo(() => {
    if (gates.pendingPermissionRequests.length === 0) {
      return -1;
    }

    if (!activePermissionRequestId) {
      return 0;
    }

    return gates.pendingPermissionRequests.findIndex((request) => request.requestId === activePermissionRequestId);
  }, [activePermissionRequestId, gates.pendingPermissionRequests]);

  const activePermissionRequest = activePermissionIndex >= 0
    ? gates.pendingPermissionRequests[activePermissionIndex] ?? null
    : null;
  const hasMultiplePendingPermissions = gates.pendingPermissionRequests.length > 1;
  const rightPanelId = search.panel ?? null;
  const [mobilePanelOpen, setMobilePanelOpen] = useState<"repos" | "git" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmCloseThreadId, setConfirmCloseThreadId] = useState<string | null>(null);
  const gitChanges = useGitChanges(repos.selectedWorktreeId, !!repos.selectedWorktreeId);

  const fileIndex = useFileIndex(repos.selectedWorktreeId);

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

  useEffect(() => {
    if (gates.pendingPermissionRequests.length === 0) {
      setActivePermissionRequestId(null);
      return;
    }

    if (
      activePermissionRequestId
      && gates.pendingPermissionRequests.some((request) => request.requestId === activePermissionRequestId)
    ) {
      return;
    }

    const fallbackIndex = activePermissionIndex >= 0
      ? Math.min(activePermissionIndex, gates.pendingPermissionRequests.length - 1)
      : 0;
    const fallbackRequest = gates.pendingPermissionRequests[fallbackIndex] ?? gates.pendingPermissionRequests[0];
    setActivePermissionRequestId(fallbackRequest?.requestId ?? null);
  }, [activePermissionIndex, activePermissionRequestId, gates.pendingPermissionRequests]);

  const waitingAssistantThreadId = chat.waitingAssistant?.threadId ?? null;

  const showThinkingPlaceholder =
    waitingAssistantThreadId === chat.selectedThreadId && !gates.isWaitingForUserGate;

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
    runScriptWorktreeIdRef.current = null;
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
    const shellScript = runCommands.join(" ; ");
    const sessionId = resolveRunScriptSessionId();
    if (!sessionId) return;

    try {
      setActiveBottomTab("output");
      setBottomPanelOpenSignal((prev) => prev + 1);
      setRunScriptActive(true);
      runScriptWorktreeIdRef.current = repos.selectedWorktreeId;
      await api.runTerminalCommand({
        sessionId,
        command: shellScript,
        cwd: repos.selectedWorktree.path,
        mode: "exec",
      });
    } catch (e) {
      runScriptWorktreeIdRef.current = null;
      setRunScriptActive(false);
      setError(e instanceof Error ? e.message : "Failed to run script");
    }
  }, [repos.selectedWorktreeId, repos.selectedWorktree, repos.selectedRepository, resolveRunScriptSessionId]);

  const handleStopRunScript = useCallback(async () => {
    const sessionId = resolveRunScriptSessionId();
    if (!sessionId) return;
    try {
      setActiveBottomTab("output");
      setBottomPanelOpenSignal((prev) => prev + 1);
      await api.interruptTerminalSession(sessionId);
      setRunScriptActive(false);
      runScriptWorktreeIdRef.current = null;
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

  const handleShowPreviousPermission = useCallback(() => {
    if (activePermissionIndex <= 0) {
      return;
    }

    const previousRequest = gates.pendingPermissionRequests[activePermissionIndex - 1];
    if (previousRequest) {
      setActivePermissionRequestId(previousRequest.requestId);
    }
  }, [activePermissionIndex, gates.pendingPermissionRequests]);

  const handleShowNextPermission = useCallback(() => {
    if (activePermissionIndex < 0 || activePermissionIndex >= gates.pendingPermissionRequests.length - 1) {
      return;
    }

    const nextRequest = gates.pendingPermissionRequests[activePermissionIndex + 1];
    if (nextRequest) {
      setActivePermissionRequestId(nextRequest.requestId);
    }
  }, [activePermissionIndex, gates.pendingPermissionRequests]);

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

  const handleRequestCloseThread = useCallback((threadId: string) => {
    const needsConfirm = shouldConfirmCloseThread({
      threadId,
      selectedThreadId: chat.selectedThreadId,
      showStopAction: chat.showStopAction,
      waitingAssistantThreadId,
      threads: chat.threads,
    });

    if (needsConfirm) {
      setConfirmCloseThreadId(threadId);
      return;
    }

    void chat.closeThread(threadId);
  }, [chat.closeThread, chat.selectedThreadId, chat.showStopAction, chat.threads, waitingAssistantThreadId]);

  const handleConfirmCloseThread = useCallback(async () => {
    if (!confirmCloseThreadId) return;
    const threadId = confirmCloseThreadId;
    await chat.closeThread(threadId);
    setConfirmCloseThreadId(null);
  }, [chat.closeThread, confirmCloseThreadId]);

  const confirmCloseThread = confirmCloseThreadId
    ? chat.threads.find((thread) => thread.id === confirmCloseThreadId) ?? null
    : null;
  const closingConfirmedThread =
    confirmCloseThreadId !== null && chat.closingThreadId === confirmCloseThreadId;

  return (
    <div className="flex h-full p-1 pb-0 safe-top sm:p-2 sm:pb-0 lg:p-0">
      <div className="flex min-h-0 w-full">
        <WorkspaceSidebar
          repos={repos}
          onOpenSettings={() => setSettingsOpen(true)}
          onSelectRepository={handleSelectRepository}
        />

        {/* ── Main content area (chat + bottom panel) ── */}
        <main className="workspace-main flex min-h-0 min-w-0 flex-1 flex-col p-1.5 pb-0 sm:p-2.5 sm:pb-0 lg:p-3 lg:pb-0">
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
                {repos.selectedRepository?.name ?? "No repository"}
                {repos.selectedWorktree
                  ? ` · ${selectedIsRootWorkspace ? "Root Workspace" : repos.selectedWorktree.branch}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleRunScript}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary/50 text-muted-foreground transition-colors active:bg-secondary"
              aria-label={runScriptActive ? "Stop script" : "Run script"}
            >
              {runScriptActive ? (
                <FilledPauseIcon className="h-4 w-4" />
              ) : (
                <FilledPlayIcon className="h-4 w-4" />
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
              selectedWorktreeLabel={selectedContextLabel}
              worktreePath={repos.selectedWorktree?.path ?? null}
              threads={chat.threads}
              selectedThreadId={chat.selectedThreadId}
              disabled={!repos.selectedWorktreeId}
              createThreadDisabled={!repos.selectedRepositoryId}
              closingThreadId={chat.closingThreadId}
              showReviewTab={reviewTabOpen}
              reviewTabActive={activeView === "review"}
              onSelectThread={handleSelectThread}
              onCreateThread={() => void chat.createAdditionalThread()}
              onCloseThread={handleRequestCloseThread}
              onRenameThread={(threadId, title) => chat.renameThreadTitle(threadId, title)}
              onSelectReviewTab={() => updateSearch({ view: "review" })}
              onCloseReviewTab={handleCloseReview}
              runScriptRunning={runScriptActive}
              onToggleRunScript={handleToggleRunScript}
            />

            {uiError ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {uiError}
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
                      key={chatMessageListKey}
                      items={chat.timelineItems}
                      showThinkingPlaceholder={showThinkingPlaceholder}
                      onOpenReadFile={openReadFile}
                    />
                  </div>
                </section>
                {gates.pendingPermissionRequests.length > 0 ? (
                  <section className="mx-auto w-full max-w-3xl px-3" data-testid="permission-prompts-container">
                    <div className="space-y-2">
                      {hasMultiplePendingPermissions ? (
                        activePermissionRequest ? (
                          <PermissionPromptCard
                            key={activePermissionRequest.requestId}
                            requestId={activePermissionRequest.requestId}
                            toolName={activePermissionRequest.toolName}
                            command={activePermissionRequest.command}
                            editTarget={activePermissionRequest.editTarget}
                            blockedPath={activePermissionRequest.blockedPath}
                            decisionReason={activePermissionRequest.decisionReason}
                            busy={gates.resolvingPermissionIds.has(activePermissionRequest.requestId)}
                            canAlwaysAllow={Boolean(activePermissionRequest.command)}
                            position={{
                              current: activePermissionIndex + 1,
                              total: gates.pendingPermissionRequests.length,
                            }}
                            onPrevious={handleShowPreviousPermission}
                            onNext={handleShowNextPermission}
                            onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                            onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                            onDeny={(requestId) => {
                              void gates.resolvePermission(requestId, "deny");
                            }}
                          />
                        ) : null
                      ) : (
                        gates.pendingPermissionRequests.map((request) => (
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
                            onDeny={(requestId) => {
                              void gates.resolvePermission(requestId, "deny");
                            }}
                          />
                        ))
                      )}
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
                          busy={gates.answeringQuestionIds.has(request.requestId) || gates.dismissingQuestionIds.has(request.requestId)}
                          onAnswer={(requestId, answers) => void gates.answerQuestion(requestId, answers)}
                          onDismiss={(requestId) => void gates.dismissQuestion(requestId)}
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
                    disabled={chat.composerDisabled || gates.planActionBusy}
                    sending={chat.sendingMessage}
                    showStop={chat.showStopAction}
                    stopping={chat.stoppingRun}
                    threadId={chat.selectedThreadId}
                    worktreeId={repos.selectedWorktreeId}
                    fileIndex={fileIndex.entries}
                    fileIndexLoading={fileIndex.loading}
                    providers={modelProviders}
                    hasMessages={chat.messages.length > 0}
                    onSubmitMessage={({ content, mode, attachments }) => chat.submitMessage(content, mode, attachments)}
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
            runScriptActive={runScriptActive}
            onRunScriptExit={handleRunScriptTerminalExit}
            openSignal={bottomPanelOpenSignal}
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
            onSelectRepository={handleSelectRepository}
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

      <BackgroundWorktreeStatusStreamBridge
        repositories={repos.repositories}
        selectedWorktreeId={repos.selectedWorktreeId}
        selectedThreadId={chat.selectedThreadId}
      />

      <Dialog
        open={confirmCloseThreadId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmCloseThreadId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close session?</DialogTitle>
            <DialogDescription>
              {confirmCloseThread
                ? `AI is still responding in "${confirmCloseThread.title}". Closing now will end this session.`
                : "AI is still responding in this session. Closing now will end this session."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmCloseThreadId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleConfirmCloseThread()}
              disabled={closingConfirmedThread}
            >
              Close session
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
