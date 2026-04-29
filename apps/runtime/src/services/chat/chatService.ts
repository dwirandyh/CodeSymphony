import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import {
  AnswerQuestionInputSchema,
  BUILTIN_CHAT_MODELS_BY_AGENT,
  CreateChatThreadInputSchema,
  DEFAULT_CHAT_MODEL_BY_AGENT,
  DismissPlanInputSchema,
  DismissQuestionInputSchema,
  PlanRevisionInputSchema,
  QueueChatMessageInputSchema,
  RenameChatThreadTitleInputSchema,
  ResolvePermissionInputSchema,
  SendChatMessageInputSchema,
  SlashCommandCatalogSchema,
  UpdateQueuedMessageInputSchema,
  UpdateChatThreadAgentSelectionInputSchema,
  UpdateChatThreadModeInputSchema,
  UpdateChatThreadPermissionModeInputSchema,
  type AnswerQuestionInput,
  type AttachmentInput,
  type ChatEvent,
  type ChatMessage,
  type ChatQueuedMessage,
  type ChatMode,
  type ChatThread,
  type ChatThreadKind,
  type ChatThreadStatusSnapshot,
  type CliAgent,
  type ChatThreadPermissionMode,
  type ChatThreadPermissionProfile,
  type ChatThreadSnapshot,
  type CreateChatThreadInput,
  type DismissPlanInput,
  type DismissQuestionInput,
  type PlanRevisionInput,
  type QueueChatMessageInput,
  type RenameChatThreadTitleInput,
  type ResolvePermissionInput,
  type ReviewProvider,
  type SendChatMessageInput,
  type SlashCommandCatalog,
  type UpdateQueuedMessageInput,
  type UpdateChatThreadAgentSelectionInput,
  type UpdateChatThreadModeInput,
  type UpdateChatThreadPermissionModeInput,
} from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../../types.js";
import { mapChatMessage, mapChatQueuedMessage, mapChatThread } from "../mappers.js";
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
  mapEvents,
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
import { listCodexSkills, normalizeCodexSkillSlashCommandsForPrompt } from "./codexSkills.js";
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
import { deriveThreadStatusFromEvents } from "./chatThreadStatus.js";
import { editTargetFromUnknownToolInput, isBashTool, isEditTool } from "../../claude/toolClassification.js";
import { buildCodexCliProviderHint, resolveCodexCliProviderOverride } from "../../codex/config.js";
import { listCodexSlashCommands as listCodexSlashCommandsFromAppServer } from "../../codex/sessionRunner.js";
import { listCursorSlashCommands } from "../../cursor/sessionRunner.js";
import { shouldAutoApproveWorkspaceEdit } from "./workspaceEditPermissions.js";

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

function getQueuedAttachmentStorageDir(worktreeId: string, queuedMessageId: string): string {
  return join(homedir(), ATTACHMENT_DIR_NAME, worktreeId, "queued", queuedMessageId);
}

function normalizeThreadKind(kind: ChatThreadKind | undefined): ChatThreadKind {
  return kind === "review" ? "review" : "default";
}

const REVIEW_THREAD_GITHUB_TITLE = "Create Pull Request";
const REVIEW_THREAD_GITLAB_TITLE = "Create Merge Request";
const QUEUE_DISPATCH_CANCELLATION_REASON = "queued_message_dispatch" as const;

type ThreadRunStatus = "scheduled" | "running" | "waiting_permission" | "waiting_question" | "waiting_plan";
type QueuedMessageWithAttachments = Prisma.ChatQueuedMessageGetPayload<{
  include: { attachments: true };
}>;

type ThreadRunState = {
  status: ThreadRunStatus;
  mode: ChatMode;
  scheduledTimer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  activeToolUseIds: Set<string>;
  activeSubagentToolUseIds: Set<string>;
  queueHandoffPending: boolean;
  cancellationReason: "queued_message_dispatch" | null;
};

type ThreadSnapshotOptions = {
  onTiming?: (entry: ThreadSnapshotTimingEntry) => void;
};

type ThreadSnapshotTimingEntry = {
  phase: string;
  durationMs: number;
  data?: Record<string, unknown>;
};

function getPerfNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function roundPerfMs(value: number): number {
  return Math.round(value * 10) / 10;
}

async function timeSnapshotPhase<T>(
  options: ThreadSnapshotOptions | undefined,
  phase: string,
  data: Record<string, unknown> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const startedAtMs = getPerfNow();
  try {
    return await run();
  } finally {
    options?.onTiming?.({
      phase,
      durationMs: roundPerfMs(getPerfNow() - startedAtMs),
      ...(data ? { data } : {}),
    });
  }
}

function recordSnapshotPhase(
  options: ThreadSnapshotOptions | undefined,
  phase: string,
  startedAtMs: number,
  data?: Record<string, unknown>,
): void {
  options?.onTiming?.({
    phase,
    durationMs: roundPerfMs(getPerfNow() - startedAtMs),
    ...(data ? { data } : {}),
  });
}

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

function collectOwnedWorktreePaths(
  worktreePath: string,
  payload: {
    toolName?: string | null;
    editTarget?: string | null;
    toolInput?: Record<string, unknown> | null;
    summary?: string | null;
    isBash?: boolean;
  },
): string[] {
  const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
  const bashTool = payload.isBash === true || (toolName.length > 0 && isBashTool(toolName));
  if (bashTool) {
    return [];
  }

  const editTool = toolName.length > 0 && isEditTool(toolName);
  const target = payload.editTarget
    ?? (editTool ? editTargetFromUnknownToolInput(toolName, payload.toolInput) ?? null : null)
    ?? extractEditedPathFromSummary(payload.summary);
  const normalizedTarget = normalizeOwnedWorktreePath(worktreePath, target);

  return normalizedTarget ? [normalizedTarget] : [];
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

  const ownedPaths = collectOwnedWorktreePaths(worktreePath, payload);
  const editTool = toolName.length > 0 && isEditTool(toolName);
  if (!editTool && ownedPaths.length === 0) {
    return;
  }

  tracker.sawMutatingTool = true;
  for (const ownedPath of ownedPaths) {
    tracker.ownedPaths.add(ownedPath);
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

function mergeSlashCommands(...catalogs: ReadonlyArray<ReadonlyArray<{ name: string; description: string; argumentHint: string }>>): Array<{
  name: string;
  description: string;
  argumentHint: string;
}> {
  const merged = new Map<string, { name: string; description: string; argumentHint: string }>();

  for (const catalog of catalogs) {
    for (const command of catalog) {
      const name = command.name.trim();
      if (!name) {
        continue;
      }

      const key = name.toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          name,
          description: command.description,
          argumentHint: command.argumentHint,
        });
        continue;
      }

      if (!existing.description && command.description) {
        existing.description = command.description;
      }
      if (!existing.argumentHint && command.argumentHint) {
        existing.argumentHint = command.argumentHint;
      }
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeAgent(agent: CliAgent | null | undefined): CliAgent {
  if (agent === "codex" || agent === "cursor" || agent === "opencode") {
    return agent;
  }
  return "claude";
}

function normalizeOptionalModelId(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }

  const normalized = model.trim();
  return normalized.length > 0 ? normalized : null;
}

function toRunnerOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isBuiltinModelForAgent(agent: CliAgent, model: string): boolean {
  return (BUILTIN_CHAT_MODELS_BY_AGENT[agent] as readonly string[]).includes(model);
}

function resolveDefaultModelForAgent(agent: CliAgent): string {
  if (agent === "codex") {
    const codexCliModel = resolveCodexCliProviderOverride()?.model?.trim();
    if (codexCliModel) {
      return codexCliModel;
    }
  }

  return DEFAULT_CHAT_MODEL_BY_AGENT[agent];
}

function toActiveModelProvider(provider: {
  id: string;
  agent: CliAgent;
  apiKey: string | null;
  baseUrl: string | null;
  name: string;
  modelId: string;
}): ActiveModelProvider {
  return {
    id: provider.id,
    agent: provider.agent,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    name: provider.name,
    modelId: provider.modelId,
  };
}

type ResolvedThreadSelection = {
  agent: CliAgent;
  model: string;
  modelProviderId: string | null;
  provider: ActiveModelProvider | null;
};

async function resolveThreadSelection(
  deps: RuntimeDeps,
  input: {
    agent?: CliAgent | null;
    model?: string | null;
    modelProviderId?: string | null;
    preferActiveProvider?: boolean;
  },
): Promise<ResolvedThreadSelection> {
  const agent = normalizeAgent(input.agent);
  const requestedProviderId = normalizeOptionalModelId(input.modelProviderId);
  if (requestedProviderId) {
    const provider = await deps.modelProviderService.getProviderById(requestedProviderId);
    if (!provider) {
      throw new Error("Selected model provider not found");
    }
    if (provider.agent === "cursor") {
      throw new Error("Cursor does not support custom model providers");
    }
    if (provider.agent !== agent) {
      throw new Error(`Selected model provider belongs to ${provider.agent}, not ${agent}`);
    }

    return {
      agent,
      model: provider.modelId,
      modelProviderId: provider.id,
      provider: toActiveModelProvider(provider),
    };
  }

  const explicitModel = normalizeOptionalModelId(input.model);
  if (explicitModel) {
    return {
      agent,
      model: explicitModel,
      modelProviderId: null,
      provider: null,
    };
  }

  if (input.preferActiveProvider) {
    const activeProvider = await deps.modelProviderService.getActiveProvider(agent);
    if (activeProvider) {
      return {
        agent,
        model: activeProvider.modelId,
        modelProviderId: activeProvider.id,
        provider: toActiveModelProvider(activeProvider),
      };
    }
  }

  return {
    agent,
    model: resolveDefaultModelForAgent(agent),
    modelProviderId: null,
    provider: null,
  };
}

function getRunnerForAgent(deps: RuntimeDeps, agent: CliAgent) {
  if (agent === "codex") {
    return deps.codexRunner ?? deps.claudeRunner;
  }
  if (agent === "cursor") {
    return deps.cursorRunner ?? deps.claudeRunner;
  }
  if (agent === "opencode") {
    return deps.opencodeRunner ?? deps.claudeRunner;
  }
  return deps.claudeRunner;
}

function getThreadSessionId(
  thread: {
    claudeSessionId: string | null;
    codexSessionId: string | null;
    cursorSessionId?: string | null;
    opencodeSessionId?: string | null;
  },
  agent: CliAgent,
): string | null {
  if (agent === "codex") {
    return thread.codexSessionId;
  }
  if (agent === "cursor") {
    return thread.cursorSessionId ?? null;
  }
  if (agent === "opencode") {
    return thread.opencodeSessionId ?? null;
  }
  return thread.claudeSessionId;
}

function buildSessionIdUpdate(agent: CliAgent, sessionId: string | null) {
  if (agent === "codex") {
    return { codexSessionId: sessionId };
  }
  if (agent === "cursor") {
    return { cursorSessionId: sessionId };
  }
  if (agent === "opencode") {
    return { opencodeSessionId: sessionId };
  }
  return { claudeSessionId: sessionId };
}

function buildSelectionUpdate(selection: ResolvedThreadSelection) {
  return {
    agent: selection.agent,
    model: selection.model,
    modelProviderId: selection.modelProviderId,
    claudeSessionId: null,
    codexSessionId: null,
    cursorSessionId: null,
    opencodeSessionId: null,
  };
}

function hasSameSelection(
  thread: {
    agent: CliAgent;
    model: string;
    modelProviderId: string | null;
  },
  selection: ResolvedThreadSelection,
): boolean {
  return thread.agent === selection.agent
    && thread.model === selection.model
    && thread.modelProviderId === selection.modelProviderId;
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
  const pendingThreadCreatesByKey = new Map<string, Promise<ChatThread>>();
  const queuedDispatchesByThread = new Map<string, Promise<void>>();

  function getThreadRun(threadId: string): ThreadRunState | null {
    return threadRuns.get(threadId) ?? null;
  }

  function isThreadActive(threadId: string): boolean {
    return threadRuns.has(threadId);
  }

  function setThreadRunState(
    threadId: string,
    nextState: Omit<ThreadRunState, "activeToolUseIds" | "activeSubagentToolUseIds" | "queueHandoffPending" | "cancellationReason">
    & Partial<Pick<ThreadRunState, "activeToolUseIds" | "activeSubagentToolUseIds" | "queueHandoffPending" | "cancellationReason">>,
  ): void {
    const existing = threadRuns.get(threadId);
    threadRuns.set(threadId, {
      ...nextState,
      activeToolUseIds: nextState.activeToolUseIds ?? existing?.activeToolUseIds ?? new Set<string>(),
      activeSubagentToolUseIds: nextState.activeSubagentToolUseIds ?? existing?.activeSubagentToolUseIds ?? new Set<string>(),
      queueHandoffPending: nextState.queueHandoffPending ?? existing?.queueHandoffPending ?? false,
      cancellationReason: nextState.cancellationReason ?? existing?.cancellationReason ?? null,
    });
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

  function isThreadWaitingOnGate(threadId: string): boolean {
    const status = getThreadRun(threadId)?.status;
    return status === "waiting_permission" || status === "waiting_question" || status === "waiting_plan";
  }

  function hasActiveQueueBoundary(run: ThreadRunState | null): boolean {
    if (!run) {
      return false;
    }

    return run.activeToolUseIds.size > 0 || run.activeSubagentToolUseIds.size > 0;
  }

  function cleanupStoredFile(storagePath: string | null | undefined): void {
    if (!storagePath) {
      return;
    }

    try {
      rmSync(storagePath, { force: true });
    } catch (error) {
      deps.logService?.log("warn", "chat.queue", "Failed to clean up attachment file", {
        storagePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function emitThreadWorkspaceUpdate(threadId: string): Promise<void> {
    if (!deps.workspaceEventHub) {
      return;
    }

    const thread = await deps.prisma.chatThread.findUnique({
      where: { id: threadId },
      include: {
        worktree: {
          select: {
            id: true,
            repositoryId: true,
          },
        },
      },
    });

    if (!thread) {
      return;
    }

    deps.workspaceEventHub.emit("thread.updated", {
      repositoryId: thread.worktree.repositoryId,
      worktreeId: thread.worktreeId,
      threadId,
    });
  }

  async function createQueuedMessageRecord(
    threadId: string,
    input: QueueChatMessageInput,
  ): Promise<ChatQueuedMessage> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const queuedMessage = await deps.prisma.$transaction(async (tx) => {
          const thread = await tx.chatThread.findUnique({
            where: { id: threadId },
            include: { worktree: true },
          });

          if (!thread) {
            throw new Error("Chat thread not found");
          }

          if (input.expectedWorktreeId && input.expectedWorktreeId !== thread.worktreeId) {
            throw new Error("Selected worktree no longer matches this thread. Please retry from the active worktree.");
          }

          const maxSeq = await tx.chatQueuedMessage.aggregate({
            where: { threadId },
            _max: { seq: true },
          });
          const seq = (maxSeq._max.seq ?? -1) + 1;
          const created = await tx.chatQueuedMessage.create({
            data: {
              threadId,
              seq,
              content: input.content,
              mode: input.mode,
            },
          });

          for (const attachment of input.attachments ?? []) {
            const contentBytes = isImageMimeType(attachment.mimeType)
              ? Buffer.from(attachment.content, "base64")
              : Buffer.from(attachment.content, "utf8");
            const sizeBytes = contentBytes.length;

            if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
              throw new Error(`Attachment "${attachment.filename}" exceeds 10 MB limit (${Math.round(sizeBytes / 1024 / 1024)}MB)`);
            }

            let storagePath: string | null = null;
            let dbContent = attachment.content;

            if (isImageMimeType(attachment.mimeType)) {
              const attachDir = getQueuedAttachmentStorageDir(thread.worktree.id, created.id);
              mkdirSync(attachDir, { recursive: true });
              const safeFilename = basename(attachment.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
              storagePath = join(attachDir, safeFilename);
              writeFileSync(storagePath, contentBytes);
              dbContent = "";
            }

            await tx.chatQueuedAttachment.create({
              data: {
                queuedMessageId: created.id,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                sizeBytes,
                content: dbContent,
                storagePath,
                source: attachment.source,
              },
            });
          }

          return tx.chatQueuedMessage.findUniqueOrThrow({
            where: { id: created.id },
            include: { attachments: true },
          });
        });

        return mapChatQueuedMessage(queuedMessage);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : null;
        if (code === "P2002") {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Failed to allocate queued message sequence");
  }

  async function deleteQueuedMessageRecord(threadId: string, queueMessageId: string): Promise<void> {
    const queuedMessage = await deps.prisma.chatQueuedMessage.findFirst({
      where: { id: queueMessageId, threadId },
      include: { attachments: true },
    });

    if (!queuedMessage) {
      throw new Error("Queued message not found");
    }

    await deps.prisma.chatQueuedMessage.delete({
      where: { id: queueMessageId },
    });

    for (const attachment of queuedMessage.attachments) {
      cleanupStoredFile(attachment.storagePath);
    }
  }

  async function updateQueuedMessageRecord(
    threadId: string,
    queueMessageId: string,
    rawInput: unknown,
  ): Promise<ChatQueuedMessage> {
    const input: UpdateQueuedMessageInput = UpdateQueuedMessageInputSchema.parse(rawInput);
    const queuedMessage = await deps.prisma.chatQueuedMessage.findFirst({
      where: { id: queueMessageId, threadId },
      include: { attachments: true },
    });

    if (!queuedMessage) {
      throw new Error("Queued message not found");
    }

    if (queuedMessage.status === "dispatching") {
      throw new Error("Cannot edit a queued message while it is dispatching");
    }

    if (input.content.length === 0 && queuedMessage.attachments.length === 0) {
      throw new Error("Queued message must have content or attachments");
    }

    const updated = await deps.prisma.chatQueuedMessage.update({
      where: { id: queueMessageId },
      data: { content: input.content },
      include: { attachments: true },
    });

    return mapChatQueuedMessage(updated);
  }

  async function getNextQueuedMessage(threadId: string): Promise<QueuedMessageWithAttachments | null> {
    const requested = await deps.prisma.chatQueuedMessage.findFirst({
      where: {
        threadId,
        status: { in: ["dispatch_requested", "dispatching"] },
      },
      orderBy: [
        { dispatchRequestedAt: "asc" },
        { seq: "asc" },
      ],
      include: { attachments: true },
    });

    if (requested) {
      return requested;
    }

    return deps.prisma.chatQueuedMessage.findFirst({
      where: {
        threadId,
        status: "queued",
      },
      orderBy: { seq: "asc" },
      include: { attachments: true },
    });
  }

  async function getNextQueuedHandoffCandidate(threadId: string): Promise<QueuedMessageWithAttachments | null> {
    return deps.prisma.chatQueuedMessage.findFirst({
      where: {
        threadId,
        status: { in: ["dispatch_requested", "dispatching"] },
      },
      orderBy: [
        { dispatchRequestedAt: "asc" },
        { seq: "asc" },
      ],
      include: { attachments: true },
    });
  }

  async function commitUserMessageAndScheduleAssistant(params: {
    threadId: string;
    content: string;
    mode: ChatMode;
    attachments: Array<{
      id?: string;
      filename: string;
      mimeType: string;
      content: string;
      storagePath: string | null;
      source: string;
    }>;
    queuedMessageId?: string | null;
  }): Promise<ChatMessage> {
    const thread = await deps.prisma.chatThread.findUnique({
      where: { id: params.threadId },
      include: { worktree: true },
    });

    if (!thread) {
      throw new Error("Chat thread not found");
    }

    if (thread.mode !== params.mode) {
      await deps.prisma.chatThread.update({
        where: { id: params.threadId },
        data: { mode: params.mode },
      });
    }

    let message: Awaited<ReturnType<typeof deps.prisma.chatMessage.create>> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const seq = await nextMessageSeq(deps.prisma, params.threadId);
        message = await deps.prisma.chatMessage.create({
          data: {
            threadId: params.threadId,
            seq,
            role: "user",
            content: params.content,
          },
        });
        break;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : null;
        if (code === "P2002" && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    if (!message) {
      throw new Error("Failed to create chat message");
    }

    const attachmentRecords: Array<{ filename: string; mimeType: string; content: string; storagePath: string | null }> = [];
    const queuedStoragePathsToCleanup: string[] = [];
    for (const attachment of params.attachments) {
      const imageBytes = attachment.storagePath ? readFileSync(attachment.storagePath) : null;
      const contentBytes = imageBytes ?? (
        isImageMimeType(attachment.mimeType)
          ? Buffer.from(attachment.content, "base64")
          : Buffer.from(attachment.content, "utf8")
      );
      const sizeBytes = contentBytes.length;
      let storagePath: string | null = null;
      let dbContent = attachment.content;

      if (isImageMimeType(attachment.mimeType)) {
        const attachDir = getAttachmentStorageDir(thread.worktree.id, message.id);
        mkdirSync(attachDir, { recursive: true });
        const safeFilename = basename(attachment.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        storagePath = join(attachDir, safeFilename);
        writeFileSync(storagePath, contentBytes);
        dbContent = "";
        if (attachment.storagePath) {
          queuedStoragePathsToCleanup.push(attachment.storagePath);
        }
      }

      await deps.prisma.chatAttachment.create({
        data: {
          ...(attachment.id ? { id: attachment.id } : {}),
          messageId: message.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes,
          content: dbContent,
          storagePath,
          source: attachment.source,
        },
      });

      attachmentRecords.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: dbContent,
        storagePath,
      });
    }

    if (params.queuedMessageId) {
      await deps.prisma.chatQueuedMessage.deleteMany({
        where: {
          id: params.queuedMessageId,
          threadId: params.threadId,
        },
      });
    }

    for (const storagePath of queuedStoragePathsToCleanup) {
      cleanupStoredFile(storagePath);
    }

    await deps.eventHub.emit(params.threadId, "message.delta", {
      messageId: message.id,
      role: "user",
      delta: params.content,
    });

    const normalizedContent = thread.agent === "codex" || thread.agent === "cursor"
      ? normalizeCodexSkillSlashCommandsForPrompt(params.content, listCodexSkills(thread.worktree.path))
      : params.content;
    const prompt = buildPromptWithAttachments(normalizedContent, attachmentRecords, {
      workspaceRoot: thread.worktree.path,
    });
    scheduleAssistant(params.threadId, prompt, params.mode);

    const messageWithAttachments = await deps.prisma.chatMessage.findUnique({
      where: { id: message.id },
      include: { attachments: true },
    });

    return mapChatMessage(messageWithAttachments ?? message);
  }

  async function maybeDispatchQueuedMessages(threadId: string): Promise<void> {
    const inFlight = queuedDispatchesByThread.get(threadId);
    if (inFlight) {
      return inFlight;
    }

    const dispatchPromise = (async () => {
      if (isThreadActive(threadId) || isThreadWaitingOnGate(threadId)) {
        return;
      }

      const nextQueued = await getNextQueuedMessage(threadId);
      if (!nextQueued) {
        return;
      }

      const selectedQueued = nextQueued.status === "dispatching"
        ? nextQueued
        : await deps.prisma.chatQueuedMessage.update({
          where: { id: nextQueued.id },
          data: {
            status: "dispatching",
            dispatchRequestedAt: nextQueued.status === "queued"
              ? nextQueued.dispatchRequestedAt
              : nextQueued.dispatchRequestedAt ?? new Date(),
          },
          include: { attachments: true },
        });

      await emitThreadWorkspaceUpdate(threadId);
      setThreadRunState(threadId, {
        status: "scheduled",
        mode: selectedQueued.mode,
        cancellationReason: null,
      });

      try {
        await commitUserMessageAndScheduleAssistant({
          threadId,
          content: selectedQueued.content,
          mode: selectedQueued.mode,
          attachments: selectedQueued.attachments.map((attachment) => ({
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            content: attachment.content,
            storagePath: attachment.storagePath,
            source: attachment.source,
          })),
          queuedMessageId: selectedQueued.id,
        });
        await emitThreadWorkspaceUpdate(threadId);
      } catch (error) {
        clearThreadRunState(threadId);
        await deps.prisma.chatQueuedMessage.update({
          where: { id: selectedQueued.id },
          data: {
            status: "dispatch_requested",
            dispatchRequestedAt: selectedQueued.dispatchRequestedAt ?? new Date(),
          },
        }).catch(() => {});
        await emitThreadWorkspaceUpdate(threadId);
        throw error;
      }
    })().finally(() => {
      if (queuedDispatchesByThread.get(threadId) === dispatchPromise) {
        queuedDispatchesByThread.delete(threadId);
      }
    });

    queuedDispatchesByThread.set(threadId, dispatchPromise);
    return dispatchPromise;
  }

  async function cancelCurrentRunForQueuedDispatch(threadId: string): Promise<void> {
    const thread = await deps.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: { mode: true },
    });
    if (!thread) {
      return;
    }

    const cancelledScheduledRun = clearScheduledAssistantRun(threadId);
    if (cancelledScheduledRun) {
      clearThreadRunState(threadId);
      await deps.eventHub.emit(threadId, "chat.completed", {
        cancelled: true,
        cancellationReason: QUEUE_DISPATCH_CANCELLATION_REASON,
        threadMode: thread.mode,
      });
      await maybeDispatchQueuedMessages(threadId);
      return;
    }

    const run = getThreadRun(threadId);
    if (!run?.abortController || run.abortController.signal.aborted) {
      return;
    }

    setThreadRunState(threadId, {
      ...run,
      cancellationReason: QUEUE_DISPATCH_CANCELLATION_REASON,
      queueHandoffPending: true,
    });
    run.abortController.abort();
  }

  async function maybeRequestQueuedHandoff(threadId: string): Promise<void> {
    const run = getThreadRun(threadId);
    if (!run || isThreadWaitingOnGate(threadId)) {
      return;
    }

    const nextQueued = await getNextQueuedHandoffCandidate(threadId);
    if (!nextQueued) {
      if (run.queueHandoffPending) {
        setThreadRunState(threadId, { ...run, queueHandoffPending: false });
      }
      return;
    }

    setThreadRunState(threadId, { ...run, queueHandoffPending: true });
    if (hasActiveQueueBoundary(run)) {
      return;
    }

    await cancelCurrentRunForQueuedDispatch(threadId);
  }

  async function emitPostCompletionMetadata(params: {
    threadId: string;
    assistantMessageId: string;
    mode: ChatMode;
    selection: ResolvedThreadSelection;
    hasFileChanges: boolean;
  }): Promise<void> {
    const { threadId, assistantMessageId, mode, selection, hasFileChanges } = params;
    const providerOptions = {
      agent: selection.agent,
      model: selection.model,
      providerApiKey: selection.provider?.apiKey ?? undefined,
      providerBaseUrl: selection.provider?.baseUrl ?? undefined,
    };

    try {
      const completedThreadTitle = await maybeAutoRenameThreadAfterFirstAssistantReply(
        deps,
        threadId,
        assistantMessageId,
        providerOptions,
      );
      if (completedThreadTitle) {
        try {
          await deps.eventHub.emit(threadId, "tool.finished", {
            messageId: assistantMessageId,
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

      const completedWorktreeBranch = await maybeAutoRenameBranchAfterFirstAssistantReply(
        deps,
        threadId,
        assistantMessageId,
        providerOptions,
      );
      if (completedWorktreeBranch) {
        try {
          await deps.eventHub.emit(threadId, "tool.finished", {
            messageId: assistantMessageId,
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
    let selection: ResolvedThreadSelection = {
      agent: "claude",
      model: DEFAULT_CHAT_MODEL_BY_AGENT.claude,
      modelProviderId: null,
      provider: null,
    };
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
      let diffBaselineState = beforeState;
      let runProducedFileChanges = false;

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

      selection = await resolveThreadSelection(deps, {
        agent: thread.agent,
        model: thread.model,
        modelProviderId: thread.modelProviderId,
      });
      const runner = getRunnerForAgent(deps, selection.agent);
      const currentSessionId = getThreadSessionId(thread, selection.agent);

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

      async function emitWorktreeDiffEvent(
        diffSnapshot: WorktreeDiffDelta,
        precedingToolUseIds: string[],
      ): Promise<void> {
        if (diffSnapshot.changedFiles.length > 0) {
          runProducedFileChanges = true;
        }

        const fileCount = diffSnapshot.changedFiles.length;
        const summary = fileCount > 0
          ? `Detected worktree changes in ${fileCount} file${fileCount === 1 ? "" : "s"}`
          : "Captured worktree diff";
        await deps.eventHub.emit(threadId, "tool.finished", {
          messageId: assistantMessage.id,
          summary,
          precedingToolUseIds,
          source: "worktree.diff",
          changedFiles: diffSnapshot.changedFiles,
          diff: diffSnapshot.diff,
          diffTruncated: diffSnapshot.diffTruncated,
        });
      }

      async function maybeEmitIncrementalWorktreeDiff(payload: {
        toolName?: string;
        precedingToolUseIds: string[];
        editTarget?: string;
        toolInput?: Record<string, unknown>;
        summary?: string;
        isBash?: true;
      }): Promise<void> {
        if (!threadWorktreePath || !diffBaselineState) {
          return;
        }

        const ownedPaths = collectOwnedWorktreePaths(threadWorktreePath, {
          toolName: payload.toolName ?? null,
          editTarget: payload.editTarget ?? null,
          toolInput: payload.toolInput ?? null,
          summary: payload.summary ?? null,
          isBash: payload.isBash === true,
        });
        if (ownedPaths.length === 0) {
          return;
        }

        try {
          const afterState = await captureWorktreeState(threadWorktreePath);
          if (!afterState) {
            return;
          }

          const diffSnapshot = buildDiffDelta(diffBaselineState, afterState);
          diffBaselineState = afterState;
          if (!diffSnapshot) {
            return;
          }

          const scopedDiffSnapshot = filterWorktreeDiffDelta(diffSnapshot, ownedPaths);
          if (!scopedDiffSnapshot) {
            return;
          }

          await emitWorktreeDiffEvent(scopedDiffSnapshot, payload.precedingToolUseIds);
        } catch (error) {
          deps.logService?.log("warn", "chat.lifecycle", "Incremental worktree diff enrichment failed", {
            threadId,
            toolName: payload.toolName ?? null,
            precedingToolUseIds: payload.precedingToolUseIds,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const result = await runner({
        prompt,
        sessionId: currentSessionId,
        sessionWorktreePath: currentSessionId ? worktreePath : null,
        cwd: worktreePath,
        abortController,
        onSessionId: async (nextSessionId) => {
          const previousSessionId = getThreadSessionId(thread, selection.agent);
          if (!nextSessionId || nextSessionId === previousSessionId) {
            return;
          }

          try {
            await deps.prisma.chatThread.update({
              where: { id: threadId },
              data: buildSessionIdUpdate(selection.agent, nextSessionId),
            });
            if (selection.agent === "codex") {
              thread.codexSessionId = nextSessionId;
            } else if (selection.agent === "cursor") {
              thread.cursorSessionId = nextSessionId;
            } else if (selection.agent === "opencode") {
              thread.opencodeSessionId = nextSessionId;
            } else {
              thread.claudeSessionId = nextSessionId;
            }
          } catch (error) {
            deps.logService?.log("warn", "chat.persist", "Failed to persist session id during streaming", {
              threadId,
              agent: selection.agent,
              sessionId: nextSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        permissionMode: mode,
        threadPermissionMode: thread.permissionMode,
        permissionProfile: thread.permissionProfile,
        autoAcceptTools,
        model: selection.model,
        providerApiKey: toRunnerOptional(selection.provider?.apiKey),
        providerBaseUrl: toRunnerOptional(selection.provider?.baseUrl),
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
          const currentRun = getThreadRun(threadId);
          currentRun?.activeToolUseIds.add(payload.toolUseId);
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: payload.toolName,
            editTarget: payload.editTarget ?? null,
            isBash: payload.isBash === true,
          });
          await deps.eventHub.emit(threadId, "tool.started", {
            ...payload,
            messageId: assistantMessage.id,
          });
        },
        onToolOutput: async (payload) => {
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: payload.toolName,
          });
          await deps.eventHub.emit(threadId, "tool.output", {
            ...payload,
            messageId: assistantMessage.id,
          });
        },
        onToolFinished: async (payload) => {
          const currentRun = getThreadRun(threadId);
          for (const toolUseId of payload.precedingToolUseIds) {
            currentRun?.activeToolUseIds.delete(toolUseId);
          }
          trackWorktreeMutation(worktreeMutationTracker, worktreePath, {
            toolName: "toolName" in payload && typeof payload.toolName === "string" ? payload.toolName : null,
            editTarget: payload.editTarget ?? null,
            toolInput: payload.toolInput ?? null,
            summary: payload.summary,
            isBash: payload.isBash === true,
          });
          await deps.eventHub.emit(threadId, "tool.finished", {
            ...payload,
            messageId: assistantMessage.id,
          });
          await maybeEmitIncrementalWorktreeDiff(payload);
          await maybeRequestQueuedHandoff(threadId);
        },
        onSubagentStarted: async (payload) => {
          const currentRun = getThreadRun(threadId);
          currentRun?.activeSubagentToolUseIds.add(payload.toolUseId);
          await deps.eventHub.emit(threadId, "subagent.started", {
            ...payload,
            messageId: assistantMessage.id,
          });
        },
        onSubagentStopped: async (payload) => {
          const currentRun = getThreadRun(threadId);
          currentRun?.activeSubagentToolUseIds.delete(payload.toolUseId);
          await deps.eventHub.emit(threadId, "subagent.finished", {
            ...payload,
            messageId: assistantMessage.id,
          });
          await maybeRequestQueuedHandoff(threadId);
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
          entry.assistantMessageId = assistantMessage.id;
          entry.promise = new Promise<QuestionAnswerResult>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          pendingMap.set(payload.requestId, entry);

          try {
            await deps.eventHub.emit(threadId, "question.requested", {
              messageId: assistantMessage.id,
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
          if (autoAcceptTools) {
            deps.logService?.log("debug", "chat.permission", "Auto-approved permission request for full access thread", {
              threadId,
              requestId: payload.requestId,
              toolName: payload.toolName,
              blockedPath: payload.blockedPath,
            });
            return { decision: "allow" };
          }

          if (shouldAutoApproveWorkspaceEdit({
            workspaceRoot: thread.worktree.path,
            toolName: payload.toolName,
            toolInput: payload.toolInput,
            blockedPath: payload.blockedPath,
          })) {
            deps.logService?.log("debug", "chat.permission", "Auto-approved in-workspace edit request", {
              threadId,
              requestId: payload.requestId,
              toolName: payload.toolName,
              blockedPath: payload.blockedPath,
            });
            return { decision: "allow" };
          }

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
          entry.assistantMessageId = assistantMessage.id;
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
              messageId: assistantMessage.id,
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
            data: buildSessionIdUpdate(selection.agent, result.sessionId),
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
            data: buildSessionIdUpdate(selection.agent, result.sessionId),
          });
        } catch { /* session id is non-critical */ }
      }
      let diffSnapshot: WorktreeDiffDelta | null = null;
      try {
        const afterState = threadWorktreePath ? await captureWorktreeState(threadWorktreePath) : null;
        diffSnapshot = diffBaselineState && afterState ? buildDiffDelta(diffBaselineState, afterState) : null;
        if (afterState) {
          diffBaselineState = afterState;
        }
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
            await emitWorktreeDiffEvent(diffSnapshot, []);
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

      const hasFileChanges = runProducedFileChanges || (diffSnapshot?.changedFiles.length ?? 0) > 0;
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
          selection,
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

      if (!wasCancelled && selection.provider) {
        const providerLocation = selection.provider.baseUrl ?? "default endpoint";
        errorMessage += `\n\nSelected ${selection.agent} model provider: "${selection.provider.name}" (${selection.provider.modelId}) via ${providerLocation}.\nTry switching the thread to a built-in model or deactivating the provider in Settings → Models to isolate provider issues.`;
      } else if (!wasCancelled) {
        errorMessage += `\n\nSelected ${selection.agent} model: "${selection.model}".`;
        if (selection.agent === "codex") {
          const codexCliProviderHint = buildCodexCliProviderHint();
          if (codexCliProviderHint) {
            errorMessage += `\n${codexCliProviderHint}`;
          }
        }
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
        const cancellationReason = getThreadRun(threadId)?.cancellationReason;
        if (!completionEmitted) {
          deps.logService?.log("debug", "chat.lifecycle", "run cancelled, emitting chat.completed(cancelled)", {
            threadId,
            assistantMessageId,
          });
          await deps.eventHub.emit(threadId, "chat.completed", {
            ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
            cancelled: true,
            ...(cancellationReason ? { cancellationReason } : {}),
            threadMode: mode,
          });
        }
      } else {
        await deps.eventHub.emit(threadId, "chat.failed", {
          ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
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
        await maybeDispatchQueuedMessages(threadId);
        await emitThreadWorkspaceUpdate(threadId);
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
      const selection = await resolveThreadSelection(deps, {
        agent: input.agent,
        model: input.model,
        modelProviderId: input.modelProviderId,
        preferActiveProvider: input.model == null && input.modelProviderId == null,
      });

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
        const shouldUpdateSelection = !hasSameSelection(existing, selection);
        let canUpdateSelection = false;
        if (shouldUpdateSelection && !isThreadActive(existing.id)) {
          const messageCount = await deps.prisma.chatMessage.count({
            where: { threadId: existing.id },
          });
          canUpdateSelection = messageCount === 0;
        }

        if (
          !shouldUpgradePermissionProfile
          && !shouldUpgradeLegacyTitle
          && !shouldUpgradePermissionMode
          && !canUpdateSelection
        ) {
          return mapChatThread(existing, isThreadActive(existing.id));
        }

        const reviewTitle = shouldUpgradeLegacyTitle ? await resolveReviewThreadTitle(worktree.path) : null;
        const shouldUpgradeTitle = reviewTitle !== null && reviewTitle !== existing.title;
        if (
          !shouldUpgradePermissionProfile
          && !shouldUpgradeTitle
          && !shouldUpgradePermissionMode
          && !canUpdateSelection
        ) {
          return mapChatThread(existing, isThreadActive(existing.id));
        }

        const updated = await deps.prisma.chatThread.update({
          where: { id: existing.id },
          data: {
            ...(shouldUpgradePermissionProfile ? { permissionProfile: "review_git" } : {}),
            ...(shouldUpgradeTitle ? { title: reviewTitle } : {}),
            ...(shouldUpgradePermissionMode ? { permissionMode } : {}),
            ...(canUpdateSelection ? buildSelectionUpdate(selection) : {}),
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
          ...buildSelectionUpdate(selection),
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
      const selection = await resolveThreadSelection(deps, {
        agent: input.agent,
        model: input.model,
        modelProviderId: input.modelProviderId,
        preferActiveProvider: input.model == null && input.modelProviderId == null,
      });

      const createThreadOperation = async (): Promise<ChatThread> => {
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
            if (!isThreadActive(existingThread.id) && !hasSameSelection(existingThread, selection)) {
              const messageCount = await deps.prisma.chatMessage.count({
                where: { threadId: existingThread.id },
              });
              if (messageCount === 0) {
                const updatedThread = await deps.prisma.chatThread.update({
                  where: { id: existingThread.id },
                  data: buildSelectionUpdate(selection),
                });
                return mapChatThread(updatedThread, isThreadActive(updatedThread.id));
              }
            }
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
            ...buildSelectionUpdate(selection),
          },
        });

        return mapChatThread(thread);
      };

      if (input.title != null) {
        return createThreadOperation();
      }

      const createKey = `${worktreeId}:${kind}:${normalizedTitle}:${selection.agent}:${selection.model}:${selection.modelProviderId ?? "builtin"}`;
      const existingCreate = pendingThreadCreatesByKey.get(createKey);
      if (existingCreate) {
        return existingCreate;
      }

      const createPromise = createThreadOperation().finally(() => {
        if (pendingThreadCreatesByKey.get(createKey) === createPromise) {
          pendingThreadCreatesByKey.delete(createKey);
        }
      });
      pendingThreadCreatesByKey.set(createKey, createPromise);
      return createPromise;
    },

    async getThreadById(threadId: string): Promise<ChatThread | null> {
      await maybeDispatchQueuedMessages(threadId);
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      return thread ? mapChatThread(thread, isThreadActive(thread.id)) : null;
    },

    async listSlashCommands(worktreeId: string, agent: CliAgent = "claude"): Promise<SlashCommandCatalog> {
      const worktree = await deps.prisma.worktree.findUnique({ where: { id: worktreeId } });
      if (!worktree) {
        throw new Error("Worktree not found");
      }

      if (agent === "codex") {
        try {
          return SlashCommandCatalogSchema.parse({
            commands: await listCodexSlashCommandsFromAppServer({
              cwd: worktree.path,
            }),
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          deps.logService?.log("warn", "chat.slashCommands", "failed to load codex slash commands from app-server", {
            worktreeId,
            error: error instanceof Error ? error.message : String(error),
          });

          return SlashCommandCatalogSchema.parse({
            commands: listCodexSkills(worktree.path),
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if (agent === "cursor") {
        const localSkills = listCodexSkills(worktree.path);
        try {
          return SlashCommandCatalogSchema.parse({
            commands: mergeSlashCommands(
              await listCursorSlashCommands({
                cwd: worktree.path,
              }),
              localSkills,
            ),
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          deps.logService?.log("warn", "chat.slashCommands", "failed to load cursor slash commands", {
            worktreeId,
            error: error instanceof Error ? error.message : String(error),
          });

          return SlashCommandCatalogSchema.parse({
            commands: localSkills,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      try {
        const result = await deps.claudeRunner({
          prompt: "",
          sessionId: null,
          listSlashCommandsOnly: true,
          cwd: worktree.path,
          sessionWorktreePath: worktree.path,
          onText: () => {},
          onToolStarted: () => {},
          onToolOutput: () => {},
          onToolFinished: () => {},
          onQuestionRequest: async () => ({ answers: {} }),
          onPermissionRequest: async () => ({ decision: "deny" }),
          onPlanFileDetected: () => {},
          onSubagentStarted: () => {},
          onSubagentStopped: () => {},
        });

        return SlashCommandCatalogSchema.parse({
          commands: result.slashCommands ?? [],
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        deps.logService?.log("warn", "chat.slashCommands", "failed to load slash commands", {
          worktreeId,
          error: error instanceof Error ? error.message : String(error),
        });
        return SlashCommandCatalogSchema.parse({
          commands: [],
          updatedAt: new Date().toISOString(),
        });
      }
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

    async updateThreadAgentSelection(threadId: string, rawInput: unknown): Promise<ChatThread> {
      const input: UpdateChatThreadAgentSelectionInput = UpdateChatThreadAgentSelectionInputSchema.parse(rawInput);
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (isThreadActive(threadId)) {
        throw new Error("Cannot change agent or model while assistant is processing");
      }

      const messageCount = await deps.prisma.chatMessage.count({
        where: { threadId },
      });
      if (messageCount > 0) {
        throw new Error("Cannot change agent or model after the thread has messages");
      }

      const selection = await resolveThreadSelection(deps, input);
      if (hasSameSelection(thread, selection)) {
        return mapChatThread(thread, isThreadActive(thread.id));
      }

      const updatedThread = await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: buildSelectionUpdate(selection),
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

    async listQueuedMessages(threadId: string): Promise<ChatQueuedMessage[]> {
      await maybeDispatchQueuedMessages(threadId);
      await requireThreadExists(deps, threadId);
      const queuedMessages = await deps.prisma.chatQueuedMessage.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
        include: { attachments: true },
      });

      return queuedMessages.map(mapChatQueuedMessage);
    },

    async queueMessage(threadId: string, rawInput: unknown): Promise<ChatQueuedMessage> {
      const input: QueueChatMessageInput = QueueChatMessageInputSchema.parse(rawInput);
      const queuedMessage = await createQueuedMessageRecord(threadId, input);
      await emitThreadWorkspaceUpdate(threadId);
      await maybeDispatchQueuedMessages(threadId);
      return queuedMessage;
    },

    async deleteQueuedMessage(threadId: string, queueMessageId: string): Promise<void> {
      await deleteQueuedMessageRecord(threadId, queueMessageId);
      await emitThreadWorkspaceUpdate(threadId);
    },

    async updateQueuedMessage(threadId: string, queueMessageId: string, rawInput: unknown): Promise<ChatQueuedMessage> {
      const queuedMessage = await updateQueuedMessageRecord(threadId, queueMessageId, rawInput);
      await emitThreadWorkspaceUpdate(threadId);
      return queuedMessage;
    },

    async requestQueuedMessageDispatch(threadId: string, queueMessageId: string): Promise<ChatQueuedMessage> {
      await requireThreadExists(deps, threadId);
      if (isThreadWaitingOnGate(threadId)) {
        throw new Error("Cannot dispatch queued messages while the assistant is waiting for approval or review");
      }

      const queuedMessage = await deps.prisma.chatQueuedMessage.findFirst({
        where: { id: queueMessageId, threadId },
        include: { attachments: true },
      });

      if (!queuedMessage) {
        throw new Error("Queued message not found");
      }

      const updated = queuedMessage.status === "dispatch_requested" || queuedMessage.status === "dispatching"
        ? queuedMessage
        : await deps.prisma.chatQueuedMessage.update({
          where: { id: queueMessageId },
          data: {
            status: "dispatch_requested",
            dispatchRequestedAt: new Date(),
          },
          include: { attachments: true },
        });

      await emitThreadWorkspaceUpdate(threadId);
      await maybeDispatchQueuedMessages(threadId);
      return mapChatQueuedMessage(updated);
    },

    async listEvents(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
      await requireThreadExists(deps, threadId);
      return deps.eventHub.list(threadId, afterIdx);
    },

    async listThreadSnapshot(
      threadId: string,
      options?: ThreadSnapshotOptions,
    ): Promise<ChatThreadSnapshot> {
      const snapshotStartedAtMs = getPerfNow();
      await timeSnapshotPhase(options, "queued-dispatch-check", undefined, () => maybeDispatchQueuedMessages(threadId));
      await timeSnapshotPhase(options, "thread-exists", undefined, () => requireThreadExists(deps, threadId));
      const queryStartedAtMs = getPerfNow();
      const [messageRows, eventRows] = await Promise.all([
        deps.prisma.chatMessage.findMany({
          where: { threadId },
          orderBy: { seq: "asc" },
          include: { attachments: true },
        }),
        deps.eventHub.list(threadId),
      ]);
      recordSnapshotPhase(options, "db.full-collections", queryStartedAtMs, {
        messageRows: messageRows.length,
        eventRows: eventRows.length,
      });

      const mapStartedAtMs = getPerfNow();
      const messages = mapMessages(messageRows);
      const events = eventRows;
      recordSnapshotPhase(options, "map.full-collections", mapStartedAtMs, {
        messagesCount: messages.length,
        eventsCount: events.length,
      });

      const timelineStartedAtMs = getPerfNow();
      const timeline = buildTimelineSnapshot({
        messages,
        events,
        threadId,
      });
      recordSnapshotPhase(options, "timeline.assemble", timelineStartedAtMs, {
        timelineItemsCount: timeline.timelineItems.length,
        collectionsIncluded: timeline.collectionsIncluded ?? null,
        oldestRenderableHydrationPending: timeline.summary.oldestRenderableHydrationPending,
      });
      recordSnapshotPhase(options, "snapshot.total", snapshotStartedAtMs, {
        messagesCount: messages.length,
        eventsCount: events.length,
        timelineItemsCount: timeline.timelineItems.length,
      });

      return {
        messages,
        events,
        timeline,
      };
    },

    async listThreadStatusSnapshot(threadId: string): Promise<ChatThreadStatusSnapshot> {
      await maybeDispatchQueuedMessages(threadId);
      await requireThreadExists(deps, threadId);
      const events = await deps.eventHub.list(threadId);

      return {
        status: deriveThreadStatusFromEvents(events, isThreadActive(threadId)),
        newestIdx: events.length > 0 ? events[events.length - 1]?.idx ?? null : null,
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
        await maybeDispatchQueuedMessages(threadId);
        await emitThreadWorkspaceUpdate(threadId);
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
      if (isAlwaysAllow && thread.agent === "claude") {
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
          ...(entry.assistantMessageId ? { messageId: entry.assistantMessageId } : {}),
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
      if (!entry || entry.status !== "pending" || !entry.resolve) {
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
        ...(entry.assistantMessageId ? { messageId: entry.assistantMessageId } : {}),
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

    async dismissPlan(threadId: string, rawInput: unknown): Promise<void> {
      const input: DismissPlanInput = DismissPlanInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      let plan = pendingPlanByThread.get(threadId);
      if (!plan) {
        plan = await recoverPendingPlan(deps.eventHub, threadId) ?? undefined;
        if (!plan) {
          throw new Error("No pending plan to dismiss for this thread");
        }
      }

      if (isThreadActive(threadId)) {
        throw new Error("Assistant is still processing");
      }

      pendingPlanByThread.delete(threadId);

      const normalizedReason = input.reason?.trim();
      await deps.eventHub.emit(threadId, "plan.dismissed", {
        filePath: plan.filePath,
        reason: normalizedReason && normalizedReason.length > 0 ? normalizedReason : "Plan dismissed by user.",
      });
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
        return await commitUserMessageAndScheduleAssistant({
          threadId,
          content: input.content,
          mode: input.mode,
          attachments: (input.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            content: attachment.content,
            storagePath: null,
            source: attachment.source,
          })),
        });
      } catch (error) {
        clearThreadRunState(threadId);
        throw error;
      }
    },

    async generateCommitMessage(
      worktreePath: string,
      diff: string,
      input?: {
        agent?: CliAgent | null;
        model?: string | null;
        modelProviderId?: string | null;
      },
    ): Promise<string> {
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
        const selection = await resolveThreadSelection(deps, {
          agent: input?.agent,
          model: input?.model,
          modelProviderId: input?.modelProviderId,
          preferActiveProvider: true,
        });
        const runner = getRunnerForAgent(deps, selection.agent);
        const result = await runner({
          prompt,
          sessionId: null,
          cwd: worktreePath,
          abortController,
          permissionMode: "plan",
          model: selection.model,
          providerApiKey: selection.provider?.apiKey ?? undefined,
          providerBaseUrl: selection.provider?.baseUrl ?? undefined,
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
        await maybeDispatchQueuedMessages(thread.id);
        recoveredCount++;
      }

      return recoveredCount;
    },
  };
}
