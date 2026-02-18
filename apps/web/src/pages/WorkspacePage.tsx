import { useCallback, useState } from "react";
import { Composer } from "../components/workspace/Composer";
import { ChatMessageList } from "../components/workspace/ChatMessageList";
import { BottomPanel } from "../components/workspace/BottomPanel";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { PermissionPromptCard } from "../components/workspace/PermissionPromptCard";
import { PlanDecisionComposer } from "../components/workspace/PlanDecisionComposer";
import { QuestionCard } from "../components/workspace/QuestionCard";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { api } from "../lib/api";
import { useRepositoryManager } from "./workspace/hooks/useRepositoryManager";
import { useChatSession } from "./workspace/hooks/useChatSession";
import { usePendingGates } from "./workspace/hooks/usePendingGates";
import { useSidebarResize } from "./workspace/hooks/useSidebarResize";

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

  return (
    <div className="flex h-full p-2 sm:p-3">
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
        <main className="flex min-h-0 min-w-0 flex-1 flex-col p-2.5 lg:p-3">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <WorkspaceHeader
              selectedRepositoryName={repos.selectedRepository?.name ?? "No repository selected"}
              selectedWorktreeLabel={repos.selectedWorktree ? `Worktree: ${repos.selectedWorktree.branch}` : "Choose a worktree"}
              threads={chat.threads}
              selectedThreadId={chat.selectedThreadId}
              disabled={!repos.selectedWorktreeId}
              closingThreadId={chat.closingThreadId}
              onSelectThread={chat.setSelectedThreadId}
              onCreateThread={() => void chat.createAdditionalThread()}
              onCloseThread={(threadId) => void chat.closeThread(threadId)}
            />

            {error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {error}
              </div>
            ) : null}

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1">
                <ChatMessageList
                  items={chat.timelineItems}
                  showThinkingPlaceholder={showThinkingPlaceholder}
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


            {gates.showPlanDecisionComposer ? (
              <PlanDecisionComposer
                busy={gates.planActionBusy}
                onApprove={() => void gates.handleApprovePlan()}
                onRevise={(feedback) => void gates.handleRevisePlan(feedback)}
              />
            ) : (
              <Composer
                value={chat.chatInput}
                disabled={!chat.selectedThreadId || chat.sendingMessage || gates.hasPendingPermissionRequests || gates.hasPendingQuestionRequests || gates.planActionBusy}
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
            )}
          </div>

          <BottomPanel worktreeId={repos.selectedWorktreeId} worktreePath={repos.selectedWorktree?.path ?? null} />
        </main>
      </div>
    </div>
  );
}
