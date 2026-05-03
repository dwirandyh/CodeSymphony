import { existsSync, readFileSync } from "node:fs";
import type {
  ChatAttachment as DbChatAttachment,
  ChatMessage as DbChatMessage,
  ChatQueuedAttachment as DbChatQueuedAttachment,
  ChatQueuedMessage as DbChatQueuedMessage,
  ChatThread as DbChatThread,
  Repository as DbRepository,
  Worktree as DbWorktree,
} from "@prisma/client";
import {
  SaveAutomationConfigSchema,
  type ChatAttachment,
  type ChatMessage,
  type ChatQueuedAttachment,
  type ChatQueuedMessage,
  type ChatThread,
  type Repository,
  type Worktree,
} from "@codesymphony/shared-types";

function parseSerializedJson<T>(value: string | null, parser: (input: unknown) => T): T | null {
  if (!value) {
    return null;
  }

  return parser(JSON.parse(value));
}

export function mapWorktree(worktree: DbWorktree): Worktree {
  return {
    id: worktree.id,
    repositoryId: worktree.repositoryId,
    branch: worktree.branch,
    path: worktree.path,
    baseBranch: worktree.baseBranch,
    status: worktree.status,
    lastCreateError: worktree.lastCreateError,
    lastDeleteError: worktree.lastDeleteError,
    branchRenamed: worktree.branchRenamed,
    createdAt: worktree.createdAt.toISOString(),
    updatedAt: worktree.updatedAt.toISOString(),
  };
}

export function mapRepository(repository: DbRepository & { worktrees: DbWorktree[] }): Repository {
  return {
    id: repository.id,
    name: repository.name,
    rootPath: repository.rootPath,
    defaultBranch: repository.defaultBranch,
    setupScript: parseSerializedJson(repository.setupScript, (input) => input as string[]),
    teardownScript: parseSerializedJson(repository.teardownScript, (input) => input as string[]),
    runScript: parseSerializedJson(repository.runScript, (input) => input as string[]),
    saveAutomation: parseSerializedJson(repository.saveAutomation, (input) => SaveAutomationConfigSchema.parse(input)),
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
    worktrees: repository.worktrees.map(mapWorktree),
  };
}

function normalizeChatThreadTitle(title: string): string {
  const normalized = title.trim();
  if (normalized === "New Thread" || normalized === "Main Thread" || /^Thread\s+\d+$/.test(normalized)) {
    return "New Thread";
  }
  return title;
}

export function mapChatThread(thread: DbChatThread, isActive = false): ChatThread {
  return {
    id: thread.id,
    worktreeId: thread.worktreeId,
    title: normalizeChatThreadTitle(thread.title),
    kind: thread.kind,
    permissionProfile: thread.permissionProfile,
    permissionMode: thread.permissionMode,
    mode: thread.mode,
    titleEditedManually: thread.titleEditedManually,
    agent: thread.agent,
    model: thread.model,
    modelProviderId: thread.modelProviderId,
    handoffSourceThreadId: thread.handoffSourceThreadId,
    handoffSourcePlanEventId: thread.handoffSourcePlanEventId,
    claudeSessionId: thread.claudeSessionId,
    codexSessionId: thread.codexSessionId,
    cursorSessionId: thread.cursorSessionId,
    opencodeSessionId: thread.opencodeSessionId,
    active: isActive,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function mapChatAttachment(attachment: DbChatAttachment): ChatAttachment {
  let content = attachment.content;

  if (
    content.length === 0
    && attachment.mimeType.startsWith("image/")
    && attachment.storagePath
    && existsSync(attachment.storagePath)
  ) {
    try {
      content = readFileSync(attachment.storagePath).toString("base64");
    } catch {
      content = attachment.content;
    }
  }

  return {
    id: attachment.id,
    messageId: attachment.messageId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    content,
    storagePath: attachment.storagePath,
    source: attachment.source as ChatAttachment["source"],
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function mapChatMessage(message: DbChatMessage & { attachments?: DbChatAttachment[] }): ChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    attachments: (message.attachments ?? []).map(mapChatAttachment),
    createdAt: message.createdAt.toISOString(),
  };
}

export function mapChatQueuedAttachment(attachment: DbChatQueuedAttachment): ChatQueuedAttachment {
  let content = attachment.content;

  if (
    content.length === 0
    && attachment.mimeType.startsWith("image/")
    && attachment.storagePath
    && existsSync(attachment.storagePath)
  ) {
    try {
      content = readFileSync(attachment.storagePath).toString("base64");
    } catch {
      content = attachment.content;
    }
  }

  return {
    id: attachment.id,
    queuedMessageId: attachment.queuedMessageId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    content,
    storagePath: attachment.storagePath,
    source: attachment.source as ChatQueuedAttachment["source"],
    createdAt: attachment.createdAt.toISOString(),
  };
}

export function mapChatQueuedMessage(message: DbChatQueuedMessage & { attachments?: DbChatQueuedAttachment[] }): ChatQueuedMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    content: message.content,
    mode: message.mode,
    status: message.status,
    dispatchRequestedAt: message.dispatchRequestedAt?.toISOString() ?? null,
    attachments: (message.attachments ?? []).map(mapChatQueuedAttachment),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
