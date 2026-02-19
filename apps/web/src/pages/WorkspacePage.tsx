import { useCallback, useEffect, useState } from "react";
import { FolderGit2, GitBranch, Menu, X } from "lucide-react";
import { Composer } from "../components/workspace/Composer";
import { ChatMessageList } from "../components/workspace/ChatMessageList";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { GitChangesPanel } from "../components/workspace/GitChangesPanel";
import { DiffReviewPanel } from "../components/workspace/DiffReviewPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/useChatSession";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useSidebarResize } from "./workspace/hooks/useSidebarResize";
import { useGitChanges } from "./workspace/hooks/useGitChanges";

export function WorkspacePage() {
  const [error, setError] = useState<string | null>(null);

  const repos = useRepositoryManager(setError);
  const chat = useChatSession(repos.selectedWorktreeId, setError);
  const gates = usePendingGates(chat.events, chat.selectedThreadId, {
    onError: setError,
    startWaitingAssistant: chat.startWaitingAssistant,
    clearWaitingAssistantForThread: chat.clearWaitingAssistantForThread,
  });
  const { sidebarWidth, sidebarDragging, handleSidebarMouseDown } = useSidebarResize(300);
  const [rightPanelId, setRightPanelId] = useState<string | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState<"repos" | "git" | null>(null);
  const {
    sidebarWidth: rightPanelWidth,
    sidebarDragging: rightDragging,
    handleSidebarMouseDown: handleRightPanelMouseDown,
  } = useSidebarResize(320, true);
  const gitChanges = useGitChanges(repos.selectedWorktreeId, !!repos.selectedWorktreeId);

  const [reviewTabOpen, setReviewTabOpen] = useState(false);

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
  const [activeView, setActiveView] = useState<"chat" | "review">("chat");
  const [selectedDiffFilePath, setSelectedDiffFilePath] = useState<string | null>(null);

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
    setSelectedDiffFilePath(null);
    setReviewTabOpen(true);
    setActiveView("review");
  }, []);

  const handleSelectDiffFile = useCallback((filePath: string) => {
    setSelectedDiffFilePath(filePath);
    setReviewTabOpen(true);
    setActiveView("review");
  }, []);

  const handleCloseReview = useCallback(() => {
    setReviewTabOpen(false);
    setActiveView("chat");
    setSelectedDiffFilePath(null);
  }, []);

  const handleSelectThread = useCallback(
    (threadId: string | null) => {
      chat.setSelectedThreadId(threadId);
      setActiveView("chat");
    },
    [chat.setSelectedThreadId],
  );

  return (
    <div className="flex h-full p-1 safe-top sm:p-2 lg:p-3">
      <div className="mx-auto flex min-h-0 w-full max-w-[1860px]">
        {/* ── Resizable sidebar ── */}
        <aside
          className="hidden min-h-0 shrink-0 rounded-2xl bg-card/75 p-2 lg:block lg:p-3"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="mb-3">
            <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
            <p className="text-xs text-muted-foreground">Local code conductor</p>
          </div>

          <RepositoryPanel
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={() => void repos.attachRepository()}
            onSelectRepository={repos.setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              repos.setSelectedRepositoryId(repositoryId);
              repos.setSelectedWorktreeId(worktreeId);
            }}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
          />
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

        {/* ── Main content area (chat + bottom panel) ── */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-1.5 sm:p-2.5 lg:p-3">
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
              threads={chat.threads}
              selectedThreadId={chat.selectedThreadId}
              disabled={!repos.selectedWorktreeId}
              closingThreadId={chat.closingThreadId}
              showReviewTab={reviewTabOpen}
              reviewTabActive={activeView === "review"}
              onSelectThread={handleSelectThread}
              onCreateThread={() => void chat.createAdditionalThread()}
              onCloseThread={(threadId) => void chat.closeThread(threadId)}
              onSelectReviewTab={() => setActiveView("review")}
              onCloseReviewTab={handleCloseReview}
            />

            {error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {error}
              </div>
            ) : null}

            {activeView === "review" && reviewTabOpen && repos.selectedWorktreeId ? (
              <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <DiffReviewPanel worktreeId={repos.selectedWorktreeId} selectedFilePath={selectedDiffFilePath} />
              </section>
            ) : (
              <>
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="min-h-0 flex-1">
                    <ChatMessageList
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
                    onChange={chat.setChatInput}
                    onModeChange={chat.setChatMode}
                    onSubmitMessage={(content) => void chat.submitMessage(content)}
                    onStop={() => void chat.stopAssistantRun()}
                  />
                ) : null}
              </>
            )}
          </div>

          <BottomPanel worktreeId={repos.selectedWorktreeId} worktreePath={repos.selectedWorktree?.path ?? null} />
        </main>

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

        {/* ── Right panel content ── */}
        {rightPanelId && (
          <aside
            id="source-control-panel"
            aria-label="Source Control panel"
            className="hidden min-h-0 shrink-0 overflow-hidden rounded-2xl bg-card/75 lg:block"
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
                onReview={handleOpenReview}
                onRefresh={() => void gitChanges.refresh()}
                onClose={() => setRightPanelId(null)}
                onSelectFile={handleSelectDiffFile}
              />
            )}
          </aside>
        )}

        {/* ── Right icon bar ── */}
        <nav className="hidden w-11 shrink-0 flex-col items-center pt-2 lg:flex">
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
            onClick={() => setRightPanelId((prev) => (prev === "git" ? null : "git"))}
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
            <p className="text-xs text-muted-foreground">Local code conductor</p>
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
        <div className="min-h-0 flex-1 overflow-hidden px-2 safe-bottom">
          <RepositoryPanel
            repositories={repos.repositories}
            selectedRepositoryId={repos.selectedRepositoryId}
            selectedWorktreeId={repos.selectedWorktreeId}
            loadingRepos={repos.loadingRepos}
            submittingRepo={repos.submittingRepo}
            submittingWorktree={repos.submittingWorktree}
            onAttachRepository={() => void repos.attachRepository()}
            onSelectRepository={repos.setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void repos.submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              repos.setSelectedRepositoryId(repositoryId);
              repos.setSelectedWorktreeId(worktreeId);
              setMobilePanelOpen(null);
            }}
            onDeleteWorktree={(worktreeId) => void repos.removeWorktree(worktreeId)}
          />
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
          />
        )}
      </aside>
    </div>
  );
}
