import type { PrismaClient } from "@prisma/client";
import {
  CreateChatThreadInputSchema,
  SendChatMessageInputSchema,
  type ChatEvent,
  type ChatMessage,
  type ChatThread,
  type CreateChatThreadInput,
  type SendChatMessageInput,
} from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../types";
import { mapChatMessage, mapChatThread } from "./mappers";

const AUTO_EXECUTE_DELAY_MS = 10;

async function nextMessageSeq(prisma: PrismaClient, threadId: string): Promise<number> {
  const result = await prisma.chatMessage.aggregate({
    where: { threadId },
    _max: { seq: true },
  });

  return (result._max.seq ?? -1) + 1;
}

export function createChatService(deps: RuntimeDeps) {
  const activeThreads = new Set<string>();

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
        cwd: thread.worktree.path,
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
