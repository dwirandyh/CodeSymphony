import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  AnswerQuestionInputSchema,
  CreateChatThreadInputSchema,
  DismissQuestionInputSchema,
  PlanRevisionInputSchema,
  RenameChatThreadTitleInputSchema,
  ResolvePermissionInputSchema,
  SendChatMessageInputSchema,
  UpdateChatThreadModeInputSchema,
  UpdateChatThreadPermissionModeInputSchema,
  type AnswerQuestionInput,
  type AttachmentInput,
  type ChatEvent,
  type ChatMessage,
  type ChatMode,
  type ChatThread,
  type ChatThreadKind,
  type ChatThreadPermissionMode,
  type ChatThreadPermissionProfile,
  type ChatThreadSnapshot,
  type CreateChatThreadInput,
  type DismissQuestionInput,
  type PlanRevisionInput,
  type RenameChatThreadTitleInput,
  type ResolvePermissionInput,
  type ReviewProvider,
  type SendChatMessageInput,
  type UpdateChatThreadModeInput,
  type UpdateChatThreadPermissionModeInput,
} from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../../types.js";
import { mapChatMessage, mapChatThread } from "../mappers.js";
import { resolveReviewRemote } from "../git.js";
import type {
  ActiveModelProvider,
  PendingPermissionEntry,
  PendingPlanEntry,
  PendingQuestionEntry,
  PermissionDecisionResult,
  QuestionAnswerResult,
  WorktreeDiffDelta,
  WorktreeMutationTracker,
} from "./chatService.types.js";
import {
  buildDiffDelta,
  captureWorktreeState,
  filterChangedFilesByTargets,
  filterDiffByFiles,
  truncateDiffPreview,
} from "./gitDiffUtils.js";
import {
  mapMessages,
  buildTimelineSnapshot,
} from "./chatPaginationUtils.js";
import {
  isImageMimeType,
  buildPromptWithAttachments,
  isAbortError,
  instrumentationMessage,
  nextMessageSeq,
  persistAlwaysAllowRule,
  inferPlanDetectionSource,
} from "./chatAttachmentUtils.js";
import {
  ensureThreadPermissionMap,
  ensureThreadQuestionMap,
  rejectPendingPermissions,
  cancelPendingGateRequests,
  clearPendingGateRequestsBecauseRunEnded,
} from "./chatGateService.js";
import {
  clampThreadTitle,
  maybeAutoRenameThreadAfterFirstAssistantReply,
  maybeAutoRenameBranchAfterFirstAssistantReply,
} from "./chatNamingService.js";
import { recoverPendingPlan } from "./chatPlanService.js";
import { editTargetFromUnknownToolInput, isBashTool, isEditTool } from "../../claude/toolClassification.js";

const AUTO_EXECUTE_DELAY_MS = 10;
const MAX_DIFF_PREVIEW_CHARS = 20000;
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_DIR_NAME = ".codesymphony/attachments";
const REVIEW_THREAD_LEGACY_TITLE = "PR / MR";
const DEFAULT_THREAD_TITLE = "New Thread";
const NON_WORKTREE_DIFF_PATH_PREFIX = ".claude/plans";

function getAttachmentStorageDir(worktreeId: string, messageId: string): string {
  return join(homedir(), ATTACHMENT_DIR_NAME, worktreeId, messageId);
}

function normalizeThreadKind(kind: ChatThreadKind | undefined): ChatThreadKind {
  return kind === "review" ? "review" : "default";
}

const REVIEW_THREAD_GITHUB_TITLE = "Create Pull Request";
const REVIEW_THREAD_GITLAB_TITLE = "Create Merge Request";

type ThreadRunStatus = "scheduled" | "running" | "waiting_permission" | "waiting_question" | "waiting_plan";

type ThreadRunState = {
  status: ThreadRunStatus;
  mode: ChatMode;
  scheduledTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
};

function createWorktreeMutationTracker(): WorktreeMutationTracker {
  return {
    sawMutatingTool: false,
    sawBashTool: false,
    ownedPaths: new Set<string>(),
  };
}

function extractEditedPathFromSummary(summary: string | null | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }

  const editedMatch = /^Edited\s+(.+)$/i.exec(summary.trim());
  if (!editedMatch?.[1]) {
    return null;
  }

  const candidate = editedMatch[1].trim();
  if (/^(\d+\s+files?|files?|changes?)$/i.test(candidate)) {
    return null;
  }

  return candidate;
}

function normalizeOwnedWorktreePath(worktreePath: string, candidate: string | null | undefined): string | null {
  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedCandidate = trimmed.replace(/\\/g, "/");
  const relativePath = isAbsolute(trimmed)
    ? relative(worktreePath, resolve(trimmed)).replace(/\\/g, "/")
    : normalize(normalizedCandidate).replace(/\\/g, "/");
  const cleanPath = relativePath.replace(/^\.\/+/, "");

  if (
    cleanPath.length === 0
    || cleanPath === "."
    || cleanPath === ".."
    || cleanPath.startsWith("../")
    || cleanPath === NON_WORKTREE_DIFF_PATH_PREFIX
    || cleanPath.startsWith(`${NON_WORKTREE_DIFF_PATH_PREFIX}/`)
  ) {
    return null;
  }

  return cleanPath;
}

function trackWorktreeMutation(
  tracker: WorktreeMutationTracker,
  worktreePath: string,
  payload: {
    toolName?: string | null;
    editTarget?: string | null;
    toolInput?: Record<string, unknown> | null;
    summary?: string | null;
    isBash?: boolean;
  },
): void {
  const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
  const bashTool = payload.isBash === true || (toolName.length > 0 && isBashTool(toolName));
  if (bashTool) {
    tracker.sawMutatingTool = true;
    tracker.sawBashTool = true;
    return;
  }

  const editTool = toolName.length > 0 && isEditTool(toolName);
  const target = payload.editTarget
    ?? (editTool ? editTargetFromUnknownToolInput(toolName, payload.toolInput) ?? null : null)
    ?? extractEditedPathFromSummary(payload.summary);
  if (!editTool && !target) {
    return;
  }

  tracker.sawMutatingTool = true;
  const normalizedTarget = normalizeOwnedWorktreePath(worktreePath, target);
  if (normalizedTarget) {
    tracker.ownedPaths.add(normalizedTarget);
  }
}

function filterWorktreeDiffDelta(diffSnapshot: WorktreeDiffDelta, ownedPaths: string[]): WorktreeDiffDelta | null {
  if (ownedPaths.length === 0) {
    return diffSnapshot;
  }

  const changedFiles = filterChangedFilesByTargets(diffSnapshot.changedFiles, ownedPaths);
  const fullDiff = filterDiffByFiles(diffSnapshot.fullDiff, ownedPaths);
  if (changedFiles.length === 0 && fullDiff.length === 0) {
    return null;
  }

  const { diff, diffTruncated } = truncateDiffPreview(fullDiff);
  return {
    changedFiles,
    fullDiff,
    diff,
    diffTruncated,
  };
}

function normalizePermissionProfile(kind: ChatThreadKind): ChatThreadPermissionProfile {
  return kind === "review" ? "review_git" : "default";
}

function normalizePermissionMode(permissionMode: ChatThreadPermissionMode | undefined): ChatThreadPermissionMode {
  return permissionMode === "full_access" ? "full_access" : "default";
}

function getReviewThreadTitle(provider: ReviewProvider): string {
  if (provider === "gitlab") {
    return REVIEW_THREAD_GITLAB_TITLE;
  }
  if (provider === "github") {
    return REVIEW_THREAD_GITHUB_TITLE;
  }
  return REVIEW_THREAD_LEGACY_TITLE;
}

async function resolveReviewThreadTitle(worktreePath: string): Promise<string> {
  try {
    const { provider } = await resolveReviewRemote(worktreePath);
    return getReviewThreadTitle(provider);
  } catch {
    return REVIEW_THREAD_LEGACY_TITLE;
  }
}

function isLegacyReviewThreadTitle(title: string): boolean {
  return title.trim() === REVIEW_THREAD_LEGACY_TITLE;
}

async function requireThreadExists(deps: RuntimeDeps, threadId: string) {
  const thread = await deps.prisma.chatThread.findUnique({
    where: { id: threadId },
  });
  if (!thread) {
    throw new Error("Chat thread not found");
  }
  return thread;
}

export function createChatService(deps: RuntimeDeps) {
  const threadRuns = new Map<string, ThreadRunState>();
  const pendingPermissionsByThread = new Map<string, Map<string, PendingPermissionEntry>>();
  const pendingQuestionsByThread = new Map<string, Map<string, PendingQuestionEntry>>();
  const pendingPlanByThread = new Map<string, PendingPlanEntry>();

  function getThreadRun(threadId: string): ThreadRunState | null {
    return threadRuns.get(threadId) ?? null;
  }

  function isThreadActive(threadId: string): boolean {
    return threadRuns.has(threadId);
  }

  function setThreadRunState(threadId: string, nextState: ThreadRunState): void {
    threadRuns.set(threadId, nextState);
  }

  function clearThreadRunState(threadId: string): ThreadRunState | null {
    const existing = threadRuns.get(threadId) ?? null;
    if (existing?.scheduledTimer) {
      clearTimeout(existing.scheduledTimer);
    }
    threadRuns.delete(threadId);
    return existing;
  }

  function markThreadWaiting(threadId: string, status: Extract<ThreadRunStatus, "waiting_permission" | "waiting_question" | "waiting_plan">): void {
    const current = getThreadRun(threadId);
    if (!current) {
      return;
    }
    setThreadRunState(threadId, {
      ...current,
      status,
    });
  }

  function clearScheduledAssistantRun(threadId: string): boolean {
    const current = getThreadRun(threadId);
    if (!current?.scheduledTimer) {
      return false;
    }

    clearTimeout(current.scheduledTimer);
    setThreadRunState(threadId, {
      status: current.status,
      mode: current.mode,
      abortController: current.abortController,
    });
    deps.logService?.log("debug", "chat.lifecycle", "cleared scheduled assistant run", { threadId });
    return true;
  }

  async function emitPostCompletionMetadata(params: {
    threadId: string;
    assistantMessageId: string;
    mode: ChatMode;
    activeProvider: ActiveModelProvider | null;
    hasFileChanges: boolean;
  }): Promise<void> {
    const { threadId, assistantMessageId, mode, activeProvider, hasFileChanges } = params;

    try {
      const completedThreadTitle = await maybeAutoRenameThreadAfterFirstAssistantReply(
        deps,
        threadId,
        assistantMessageId,
        {
          model: activeProvider?.modelId,
          providerApiKey: activeProvider?.apiKey,
          providerBaseUrl: activeProvider?.baseUrl,
        },
      );
      if (completedThreadTitle) {
        try {
          await deps.eventHub.emit(threadId, "tool.finished", {
            source: "chat.thread.metadata",
            summary: "Updated thread title",
            threadTitle: completedThreadTitle,
            mode,
            precedingToolUseIds: [],
          });
        } catch (error) {
          deps.logService?.log("debug", "chat.lifecycle", "Skipped late thread title metadata emit", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!hasFileChanges) {
        return;
      }

      const completedWorktreeBranch = await maybeAutoRenameBranchAfterFirstAssistantReply(deps, threadId, assistantMessageId);
      if (completedWorktreeBranch) {
        try {
          await deps.eventHub.emit(threadId, "tool.finished", {
            source: "chat.thread.metadata",
            summary: "Updated worktree branch",
            worktreeBranch: completedWorktreeBranch,
            mode,
            precedingToolUseIds: [],
          });
        } catch (error) {
          deps.logService?.log("debug", "chat.lifecycle", "Skipped late worktree branch metadata emit", {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (postError) {
      deps.logService?.log("warn", "chat.lifecycle", "Post-completion enrichment failed", {
        threadId,
        error: postError instanceof Error ? postError.message : String(postError),
      });
    }
  }

  async function runAssistant(threadId: string, prompt: string, mode: ChatMode = "default", options?: { autoAcceptTools?: boolean }): Promise<void> {
    deps.logService?.log("debug", "chat.lifecycle", "runAssistant started", {
      threadId,
      mode,
      promptLength: prompt.length,
      autoAcceptTools: options?.autoAcceptTools ?? false,
    });
    let assistantMessageId: string | null = null;
    let fullOutput = "";
    let activeProvider: ActiveModelProvider | null = null;
    let threadWorktreePath: string | null = null;
    let completionEmitted = false;
    const abortController = new AbortController();
    setThreadRunState(threadId, {
      status: "running",
      mode,
      abortController,
    });

    const FLUSH_INTERVAL_MS = 2000;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFlushedLength = 0;

    try {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        include: {
          worktree: true,
        },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const worktreePath = thread.worktree.path;
      const threadWorktreeId = thread.worktreeId;
      threadWorktreePath = worktreePath;
      const autoAcceptTools = options?.autoAcceptTools ?? thread.permissionMode === "full_access";
      if (!existsSync(worktreePath)) {
        throw new Error(`Worktree path not found: ${worktreePath}. Create a new worktree from Repository panel.`);
      }
      if (!statSync(worktreePath).isDirectory()) {
        throw new Error(`Worktree path is not a directory: ${worktreePath}. Create a new worktree from Repository panel.`);
      }

      const beforeState = await captureWorktreeState(worktreePath);
      const worktreeMutationTracker = createWorktreeMutationTracker();

      const assistantSeq = await nextMessageSeq(deps.prisma, threadId);
      const assistantMessage = await deps.prisma.chatMessage.create({
        data: {
          threadId,
          seq: assistantSeq,
          role: "assistant",
          content: "",
        },
      });

      assistantMessageId = assistantMessage.id;

      activeProvider = await deps.modelProviderService.getActiveProvider();

      function scheduleFlush() {
        if (flushTimer !== null) return;
        flushTimer = setTimeout(async () => {
          flushTimer = null;
          if (fullOutput.length > lastFlushedLength) {
            try {
              await deps.prisma.chatMessage.update({
                where: { id: assistantMessage.id },
                data: { content: fullOutput.trim() },
              });
              lastFlushedLength = fullOutput.length;
            } catch {
              // Non-critical — final TX will retry
            }
          }
        }, FLUSH_INTERVAL_MS);
      }

      const result = await deps.claudeRunner({
        prompt,
        sessionId: thread.claudeSessionId,
        sessionWorktreePath: thread.claudeSessionId ? worktreePath : null,
        cwd: worktreePath,
        abortController,
        permissionMode: mode,
        threadPermissionMode: thread.permissionMode,
        permissionProfile: thread.permissionProfile,
        autoAcceptTools,
        model: activeProvider?.modelId || undefined,
        providerApiKey: activeProvider?.apiKey,
        providerBaseUrl: activeProvider?.baseUrl,
        onText: async (chunk) => {
          fullOutput += chunk;
          scheduleFlush();
          await deps.eventHub.emit(threadId, "message.delta", {
            messageId: assistantMessage.id,
            role: "assistant",
            delta: chunk,
            ...(mode === "plan" ? { mode: "plan" } : {}),
          });
        },
        onToolStarted: async (payload) => {
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: payload.toolName,
            editTarget: payload.editTarget ?? null,
            isBash: payload.isBash === true,
          });
          await deps.eventHub.emit(threadId, "tool.started", payload);
        },
        onToolOutput: async (payload) => {
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: payload.toolName,
          });
          await deps.eventHub.emit(threadId, "tool.output", payload);
        },
        onToolFinished: async (payload) => {
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: "toolName" in payload && typeof payload.toolName === "string" ? payload.toolName : null,
            editTarget: payload.editTarget ?? null,
            toolInput: payload.toolInput ?? null,
            summary: payload.summary,
            isBash: payload.isBash === true,
          });
          await deps.eventHub.emit(threadId, "tool.finished", payload);
        },
        onSubagentStarted: async (payload) => {
          await deps.eventHub.emit(threadId, "subagent.started", payload);
        },
        onSubagentStopped: async (payload) => {
          await deps.eventHub.emit(threadId, "subagent.finished", payload);
        },
        onToolInstrumentation: async (event) => {
          if (!deps.logService) {
            return;
          }

          const isAnomaly = event.stage === "anomaly";
          deps.logService.log(
            isAnomaly ? "warn" : "debug",
            isAnomaly ? "claude.tool.sync" : "claude.tool",
            instrumentationMessage(event),
            {
              threadId,
              worktreeId: threadWorktreeId,
              ...event,
            },
            {
              threadId,
              worktreeId: threadWorktreeId,
            },
          );
        },
        onQuestionRequest: async (payload) => {
          markThreadWaiting(threadId, "waiting_question");
          const pendingMap = ensureThreadQuestionMap(pendingQuestionsByThread, threadId);
          const existing = pendingMap.get(payload.requestId);
          if (existing) {
            return existing.promise;
          }

          const entry = {} as PendingQuestionEntry;
          entry.status = "pending";
          entry.promise = new Promise<QuestionAnswerResult>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          pendingMap.set(payload.requestId, entry);

          try {
            await deps.eventHub.emit(threadId, "question.requested", {
              requestId: payload.requestId,
              questions: payload.questions,
            });
          } catch (error) {
            pendingMap.delete(payload.requestId);
            if (pendingMap.size === 0) {
              pendingQuestionsByThread.delete(threadId);
            }
            entry.reject?.(error instanceof Error ? error : new Error("Failed to emit question.requested event"));
            throw error;
          }
          return entry.promise;
        },
        onPlanFileDetected: async (payload) => {
          markThreadWaiting(threadId, "waiting_plan");
          const source = inferPlanDetectionSource(payload.filePath, payload.source);
          pendingPlanByThread.set(threadId, {
            content: payload.content,
            filePath: payload.filePath,
          });
          await deps.eventHub.emit(threadId, "plan.created", {
            content: payload.content,
            filePath: payload.filePath,
            messageId: assistantMessage.id,
            source,
          });
        },
        onPermissionRequest: async (payload) => {
          markThreadWaiting(threadId, "waiting_permission");
          const pendingMap = ensureThreadPermissionMap(pendingPermissionsByThread, threadId);
          const existing = pendingMap.get(payload.requestId);
          if (existing) {
            if (existing.status === "resolved" && existing.result) {
              return existing.result;
            }
            return existing.promise;
          }

          const entry = {} as PendingPermissionEntry;
          entry.status = "pending";
          entry.toolName = payload.toolName;
          const command = payload.toolInput.command;
          entry.command = typeof command === "string" && command.trim().length > 0 ? command.trim() : null;
          entry.subagentOwnerToolUseId = payload.subagentOwnerToolUseId;
          entry.launcherToolUseId = payload.launcherToolUseId;
          entry.ownershipReason = payload.ownershipReason ?? null;
          entry.ownershipCandidates = payload.ownershipCandidates ?? [];
          entry.activeSubagentToolUseIds = payload.activeSubagentToolUseIds ?? [];
          entry.promise = new Promise<PermissionDecisionResult>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          pendingMap.set(payload.requestId, entry);

          try {
            await deps.eventHub.emit(threadId, "permission.requested", {
              requestId: payload.requestId,
              toolName: payload.toolName,
              toolInput: payload.toolInput,
              command: entry.command,
              blockedPath: payload.blockedPath,
              decisionReason: payload.decisionReason,
              suggestions: payload.suggestions ?? [],
              subagentOwnerToolUseId: entry.subagentOwnerToolUseId,
              launcherToolUseId: entry.launcherToolUseId,
              ownershipReason: entry.ownershipReason,
              ownershipCandidates: entry.ownershipCandidates,
              activeSubagentToolUseIds: entry.activeSubagentToolUseIds,
            });
          } catch (error) {
            pendingMap.delete(payload.requestId);
            if (pendingMap.size === 0) {
              pendingPermissionsByThread.delete(threadId);
            }
            entry.reject?.(error instanceof Error ? error : new Error("Failed to emit permission.requested event"));
            throw error;
          }
          return entry.promise;
        },
      });

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      try {
        await deps.prisma.$transaction(async (tx) => {
          await tx.chatMessage.update({
            where: { id: assistantMessage.id },
            data: {
              content: fullOutput.trim(),
            },
          });

          await tx.chatThread.update({
            where: { id: threadId },
            data: {
              claudeSessionId: result.sessionId,
            },
          });
        });
      } catch (txError) {
        deps.logService?.log("warn", "chat.persist", "Final TX failed, falling back to individual updates", {
          threadId,
          error: txError instanceof Error ? txError.message : String(txError),
        });
        try {
          await deps.prisma.chatMessage.update({
            where: { id: assistantMessage.id },
            data: { content: fullOutput.trim() },
          });
        } catch { /* incremental flush already persisted partial content */ }
        try {
          await deps.prisma.chatThread.update({
            where: { id: threadId },
            data: { claudeSessionId: result.sessionId },
          });
        } catch { /* session id is non-critical */ }
      }
      let diffSnapshot: ReturnType<typeof buildDiffDelta> | null = null;
      try {
        const afterState = threadWorktreePath ? await captureWorktreeState(threadWorktreePath) : null;
        diffSnapshot = beforeState && afterState ? buildDiffDelta(beforeState, afterState) : null;
        if (diffSnapshot) {
          const ownedPaths = Array.from(worktreeMutationTracker.ownedPaths);
          const scopedDiffSnapshot = ownedPaths.length > 0
            ? filterWorktreeDiffDelta(diffSnapshot, ownedPaths)
            : diffSnapshot;
          const shouldEmitWorktreeDiff = ownedPaths.length > 0
            ? scopedDiffSnapshot !== null
            : worktreeMutationTracker.sawBashTool;
          if (shouldEmitWorktreeDiff && scopedDiffSnapshot) {
            diffSnapshot = scopedDiffSnapshot;
            const fileCount = diffSnapshot.changedFiles.length;
            const summary = fileCount > 0
              ? `Detected worktree changes in ${fileCount} file${fileCount === 1 ? "" : "s"}`
              : "Captured worktree diff";
            await deps.eventHub.emit(threadId, "tool.finished", {
              summary,
              precedingToolUseIds: [],
              source: "worktree.diff",
              changedFiles: diffSnapshot.changedFiles,
              diff: diffSnapshot.diff,
              diffTruncated: diffSnapshot.diffTruncated,
            });
          } else {
            diffSnapshot = null;
          }
        }
      } catch (postError) {
        deps.logService?.log("warn", "chat.lifecycle", "Worktree diff enrichment failed before completion", {
          threadId,
          error: postError instanceof Error ? postError.message : String(postError),
        });
      }

      const hasFileChanges = (diffSnapshot?.changedFiles.length ?? 0) > 0;
      deps.logService?.log("debug", "chat.lifecycle", "run about to emit chat.completed", {
        threadId,
        assistantMessageId: assistantMessage.id,
        hasFileChanges,
      });
      await deps.eventHub.emit(threadId, "chat.completed", {
        messageId: assistantMessage.id,
        threadMode: mode,
      });
      completionEmitted = true;

      queueMicrotask(() => {
        void emitPostCompletionMetadata({
          threadId,
          assistantMessageId: assistantMessage.id,
          mode,
          activeProvider,
          hasFileChanges,
        });
      });
    } catch (error) {
      deps.logService?.log("error", "chat.lifecycle", "runAssistant failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      let errorMessage = error instanceof Error ? error.message : "Unknown chat error";
      const wasCancelled = abortController.signal.aborted || isAbortError(error);

      if (!wasCancelled && activeProvider) {
        errorMessage += `\n\nActive model provider: "${activeProvider.name}" (${activeProvider.modelId}) at ${activeProvider.baseUrl}.\nTry deactivating the provider in Settings → Models to verify if the issue is provider-related.`;
      }

      if (assistantMessageId) {
        await deps.prisma.chatMessage.update({
          where: { id: assistantMessageId },
          data: {
            content: wasCancelled ? fullOutput : fullOutput.length > 0 ? fullOutput : `[runtime-error] ${errorMessage}`,
          },
        });
      }

      if (wasCancelled) {
        if (!completionEmitted) {
          deps.logService?.log("debug", "chat.lifecycle", "run cancelled, emitting chat.completed(cancelled)", {
            threadId,
            assistantMessageId,
          });
          await deps.eventHub.emit(threadId, "chat.completed", {
            ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
            cancelled: true,
            threadMode: mode,
          });
        }
      } else {
        await deps.eventHub.emit(threadId, "chat.failed", {
          message: errorMessage,
          threadMode: mode,
        });
      }
    } finally {
      deps.logService?.log("debug", "chat.lifecycle", "runAssistant entering finally", {
        threadId,
      });
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const currentRun = getThreadRun(threadId);
      const shouldClearRunState = currentRun?.abortController === abortController;
      const previousRun = shouldClearRunState ? clearThreadRunState(threadId) : currentRun;
      deps.logService?.log("debug", "chat.lifecycle", "run cleanup removed scheduling + abort state", {
        threadId,
        previousStatus: previousRun?.status ?? null,
        shouldClearRunState,
      });
      if (shouldClearRunState) {
        clearPendingGateRequestsBecauseRunEnded(pendingPermissionsByThread, pendingQuestionsByThread, threadId);
      }
    }
  }

  function scheduleAssistant(threadId: string, prompt: string, mode: ChatMode = "default", options?: { autoAcceptTools?: boolean }): void {
    clearScheduledAssistantRun(threadId);
    deps.logService?.log("debug", "chat.lifecycle", "scheduling assistant run", {
      threadId,
      mode,
      delayMs: AUTO_EXECUTE_DELAY_MS,
    });
    const scheduledAt = Date.now();
    const timer = setTimeout(() => {
      const waitedMs = Date.now() - scheduledAt;
      deps.logService?.log("debug", "chat.lifecycle", "scheduled assistant run started", {
        threadId,
        mode,
        waitedMs,
      });
      void runAssistant(threadId, prompt, mode, options);
    }, AUTO_EXECUTE_DELAY_MS);
    setThreadRunState(threadId, {
      status: "scheduled",
      mode,
      scheduledTimer: timer,
    });
  }

  return {
    async listThreads(worktreeId: string): Promise<ChatThread[]> {
      const threads = await deps.prisma.chatThread.findMany({
        where: { worktreeId },
        orderBy: { createdAt: "asc" },
      });

      return threads.map((t) => mapChatThread(t, isThreadActive(t.id)));
    },

    async getLatestPrMrThread(worktreeId: string): Promise<ChatThread | null> {
      const thread = await deps.prisma.chatThread.findFirst({
        where: {
          worktreeId,
          kind: "review",
        },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ],
      });

      return thread ? mapChatThread(thread, isThreadActive(thread.id)) : null;
    },

    async getOrCreatePrMrThread(worktreeId: string, rawInput?: unknown): Promise<ChatThread> {
      const input: CreateChatThreadInput = CreateChatThreadInputSchema.parse(rawInput ?? {});
      const worktree = await deps.prisma.worktree.findUnique({ where: { id: worktreeId } });
      if (!worktree) {
        throw new Error("Worktree not found");
      }
      const permissionMode = normalizePermissionMode(input.permissionMode);

      const existingCandidates = await deps.prisma.chatThread.findMany({
        where: {
          worktreeId,
          kind: "review",
        },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ],
      });
      const existing = existingCandidates.find((thread) => thread.titleEditedManually)
        ?? existingCandidates[0]
        ?? null;

      if (existing) {
        const shouldUpgradePermissionProfile = existing.permissionProfile !== "review_git";
        const shouldUpgradeLegacyTitle = !existing.titleEditedManually && isLegacyReviewThreadTitle(existing.title);
        const shouldUpgradePermissionMode = existing.permissionMode !== permissionMode;
        if (!shouldUpgradePermissionProfile && !shouldUpgradeLegacyTitle && !shouldUpgradePermissionMode) {
          return mapChatThread(existing, isThreadActive(existing.id));
        }

        const reviewTitle = shouldUpgradeLegacyTitle ? await resolveReviewThreadTitle(worktree.path) : null;
        const shouldUpgradeTitle = reviewTitle !== null && reviewTitle !== existing.title;
        if (!shouldUpgradePermissionProfile && !shouldUpgradeTitle && !shouldUpgradePermissionMode) {
          return mapChatThread(existing, isThreadActive(existing.id));
        }

        const updated = await deps.prisma.chatThread.update({
          where: { id: existing.id },
          data: {
            ...(shouldUpgradePermissionProfile ? { permissionProfile: "review_git" } : {}),
            ...(shouldUpgradeTitle ? { title: reviewTitle } : {}),
            ...(shouldUpgradePermissionMode ? { permissionMode } : {}),
          },
        });
        return mapChatThread(updated, isThreadActive(updated.id));
      }

      const reviewTitle = await resolveReviewThreadTitle(worktree.path);
      const created = await deps.prisma.chatThread.create({
        data: {
          worktreeId,
          title: reviewTitle,
          kind: "review",
          permissionProfile: "review_git",
          permissionMode,
          mode: "default",
        },
      });

      return mapChatThread(created);
    },

    async createThread(worktreeId: string, rawInput: unknown): Promise<ChatThread> {
      const input: CreateChatThreadInput = CreateChatThreadInputSchema.parse(rawInput ?? {});

      const worktree = await deps.prisma.worktree.findUnique({ where: { id: worktreeId } });
      if (!worktree) {
        throw new Error("Worktree not found");
      }

      const kind = normalizeThreadKind(input.kind);
      const permissionProfile = normalizePermissionProfile(kind);
      const permissionMode = normalizePermissionMode(input.permissionMode);
      const reviewTitle = kind === "review" && !input.title ? await resolveReviewThreadTitle(worktree.path) : null;
      const normalizedTitle = input.title?.trim() ?? reviewTitle ?? DEFAULT_THREAD_TITLE;

      if (input.title == null) {
        const existingThread = await deps.prisma.chatThread.findFirst({
          where: {
            worktreeId,
            kind,
            title: normalizedTitle,
          },
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        });
        if (existingThread) {
          return mapChatThread(existingThread, isThreadActive(existingThread.id));
        }
      }

      const thread = await deps.prisma.chatThread.create({
        data: {
          worktreeId,
          title: normalizedTitle,
          kind,
          permissionProfile,
          permissionMode,
          mode: "default",
        },
      });

      return mapChatThread(thread);
    },

    async getThreadById(threadId: string): Promise<ChatThread | null> {
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      return thread ? mapChatThread(thread, isThreadActive(thread.id)) : null;
    },

    async renameThreadTitle(threadId: string, rawInput: unknown): Promise<ChatThread> {
      const input: RenameChatThreadTitleInput = RenameChatThreadTitleInputSchema.parse(rawInput);
      const normalizedTitle = clampThreadTitle(input.title.trim());

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const updatedThread = await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: {
          title: normalizedTitle,
          titleEditedManually: true,
        },
      });

      return mapChatThread(updatedThread, isThreadActive(updatedThread.id));
    },

    async updateThreadMode(threadId: string, rawInput: unknown): Promise<ChatThread> {
      const input: UpdateChatThreadModeInput = UpdateChatThreadModeInputSchema.parse(rawInput);
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const updatedThread = await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: {
          mode: input.mode,
        },
      });

      return mapChatThread(updatedThread, isThreadActive(updatedThread.id));
    },

    async updateThreadPermissionMode(threadId: string, rawInput: unknown): Promise<ChatThread> {
      const input: UpdateChatThreadPermissionModeInput = UpdateChatThreadPermissionModeInputSchema.parse(rawInput);
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const updatedThread = await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: {
          permissionMode: input.permissionMode,
        },
      });

      return mapChatThread(updatedThread, isThreadActive(updatedThread.id));
    },

    async deleteThread(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (isThreadActive(threadId)) {
        throw new Error("Cannot delete a thread while assistant is processing");
      }

      await deps.prisma.chatThread.delete({
        where: { id: threadId },
      });
    },

    async listMessages(threadId: string): Promise<ChatMessage[]> {
      await requireThreadExists(deps, threadId);
      const messages = await deps.prisma.chatMessage.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
        include: { attachments: true },
      });

      return messages.map(mapChatMessage);
    },

    async listEvents(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
      await requireThreadExists(deps, threadId);
      return deps.eventHub.list(threadId, afterIdx);
    },

    async listThreadSnapshot(threadId: string): Promise<ChatThreadSnapshot> {
      await requireThreadExists(deps, threadId);
      const [messageRows, eventRows] = await Promise.all([
        deps.prisma.chatMessage.findMany({
          where: { threadId },
          orderBy: { seq: "asc" },
          include: { attachments: true },
        }),
        deps.eventHub.list(threadId),
      ]);

      const messages = mapMessages(messageRows);
      const events = eventRows;

      const timeline = buildTimelineSnapshot({
        messages,
        events,
        threadId,
      });

      return {
        messages,
        events,
        timeline,
      };
    },

    async stopRun(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (!isThreadActive(threadId)) {
        throw new Error("No active assistant run for this thread");
      }

      if (cancelPendingGateRequests(pendingPermissionsByThread, pendingQuestionsByThread, threadId)) {
        return;
      }

      const cancelledScheduledRun = clearScheduledAssistantRun(threadId);
      if (cancelledScheduledRun) {
        clearThreadRunState(threadId);
        await deps.eventHub.emit(threadId, "chat.completed", {
          cancelled: true,
          threadMode: thread.mode,
        });
        return;
      }

      const abortController = getThreadRun(threadId)?.abortController;
      if (!abortController) {
        throw new Error("Assistant run is not cancellable right now");
      }

      abortController.abort();
    },

    async resolvePermission(threadId: string, rawInput: unknown): Promise<void> {
      const input: ResolvePermissionInput = ResolvePermissionInputSchema.parse(rawInput);
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        include: {
          worktree: true,
        },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const pendingMap = pendingPermissionsByThread.get(threadId);
      const entry = pendingMap?.get(input.requestId);
      if (!entry) {
        await deps.eventHub.emit(threadId, "permission.resolved", {
          requestId: input.requestId,
          decision: "deny",
          resolver: "system",
          message: "Session expired — the assistant is no longer running.",
          persisted: false,
          settingsPath: null,
          permissionRule: null,
          subagentOwnerToolUseId: null,
          launcherToolUseId: null,
          ownershipReason: null,
          ownershipCandidates: [],
          activeSubagentToolUseIds: [],
        });
        return;
      }

      if (entry.status !== "pending" || !entry.resolve) {
        return;
      }

      const denialMessage = "Tool execution denied by user.";
      const isAlwaysAllow = input.decision === "allow_always";
      const isAllow = input.decision === "allow" || isAlwaysAllow;

      let persisted = false;
      let settingsPath: string | null = null;
      let permissionRule: string | null = null;
      if (isAlwaysAllow) {
        if (!entry.command) {
          throw new Error("Always allow requires a command in the permission request.");
        }
        permissionRule = `${entry.toolName}(${entry.command}:*)`;
        const persistedResult = persistAlwaysAllowRule(thread.worktree.path, permissionRule);
        persisted = persistedResult.persisted;
        settingsPath = persistedResult.settingsPath;
      }

      const decisionMessage = input.decision === "allow"
        ? "Allowed once by user."
        : input.decision === "allow_always"
          ? "Always allowed in this workspace by user."
          : denialMessage;

      try {
        await deps.eventHub.emit(threadId, "permission.resolved", {
          requestId: input.requestId,
          decision: input.decision,
          resolver: "user",
          message: decisionMessage,
          persisted,
          settingsPath,
          permissionRule,
          subagentOwnerToolUseId: entry.subagentOwnerToolUseId,
          launcherToolUseId: entry.launcherToolUseId,
          ownershipReason: entry.ownershipReason,
          ownershipCandidates: entry.ownershipCandidates,
          activeSubagentToolUseIds: entry.activeSubagentToolUseIds,
        });
      } finally {
        const result: PermissionDecisionResult = isAllow
          ? { decision: "allow" }
          : {
            decision: "deny",
            message: denialMessage,
          };
        const resolve = entry.resolve;
        entry.status = "resolved";
        entry.result = result;
        entry.resolve = undefined;
        entry.reject = undefined;
        resolve?.(result);
      }
    },

    async answerQuestion(threadId: string, rawInput: unknown): Promise<void> {
      const input: AnswerQuestionInput = AnswerQuestionInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const pendingMap = pendingQuestionsByThread.get(threadId);
      const entry = pendingMap?.get(input.requestId);
      if (!entry || entry.status !== "pending" || !entry.resolve) {
        await deps.eventHub.emit(threadId, "question.answered", {
          requestId: input.requestId,
          answers: input.answers,
        });
        return;
      }

      try {
        await deps.eventHub.emit(threadId, "question.answered", {
          requestId: input.requestId,
          answers: input.answers,
        });
      } finally {
        const resolve = entry.resolve;
        entry.status = "resolved";
        entry.resolve = undefined;
        entry.reject = undefined;
        resolve?.({ answers: input.answers });
      }
    },

    async dismissQuestion(threadId: string, rawInput: unknown): Promise<void> {
      const input: DismissQuestionInput = DismissQuestionInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const pendingMap = pendingQuestionsByThread.get(threadId);
      const entry = pendingMap?.get(input.requestId);
      const isPending = Boolean(entry && entry.status === "pending" && entry.resolve);
      if (!isPending) {
        await deps.eventHub.emit(threadId, "question.dismissed", {
          requestId: input.requestId,
          resolver: "system",
          reason: "Session expired — the assistant is no longer waiting for this question.",
          persisted: false,
        });
        return;
      }

      const normalizedReason = input.reason?.trim();
      await deps.eventHub.emit(threadId, "question.dismissed", {
        requestId: input.requestId,
        resolver: "user",
        reason: normalizedReason && normalizedReason.length > 0 ? normalizedReason : "Question dismissed by user.",
        persisted: true,
      });

      if (!isThreadActive(threadId)) {
        return;
      }

      await this.stopRun(threadId);
    },

    async approvePlan(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      let plan = pendingPlanByThread.get(threadId);
      if (!plan) {
        plan = await recoverPendingPlan(deps.eventHub, threadId) ?? undefined;
        if (!plan) {
          throw new Error("No pending plan to approve for this thread");
        }
      }

      if (isThreadActive(threadId)) {
        throw new Error("Assistant is still processing");
      }

      pendingPlanByThread.delete(threadId);
      setThreadRunState(threadId, { status: "scheduled", mode: "default" });

      await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: { mode: "default" },
      });

      await deps.eventHub.emit(threadId, "plan.approved", {
        filePath: plan.filePath,
      });

      const executePrompt = `The user has approved the following plan. Please execute it now:\n\n${plan.content}`;
      scheduleAssistant(threadId, executePrompt, "default", { autoAcceptTools: true });
    },

    async revisePlan(threadId: string, rawInput: unknown): Promise<void> {
      const input: PlanRevisionInput = PlanRevisionInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      let plan = pendingPlanByThread.get(threadId);
      if (!plan) {
        plan = await recoverPendingPlan(deps.eventHub, threadId) ?? undefined;
        if (!plan) {
          throw new Error("No pending plan to revise for this thread");
        }
      }

      if (isThreadActive(threadId)) {
        throw new Error("Assistant is still processing");
      }

      pendingPlanByThread.delete(threadId);
      setThreadRunState(threadId, { status: "scheduled", mode: "plan" });

      await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: { mode: "plan" },
      });

      const seq = await nextMessageSeq(deps.prisma, threadId);
      const message = await deps.prisma.chatMessage.create({
        data: { threadId, seq, role: "user", content: input.feedback },
      });
      await deps.eventHub.emit(threadId, "message.delta", {
        messageId: message.id,
        role: "user",
        delta: input.feedback,
      });

      await deps.eventHub.emit(threadId, "plan.revision_requested", {
        feedback: input.feedback,
        filePath: plan.filePath,
      });

      const revisePrompt = `The user wants to revise the plan. Here is their feedback:\n\n${input.feedback}\n\nPlease update the plan accordingly.`;
      scheduleAssistant(threadId, revisePrompt, "plan");
    },

    async sendMessage(threadId: string, rawInput: unknown): Promise<ChatMessage> {
      const input: SendChatMessageInput = SendChatMessageInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        include: { worktree: true },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (input.expectedWorktreeId && input.expectedWorktreeId !== thread.worktreeId) {
        throw new Error("Selected worktree no longer matches this thread. Please retry from the active worktree.");
      }

      if (isThreadActive(threadId)) {
        deps.logService?.log("debug", "chat.lifecycle", "sendMessage rejected because thread still active", {
          threadId,
        });
        throw new Error("Assistant is still processing the previous message");
      }
      setThreadRunState(threadId, { status: "scheduled", mode: input.mode });
      deps.logService?.log("debug", "chat.lifecycle", "sendMessage marked thread active", {
        threadId,
      });

      try {
        if (thread.mode !== input.mode) {
          await deps.prisma.chatThread.update({
            where: { id: threadId },
            data: { mode: input.mode },
          });
        }

        const seq = await nextMessageSeq(deps.prisma, threadId);
        const message = await deps.prisma.chatMessage.create({
          data: {
            threadId,
            seq,
            role: "user",
            content: input.content,
          },
        });

        const attachmentRecords: Array<{ filename: string; mimeType: string; content: string; storagePath: string | null }> = [];
        const inputAttachments: AttachmentInput[] = input.attachments ?? [];
        for (const att of inputAttachments) {
          const contentBytes = isImageMimeType(att.mimeType)
            ? Buffer.from(att.content, "base64")
            : Buffer.from(att.content, "utf8");
          const sizeBytes = contentBytes.length;

          if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
            throw new Error(`Attachment "${att.filename}" exceeds 10 MB limit (${Math.round(sizeBytes / 1024 / 1024)}MB)`);
          }

          let storagePath: string | null = null;
          let dbContent = att.content;

          if (isImageMimeType(att.mimeType)) {
            const attachDir = getAttachmentStorageDir(thread.worktree.id, message.id);
            mkdirSync(attachDir, { recursive: true });
            const safeFilename = basename(att.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
            storagePath = join(attachDir, safeFilename);
            writeFileSync(storagePath, contentBytes);
            dbContent = "";
          }

          await deps.prisma.chatAttachment.create({
            data: {
              ...(att.id ? { id: att.id } : {}),
              messageId: message.id,
              filename: att.filename,
              mimeType: att.mimeType,
              sizeBytes,
              content: dbContent,
              storagePath,
              source: att.source,
            },
          });

          attachmentRecords.push({
            filename: att.filename,
            mimeType: att.mimeType,
            content: dbContent,
            storagePath,
          });
        }

        await deps.eventHub.emit(threadId, "message.delta", {
          messageId: message.id,
          role: "user",
          delta: input.content,
        });

        const prompt = buildPromptWithAttachments(input.content, attachmentRecords, {
          workspaceRoot: thread.worktree.path,
        });
        scheduleAssistant(threadId, prompt, input.mode);

        const messageWithAttachments = await deps.prisma.chatMessage.findUnique({
          where: { id: message.id },
          include: { attachments: true },
        });

        return mapChatMessage(messageWithAttachments ?? message);
      } catch (error) {
        clearThreadRunState(threadId);
        throw error;
      }
    },

    async generateCommitMessage(worktreePath: string, diff: string): Promise<string> {
      const prompt = `You are an expert developer generating a commit message based on the following git diff.
Follow the conventional commits format (e.g., feat: add feature X, fix: resolve issue Y).
Return EXACTLY ONE LINE for the commit message. Do not include any quotes around the message.
If the diff is empty or too small to understand, output something generic like "chore: update files".

Diff:
${diff.slice(0, MAX_DIFF_PREVIEW_CHARS)}
`;

      const abortController = new AbortController();
      let streamedOutput = "";

      try {
        const result = await deps.claudeRunner({
          prompt,
          sessionId: null,
          cwd: worktreePath,
          abortController,
          permissionMode: "plan",
          onText: (chunk) => {
            streamedOutput += chunk;
          },
          onToolStarted: async () => { },
          onToolOutput: async () => { },
          onToolFinished: async () => { },
          onQuestionRequest: async () => ({ answers: {} }),
          onPermissionRequest: () => ({ decision: "deny", message: "Tool use disabled for commit message generation" }),
          onPlanFileDetected: async () => { },
          onSubagentStarted: async () => { },
          onSubagentStopped: async () => { },
        });

        const raw = streamedOutput.trim().length > 0 ? streamedOutput : result.output;

        const candidate = raw.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() || "";
        const cleaned = candidate.replace(/^["'`]+/, "").replace(/["'`]+$/, "").trim();

        return cleaned || "chore: update files";
      } catch (error) {
        deps.logService?.log("warn", "chat.commit", "AI commit message generation failed", {
          worktreePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return "chore: update files";
      }
    },

    async recoverStuckThreads(): Promise<number> {
      const threads = await deps.prisma.chatThread.findMany({
        select: { id: true, mode: true },
      });

      let recoveredCount = 0;
      for (const thread of threads) {
        if (isThreadActive(thread.id)) continue;

        const events = await deps.eventHub.list(thread.id);
        if (events.length === 0) continue;

        const lastEvent = events[events.length - 1];
        if (lastEvent.type === "chat.completed" || lastEvent.type === "chat.failed") continue;

        await deps.eventHub.emit(thread.id, "chat.failed", {
          message: "Chat run interrupted by a runtime restart. You can send a new message to continue.",
          threadMode: thread.mode,
        });
        recoveredCount++;
      }

      return recoveredCount;
    },
  };
}
