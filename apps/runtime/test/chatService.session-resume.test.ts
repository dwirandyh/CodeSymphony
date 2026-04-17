import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import type { ClaudeRunner } from "../src/types";

const stubModelProviderService = {
  getActiveProvider: async () => null,
};

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./test.db";

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: TEST_DATABASE_URL,
    },
  },
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThread(title = "Stopped run thread"): Promise<{ threadId: string }> {
  const suffix = uniqueSuffix();
  const worktreePath = `/tmp/codesymphony-worktree-${suffix}`;
  const repository = await prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: `/tmp/codesymphony-root-${suffix}`,
      defaultBranch: "main",
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      repositoryId: repository.id,
      branch: "main",
      baseBranch: "main",
      path: worktreePath,
      status: "active",
    },
  });
  mkdirSync(worktreePath, { recursive: true });
  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title,
      kind: "default",
      permissionProfile: "default",
    },
  });

  return { threadId: thread.id };
}

async function waitForEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  matcher: (event: Awaited<ReturnType<typeof chatService.listEvents>>[number]) => boolean,
  timeoutMs = 4000,
): Promise<Awaited<ReturnType<typeof chatService.listEvents>>[number]> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    const matched = events.find(matcher);
    if (matched) {
      return matched;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for matching event");
}

async function waitForTerminalEventAfter(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  afterIdx: number,
  timeoutMs = 4000,
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId, afterIdx);
    const done = events.some((event) => event.type === "chat.completed" || event.type === "chat.failed");
    if (done) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for assistant completion");
}

describe("chatService early session persistence", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists an early session id on stop so the next message resumes the same Claude session", async () => {
    let runCount = 0;
    const capturedSessionIds: Array<string | null> = [];
    const claudeRunner: ClaudeRunner = vi.fn(async ({ sessionId, onSessionId, onText, abortController }) => {
      runCount += 1;

      if (runCount === 1) {
        capturedSessionIds.push(sessionId);
        await onSessionId?.("session-stop-resume");
        await onText("Partial output before stop.");

        await new Promise<void>((resolve) => {
          if (abortController?.signal.aborted) {
            resolve();
            return;
          }
          abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
        });

        throw new Error("Aborted by user.");
      }

      capturedSessionIds.push(sessionId);
      await onText("Resumed successfully.");
      return {
        output: "Resumed successfully.",
        sessionId: sessionId,
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "tolong jalankan proses lama",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) =>
        event.type === "message.delta"
        && event.payload.role === "assistant"
        && String(event.payload.delta ?? "").includes("Partial output before stop."),
    );

    await chatService.stopRun(threadId);
    const stopEvents = await waitForTerminalEventAfter(chatService, threadId, 0);
    const stopCompleted = stopEvents.find((event) => event.type === "chat.completed" && event.payload.cancelled === true);
    expect(stopCompleted).toBeDefined();

    const stoppedThread = await chatService.getThreadById(threadId);
    expect(stoppedThread?.claudeSessionId).toBe("session-stop-resume");

    const afterStopIdx = stopEvents[stopEvents.length - 1]?.idx ?? 0;
    await chatService.sendMessage(threadId, {
      content: "continue",
    });

    const continueEvents = await waitForTerminalEventAfter(chatService, threadId, afterStopIdx);
    const continueCompleted = continueEvents.find((event) => event.type === "chat.completed" && event.payload.cancelled !== true);
    expect(continueCompleted).toBeDefined();
    expect(capturedSessionIds).toEqual([null, "session-stop-resume"]);
  });

  it("marks interrupted runs as failed during startup recovery before clients hydrate thread history", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread("Interrupted run");

    await prisma.chatEvent.createMany({
      data: [
        {
          threadId,
          idx: 0,
          type: "message_delta",
          payload: {
            messageId: "msg-assistant",
            role: "assistant",
            delta: "Sedang jalan...",
          },
        },
        {
          threadId,
          idx: 1,
          type: "tool_started",
          payload: {
            toolUseId: "tool-1",
            toolName: "Bash",
          },
        },
      ],
    });

    const recoveredCount = await chatService.recoverStuckThreads();

    expect(recoveredCount).toBe(1);

    const recoveredEvents = await chatService.listEvents(threadId);
    expect(recoveredEvents.at(-1)?.type).toBe("chat.failed");
    expect(recoveredEvents.at(-1)?.payload.message).toBe(
      "Chat run interrupted by a runtime restart. You can send a new message to continue.",
    );
  });
});
