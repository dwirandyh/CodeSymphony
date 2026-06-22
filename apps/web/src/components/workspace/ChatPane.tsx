import { Suspense, lazy, useMemo } from "react";
import type {
  AttachmentInput,
  ChatMode,
  ChatThread,
  ChatThreadPermissionMode,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CursorModelCatalogEntry,
  CliAgent,
  ModelProvider,
  OpencodeModelCatalogEntry,
  ProviderOptionSelection,
  SlashCommand,
  UpdateChatThreadAgentSelectionInput,
} from "@codesymphony/shared-types";
import { useThreadThinkingActive } from "../../collections/threadStreamState";
import {
  MOBILE_OVERLAY_Z_CLASS,
  resolveMobileChatContentScrollPadding,
  resolveMobileChatScrollRegionClass,
  resolveMobileGateSurfaceStyle,
  resolveMobileChatViewportInset,
} from "../../lib/mobileStacking";
import { cn } from "../../lib/utils";
import { useThreadPaneSession } from "../../pages/workspace/hooks/chat-session/useThreadPaneSession";
import { useGateRequestNavigation } from "../../pages/workspace/hooks/useGateRequestNavigation";
import {
  deriveVisibleUserGates,
  deriveWorkingStatus,
  shouldShowThinkingPlaceholder,
} from "../../pages/workspace/workspacePageUtils";
import type { RuntimeInfo } from "../../lib/api";
import type { SendMessagesWith } from "../../lib/generalSettings";
import { isOptimisticThreadId } from "../../lib/threadIds";
import { ChatMessageList } from "./chat-message-list";
import { Composer } from "./composer";
import { AGENT_LABELS } from "./composer/AgentModelSelector";

const PermissionPromptCard = lazy(() =>
  import("./PermissionPromptCard").then((m) => ({ default: m.PermissionPromptCard })),
);
const QuestionCard = lazy(() =>
  import("./QuestionCard").then((m) => ({ default: m.QuestionCard })),
);
const PlanDecisionComposer = lazy(() =>
  import("./PlanDecisionComposer").then((m) => ({ default: m.PlanDecisionComposer })),
);

export interface ChatPaneProps {
  threadId: string;
  thread: ChatThread | null;
  worktreeId: string | null;
  repositoryId: string | null;
  worktreeOperational: boolean;
  worktreePath: string | null;
  // Shared model/slash-command catalogs (owned by the parent so both panes share
  // one source of truth).
  providers: ModelProvider[];
  claudeModels?: readonly ClaudeModelCatalogEntry[];
  codexModels?: readonly CodexModelCatalogEntry[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  modelCatalogReadyByAgent?: Partial<Record<CliAgent, boolean>>;
  runtimeInfo?: RuntimeInfo | null;
  slashCommands?: SlashCommand[];
  slashCommandsLoading?: boolean;
  sendMessagesWith?: SendMessagesWith;
  autoConvertLongTextEnabled?: boolean;
  focusSignal?: number;
  onFocusPane?: () => void;
  mobileBottomOffset?: number;
  /** Mobile web: composer is fixed above the action bar before the keyboard opens. */
  mobileComposerPinned?: boolean;
  // Cross-cutting thread-list mutations live in the parent useChatSession; each
  // is thread-explicit so a pane always targets its OWN thread.
  onSubmitMessage: (
    content: string,
    mode: ChatMode,
    attachments: Array<AttachmentInput & { sizeBytes?: number; isInline?: boolean }>,
    targetThreadId: string,
  ) => Promise<boolean>;
  onSetThreadMode: (threadId: string, mode: ChatMode) => Promise<void>;
  onSetThreadAgentSelection: (
    threadId: string,
    selection: UpdateChatThreadAgentSelectionInput,
  ) => Promise<void>;
  onSetThreadPermissionMode: (
    threadId: string,
    permissionMode: ChatThreadPermissionMode,
  ) => Promise<void>;
  onStopAssistantRun: (threadId: string) => Promise<void>;
  onError: (msg: string | null) => void;
  onBranchRenamed?: (worktreeId: string, newBranch: string) => void;
  onOpenReadFile?: (path: string) => void | Promise<void>;
  onAgentModelSelectorOpen?: () => void;
}

/**
 * A fully self-contained chat surface scoped to a single `threadId`. Each split
 * pane renders one instance; all per-thread derivation (timeline, gates, status,
 * composer, queued drafts) flows from {@link useThreadPaneSession}, so two panes
 * render independent conversations regardless of which one is focused.
 */
export function ChatPane({
  threadId,
  thread,
  worktreeId,
  repositoryId,
  worktreeOperational,
  worktreePath,
  providers,
  claudeModels,
  codexModels,
  cursorModels,
  opencodeModels,
  modelCatalogReadyByAgent,
  runtimeInfo,
  slashCommands,
  slashCommandsLoading,
  sendMessagesWith,
  autoConvertLongTextEnabled,
  focusSignal,
  onFocusPane,
  mobileBottomOffset = 0,
  mobileComposerPinned = false,
  onSubmitMessage,
  onSetThreadMode,
  onSetThreadAgentSelection,
  onSetThreadPermissionMode,
  onStopAssistantRun,
  onError,
  onBranchRenamed,
  onOpenReadFile,
  onAgentModelSelectorOpen,
}: ChatPaneProps) {
  const session = useThreadPaneSession(threadId, {
    thread,
    worktreeId,
    repositoryId,
    worktreeOperational,
    worktreePath,
    onSubmitMessage,
    onSetThreadMode,
    onSetThreadAgentSelection,
    onSetThreadPermissionMode,
    onStopAssistantRun,
    onError,
    onBranchRenamed,
  });

  const { gates } = session;
  const dataThreadId = isOptimisticThreadId(threadId) ? null : threadId;

  // ── Per-pane gate navigation (shared hook with main workspace chat). ──
  const permissionNav = useGateRequestNavigation(gates.pendingPermissionRequests);
  const questionNav = useGateRequestNavigation(gates.pendingQuestionRequests);
  const activePermissionRequest = permissionNav.activeRequest;
  const activePermissionIndex = permissionNav.activeIndex;
  const hasMultiplePendingPermissions = permissionNav.hasMultiple;
  const activeQuestionRequest = questionNav.activeRequest;
  const activeQuestionIndex = questionNav.activeIndex;
  const hasMultiplePendingQuestions = questionNav.hasMultiple;
  const handleShowPreviousPermission = permissionNav.showPrevious;
  const handleShowNextPermission = permissionNav.showNext;
  const handleShowPreviousQuestion = questionNav.showPrevious;
  const handleShowNextQuestion = questionNav.showNext;

  const { showPermissionGate, showQuestionGate } = deriveVisibleUserGates({
    pendingPermissionRequestCount: gates.pendingPermissionRequests.length,
    pendingQuestionRequestCount: gates.pendingQuestionRequests.length,
  });

  // ── Per-pane working/thinking derivation. ──
  const thinkingActive = useThreadThinkingActive(dataThreadId);
  const workingStatus = useMemo(
    () => deriveWorkingStatus({
      thinkingActive,
      events: session.events,
      selectedThreadUiStatus: session.threadUiStatus,
      timelineItems: session.timelineItems,
    }),
    [session.events, session.threadUiStatus, session.timelineItems, thinkingActive],
  );
  const showThinkingPlaceholder = shouldShowThinkingPlaceholder({
    selectedThreadUiStatus: session.threadUiStatus,
    isWaitingForUserGate: gates.isWaitingForUserGate,
    timelineItems: session.timelineItems,
    workingStatus,
  });

  const composerWorktreePath = worktreeOperational ? worktreePath : null;
  const mobileChatViewportInset = resolveMobileChatViewportInset({
    mobileComposerPinned,
    mobileBottomOffset,
    isWaitingForUserGate: gates.isWaitingForUserGate,
  });
  const mobileGateSurfaceStyle = resolveMobileGateSurfaceStyle(mobileBottomOffset);
  const mobileChatContentScrollPadding = resolveMobileChatContentScrollPadding({
    mobileComposerPinned,
  });

  const permissionGateSection = showPermissionGate ? (
        <section
          className="mx-auto w-full max-w-3xl px-3"
          data-testid="permission-prompts-container"
        >
          <div className="space-y-2">
            {hasMultiplePendingPermissions ? (
              activePermissionRequest ? (
                <Suspense fallback={null}>
                  <PermissionPromptCard
                    key={activePermissionRequest.requestId}
                    requestId={activePermissionRequest.requestId}
                    toolName={activePermissionRequest.toolName}
                    command={activePermissionRequest.command}
                    editTarget={activePermissionRequest.editTarget}
                    blockedPath={activePermissionRequest.blockedPath}
                    decisionReason={activePermissionRequest.decisionReason}
                    busy={gates.resolvingPermissionIds.has(activePermissionRequest.requestId)}
                    canAlwaysAllow={activePermissionRequest.canAlwaysAllow}
                    alwaysAllowScope={activePermissionRequest.alwaysAllowScope}
                    alwaysAllowDescription={activePermissionRequest.alwaysAllowDescription}
                    position={{
                      current: activePermissionIndex + 1,
                      total: gates.pendingPermissionRequests.length,
                    }}
                    onPrevious={handleShowPreviousPermission}
                    onNext={handleShowNextPermission}
                    onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                    onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                    onDeny={(requestId) => void gates.resolvePermission(requestId, "deny")}
                  />
                </Suspense>
              ) : null
            ) : (
              gates.pendingPermissionRequests.map((request) => (
                <Suspense fallback={null} key={request.requestId}>
                  <PermissionPromptCard
                    requestId={request.requestId}
                    toolName={request.toolName}
                    command={request.command}
                    editTarget={request.editTarget}
                    blockedPath={request.blockedPath}
                    decisionReason={request.decisionReason}
                    busy={gates.resolvingPermissionIds.has(request.requestId)}
                    canAlwaysAllow={request.canAlwaysAllow}
                    alwaysAllowScope={request.alwaysAllowScope}
                    alwaysAllowDescription={request.alwaysAllowDescription}
                    onAllowOnce={(requestId) => void gates.resolvePermission(requestId, "allow")}
                    onAllowAlways={(requestId) => void gates.resolvePermission(requestId, "allow_always")}
                    onDeny={(requestId) => void gates.resolvePermission(requestId, "deny")}
                  />
                </Suspense>
              ))
            )}
          </div>
        </section>
  ) : null;

  const questionGateSection = showQuestionGate ? (
        <section
          className="mx-auto w-full max-w-3xl px-3"
          data-testid="question-prompts-container"
        >
          <div className="space-y-2">
            {activeQuestionRequest ? (
              <Suspense fallback={null} key={activeQuestionRequest.requestId}>
                <QuestionCard
                  requestId={activeQuestionRequest.requestId}
                  agentLabel={AGENT_LABELS[session.composerAgent]}
                  questions={activeQuestionRequest.questions}
                  busy={
                    gates.answeringQuestionIds.has(activeQuestionRequest.requestId)
                    || gates.dismissingQuestionIds.has(activeQuestionRequest.requestId)
                  }
                  position={hasMultiplePendingQuestions ? {
                    current: activeQuestionIndex + 1,
                    total: gates.pendingQuestionRequests.length,
                  } : undefined}
                  onPrevious={handleShowPreviousQuestion}
                  onNext={handleShowNextQuestion}
                  onAnswer={(requestId, answers) => void gates.answerQuestion(requestId, answers)}
                  onDismiss={(requestId) => void gates.dismissQuestion(requestId)}
                />
              </Suspense>
            ) : null}
          </div>
        </section>
  ) : null;

  const planDecisionGateSection = gates.showPlanDecisionComposer ? (
        <Suspense fallback={null}>
          <PlanDecisionComposer
            busy={gates.planActionBusy}
            currentSelection={{
              agent: session.composerAgent,
              model: session.composerModel,
              modelProviderId: session.composerModelProviderId,
            }}
            threadKind={session.threadKind}
            hasMessages={session.messages.length > 0}
            providers={providers}
            claudeModels={claudeModels}
            codexModels={codexModels ?? []}
            cursorModels={cursorModels ?? []}
            opencodeModels={opencodeModels}
            modelCatalogReadyByAgent={modelCatalogReadyByAgent}
            runtimeInfo={runtimeInfo ?? null}
            onAgentModelSelectorOpen={onAgentModelSelectorOpen}
            onApprove={(selection) => void gates.handleApprovePlan(selection)}
            onRevise={(feedback) => void gates.handleRevisePlan(feedback)}
            onDismiss={() => void gates.handleDismissPlan()}
          />
        </Suspense>
  ) : null;

  const gateSpacer = !gates.showPlanDecisionComposer && gates.isWaitingForUserGate
    ? <div className="pb-2 pt-1" />
    : null;

  const composerSection = !gates.isWaitingForUserGate ? (
        <Suspense fallback={<div className="px-3 pb-3 pt-2 text-xs text-muted-foreground">Loading composer...</div>}>
          <Composer
            attachedTop={false}
            disabled={session.composerDisabled || gates.planActionBusy}
            focusSignal={focusSignal && focusSignal > 0 ? focusSignal : undefined}
            onFocusPane={onFocusPane}
            mobileBottomOffset={mobileBottomOffset}
            sending={false}
            showStop={session.showStopAction}
            stopping={session.stoppingRun}
            threadId={threadId}
            worktreeId={worktreeId}
            mode={session.composerMode}
            modeLocked={session.composerModeLocked}
            slashCommands={slashCommands}
            slashCommandsLoading={slashCommandsLoading}
            providers={providers}
            claudeModels={claudeModels}
            codexModels={codexModels}
            cursorModels={cursorModels}
            opencodeModels={opencodeModels}
            modelCatalogReadyByAgent={modelCatalogReadyByAgent}
            runtimeInfo={runtimeInfo ?? null}
            agent={session.composerAgent}
            model={session.composerModel}
            modelProviderId={session.composerModelProviderId}
            modelOptions={session.composerModelOptions}
            modelOptionsPerModel={session.composerModelOptionsPerModel}
            threadKind={session.threadKind}
            threadRunning={session.threadUiStatus === "running"}
            permissionMode={session.composerPermissionMode}
            sendMessagesWith={sendMessagesWith}
            autoConvertLongTextEnabled={autoConvertLongTextEnabled}
            hasMessages={session.messages.length > 0}
            queuedMessages={session.queuedMessages}
            onSubmitMessage={({ content, mode, attachments }) => session.submitMessage(content, mode, attachments)}
            onQueueDraft={({ content, mode, attachments }) => session.queueDraft(content, mode, attachments)}
            onModeChange={(mode) => void session.setComposerMode(mode)}
            onStop={() => void session.stopAssistantRun()}
            onAgentSelectionChange={(selection) => void session.setComposerAgentSelection(selection)}
            onAgentModelSelectorOpen={onAgentModelSelectorOpen}
            onPermissionModeChange={(permissionMode) => void session.setComposerPermissionMode(permissionMode)}
            onUpdateQueuedMessage={(queueMessageId, content) => session.updateQueuedDraft(queueMessageId, content)}
            onDeleteQueuedMessage={(queueMessageId) => void session.deleteQueuedDraft(queueMessageId)}
            onDispatchQueuedMessage={(queueMessageId) => void session.dispatchQueuedDraft(queueMessageId)}
            onCancelQueuedMessageDispatch={(queueMessageId) => void session.cancelQueuedDraftDispatch(queueMessageId)}
          />
        </Suspense>
  ) : null;

  const inlineGateSections = (
    <>
      {permissionGateSection}
      {questionGateSection}
      {gateSpacer}
    </>
  );

  const mobileGateSurface = mobileComposerPinned && gates.isWaitingForUserGate ? (
        <div
          className={cn(
            "fixed left-0 right-0 bg-background px-1.5 pb-1 pt-0.5 shadow-[0_-10px_30px_rgba(0,0,0,0.18)] sm:px-2.5",
            MOBILE_OVERLAY_Z_CLASS,
          )}
          style={mobileGateSurfaceStyle}
          data-mobile-gate-surface="true"
        >
          {inlineGateSections}
          {planDecisionGateSection}
        </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className={cn(resolveMobileChatScrollRegionClass(mobileComposerPinned))}
          style={mobileChatViewportInset != null ? { paddingBottom: mobileChatViewportInset } : undefined}
          data-chat-scroll-region={mobileComposerPinned ? "true" : undefined}
        >
          <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading conversation...</div>}>
            <ChatMessageList
              threadId={threadId}
              items={session.timelineItems}
              emptyState={session.messageListEmptyState}
              showThinkingPlaceholder={showThinkingPlaceholder}
              workingStatus={workingStatus}
              onOpenReadFile={onOpenReadFile}
              worktreePath={composerWorktreePath}
              mobileComposerPinned={mobileComposerPinned}
              mobileBottomOffset={mobileBottomOffset}
              contentScrollPadding={mobileChatContentScrollPadding}
              footer={!mobileComposerPinned ? planDecisionGateSection : null}
            />
          </Suspense>
        </div>
      </section>

      {!mobileComposerPinned ? inlineGateSections : null}
      {mobileGateSurface}
      {composerSection}
    </div>
  );
}
