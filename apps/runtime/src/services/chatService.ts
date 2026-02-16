import type { PrismaClient } from "@prisma/client";
import { execFile as execFileRaw } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CreateChatThreadInputSchema,
  ResolvePermissionInputSchema,
  SendChatMessageInputSchema,
  type ChatEvent,
  type ChatMessage,
  type ChatThread,
  type CreateChatThreadInput,
  type ResolvePermissionInput,
  type SendChatMessageInput,
} from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../types";
import { mapChatMessage, mapChatThread } from "./mappers";

const AUTO_EXECUTE_DELAY_MS = 10;
const MAX_DIFF_PREVIEW_CHARS = 20000;
const CLAUDE_SETTINGS_DIR = ".claude";
const CLAUDE_LOCAL_SETTINGS_FILE = "settings.local.json";
const execFile = promisify(execFileRaw);

type WorktreeStateSnapshot = {
  statusOutput: string;
  unstagedDiff: string;
  stagedDiff: string;
  changedFiles: string[];
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function persistAlwaysAllowRule(worktreePath: string, rule: string): { settingsPath: string; persisted: boolean } {
  const claudeDirPath = join(worktreePath, CLAUDE_SETTINGS_DIR);
  const settingsPath = join(claudeDirPath, CLAUDE_LOCAL_SETTINGS_FILE);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        throw new Error("settings.local.json must contain a JSON object.");
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${settingsPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const existingPermissions =
    typeof settings.permissions === "object" && settings.permissions != null && !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};

  const allow = toStringArray(existingPermissions.allow);
  const persisted = !allow.includes(rule);
  if (persisted) {
    allow.push(rule);
  }

  const nextSettings: Record<string, unknown> = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
      deny: toStringArray(existingPermissions.deny),
      ask: toStringArray(existingPermissions.ask),
    },
  };

  mkdirSync(claudeDirPath, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  return { settingsPath, persisted };
}

async function nextMessageSeq(prisma: PrismaClient, threadId: string): Promise<number> {
  const result = await prisma.chatMessage.aggregate({
    where: { threadId },
    _max: { seq: true },
  });

  return (result._max.seq ?? -1) + 1;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
  });

  return stdout.trim();
}

function parseChangedFiles(statusOutput: string): string[] {
  if (statusOutput.length === 0) {
    return [];
  }

  const files = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    if (line.length < 4) {
      continue;
    }

    const path = line.slice(3).trim();
    if (path.length > 0) {
      files.add(path);
    }
  }

  return Array.from(files);
}

async function captureWorktreeState(worktreePath: string): Promise<WorktreeStateSnapshot | null> {
  try {
    const [statusOutput, unstagedDiff, stagedDiff] = await Promise.all([
      runGit(worktreePath, ["status", "--porcelain"]),
      runGit(worktreePath, ["diff", "--no-color"]),
      runGit(worktreePath, ["diff", "--cached", "--no-color"]),
    ]);

    return {
      statusOutput,
      unstagedDiff,
      stagedDiff,
      changedFiles: parseChangedFiles(statusOutput),
    };
  } catch {
    return null;
  }
}

function buildDiffDelta(before: WorktreeStateSnapshot, after: WorktreeStateSnapshot): {
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
} | null {
  const beforeCombinedDiff = [before.unstagedDiff, before.stagedDiff].filter((part) => part.length > 0).join("\n\n");
  const afterCombinedDiff = [after.unstagedDiff, after.stagedDiff].filter((part) => part.length > 0).join("\n\n");

  if (before.statusOutput === after.statusOutput && beforeCombinedDiff === afterCombinedDiff) {
    return null;
  }

  const beforeFiles = new Set(before.changedFiles);
  const newlyChangedFiles = after.changedFiles.filter((file) => !beforeFiles.has(file));
  const changedFiles = newlyChangedFiles.length > 0 ? newlyChangedFiles : after.changedFiles;

  const diffTruncated = afterCombinedDiff.length > MAX_DIFF_PREVIEW_CHARS;
  const diff = diffTruncated
    ? `${afterCombinedDiff.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n... [diff truncated]`
    : afterCombinedDiff;

  return {
    changedFiles,
    diff,
    diffTruncated,
  };
}

export function createChatService(deps: RuntimeDeps) {
  const activeThreads = new Set<string>();
  type PermissionDecisionResult = { decision: "allow" | "deny"; message?: string };
  type PendingPermissionEntry = {
    status: "pending" | "resolved";
    promise: Promise<PermissionDecisionResult>;
    resolve?: (result: PermissionDecisionResult) => void;
    reject?: (error: Error) => void;
    result?: PermissionDecisionResult;
    toolName: string;
    command: string | null;
  };
  const pendingPermissionsByThread = new Map<string, Map<string, PendingPermissionEntry>>();

  function ensureThreadPermissionMap(threadId: string): Map<string, PendingPermissionEntry> {
    const existing = pendingPermissionsByThread.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, PendingPermissionEntry>();
    pendingPermissionsByThread.set(threadId, created);
    return created;
  }

  function rejectPendingPermissions(threadId: string, message: string): void {
    const pendingMap = pendingPermissionsByThread.get(threadId);
    if (!pendingMap) {
      return;
    }

    pendingPermissionsByThread.delete(threadId);
    for (const pending of pendingMap.values()) {
      if (pending.status !== "pending" || !pending.reject) {
        continue;
      }
      pending.reject(new Error(message));
    }
  }

  async function runAssistant(threadId: string, prompt: string): Promise<void> {
    let assistantMessageId: string | null = null;
    let fullOutput = "";

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
      if (!existsSync(worktreePath)) {
        throw new Error(`Worktree path not found: ${worktreePath}. Create a new worktree from Repository panel.`);
      }
      if (!statSync(worktreePath).isDirectory()) {
        throw new Error(`Worktree path is not a directory: ${worktreePath}. Create a new worktree from Repository panel.`);
      }

      const beforeState = await captureWorktreeState(worktreePath);

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

      const result = await deps.claudeRunner({
        prompt,
        sessionId: thread.claudeSessionId,
        cwd: worktreePath,
        onText: async (chunk) => {
          fullOutput += chunk;
          await deps.eventHub.emit(threadId, "message.delta", {
            messageId: assistantMessage.id,
            role: "assistant",
            delta: chunk,
          });
        },
        onToolStarted: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.started", payload);
        },
        onToolOutput: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.output", payload);
        },
        onToolFinished: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.finished", payload);
        },
        onPermissionRequest: async (payload) => {
          const pendingMap = ensureThreadPermissionMap(threadId);
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

      const afterState = await captureWorktreeState(thread.worktree.path);
      const diffSnapshot = beforeState && afterState ? buildDiffDelta(beforeState, afterState) : null;
      if (diffSnapshot) {
        const fileCount = diffSnapshot.changedFiles.length;
        const summary = fileCount > 0 ? `Edited ${fileCount} file${fileCount === 1 ? "" : "s"}` : "Captured worktree diff";

        await deps.eventHub.emit(threadId, "tool.finished", {
          summary,
          precedingToolUseIds: [],
          source: "worktree.diff",
          changedFiles: diffSnapshot.changedFiles,
          diff: diffSnapshot.diff,
          diffTruncated: diffSnapshot.diffTruncated,
        });
      }

      await deps.eventHub.emit(threadId, "chat.completed", {
        messageId: assistantMessage.id,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown chat error";

      if (assistantMessageId) {
        await deps.prisma.chatMessage.update({
          where: { id: assistantMessageId },
          data: {
            content: fullOutput.length > 0 ? fullOutput : `[runtime-error] ${errorMessage}`,
          },
        });
      }

      await deps.eventHub.emit(threadId, "chat.failed", {
        message: errorMessage,
      });
    } finally {
      rejectPendingPermissions(threadId, "Permission request cancelled because the chat run ended.");
      activeThreads.delete(threadId);
    }
  }

  function scheduleAssistant(threadId: string, prompt: string): void {
    setTimeout(() => {
      void runAssistant(threadId, prompt);
    }, AUTO_EXECUTE_DELAY_MS);
  }

  return {
    async listThreads(worktreeId: string): Promise<ChatThread[]> {
      const threads = await deps.prisma.chatThread.findMany({
        where: { worktreeId },
        orderBy: { updatedAt: "desc" },
      });

      return threads.map(mapChatThread);
    },

    async createThread(worktreeId: string, rawInput: unknown): Promise<ChatThread> {
      const input: CreateChatThreadInput = CreateChatThreadInputSchema.parse(rawInput ?? {});

      const worktree = await deps.prisma.worktree.findUnique({ where: { id: worktreeId } });
      if (!worktree) {
        throw new Error("Worktree not found");
      }

      const thread = await deps.prisma.chatThread.create({
        data: {
          worktreeId,
          title: input.title ?? "Main Thread",
        },
      });

      return mapChatThread(thread);
    },

    async getThreadById(threadId: string): Promise<ChatThread | null> {
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      return thread ? mapChatThread(thread) : null;
    },

    async deleteThread(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Cannot delete a thread while assistant is processing");
      }

      await deps.prisma.chatThread.delete({
        where: { id: threadId },
      });
    },

    async listMessages(threadId: string): Promise<ChatMessage[]> {
      const messages = await deps.prisma.chatMessage.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
      });

      return messages.map(mapChatMessage);
    },

    async listEvents(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
      return deps.eventHub.list(threadId, afterIdx);
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
      if (!entry || entry.status !== "pending" || !entry.resolve) {
        throw new Error("Permission request not found");
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

    async sendMessage(threadId: string, rawInput: unknown): Promise<ChatMessage> {
      const input: SendChatMessageInput = SendChatMessageInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Assistant is still processing the previous message");
      }
      activeThreads.add(threadId);

      try {
        const seq = await nextMessageSeq(deps.prisma, threadId);
        const message = await deps.prisma.chatMessage.create({
          data: {
            threadId,
            seq,
            role: "user",
            content: input.content,
          },
        });

        await deps.eventHub.emit(threadId, "message.delta", {
          messageId: message.id,
          role: "user",
          delta: input.content,
        });

        scheduleAssistant(threadId, input.content);

        return mapChatMessage(message);
      } catch (error) {
        activeThreads.delete(threadId);
        throw error;
      }
    },
  };
}
