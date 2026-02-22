import type { ChatMessage as DbChatMessage, ChatThread as DbChatThread, Repository as DbRepository, Worktree as DbWorktree } from "@prisma/client";
import type { ChatMessage, ChatThread, Repository, Worktree } from "@codesymphony/shared-types";

export function mapWorktree(worktree: DbWorktree): Worktree {
  return {
    id: worktree.id,
    repositoryId: worktree.repositoryId,
    branch: worktree.branch,
    path: worktree.path,
    baseBranch: worktree.baseBranch,
    status: worktree.status,
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
    setupScript: repository.setupScript ? JSON.parse(repository.setupScript) : null,
    teardownScript: repository.teardownScript ? JSON.parse(repository.teardownScript) : null,
    createdAt: repository.createdAt.toISOString(),
    updatedAt: repository.updatedAt.toISOString(),
    worktrees: repository.worktrees.map(mapWorktree),
  };
}

export function mapChatThread(thread: DbChatThread): ChatThread {
  return {
    id: thread.id,
    worktreeId: thread.worktreeId,
    title: thread.title,
    claudeSessionId: thread.claudeSessionId,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

export function mapChatMessage(message: DbChatMessage): ChatMessage {
  return {
    id: message.id,
    threadId: message.threadId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}
