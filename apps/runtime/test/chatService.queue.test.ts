import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import type { ChatEvent } from "@codesymphony/shared-types";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  await prisma.chatQueuedAttachment.deleteMany();
  await prisma.chatQueuedMessage.deleteMany();
  await prisma.chatEvent.deleteMany();
  await prisma.chatAttachment.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThread(title = "Queue test thread"): Promise<{ threadId: string }> {
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

async function waitForTerminalEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    if (events.some((event) => event.type === "chat.completed" || event.type === "chat.failed")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for terminal chat event");
}

async function waitForEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  matcher: (event: ChatEvent) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    if (events.some(matcher)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for matching event");
}

describe("chatService queue flow", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("auto-dispatches queued messages immediately when the thread is idle", async () => {
    const prompts: string[] = [];
    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onText }) => {
      prompts.push(prompt);
      await onText("Queued draft completed.");
      return {
        output: "Queued draft completed.",
        sessionId: "queue-idle-session",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.queueMessage(threadId, {
      content: "run the queued task",
      mode: "default",
    });

    await waitForTerminalEvent(chatService, threadId);

    const queued = await chatService.listQueuedMessages(threadId);
    expect(queued).toHaveLength(0);

    const userMessages = (await chatService.listMessages(threadId)).filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("run the queued task");
    expect(prompts.some((prompt) => prompt.includes("run the queued task"))).toBe(true);
  });

  it("serializes idle queued auto-dispatch across concurrent observers", async () => {
    const prompts: string[] = [];
    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onText }) => {
      prompts.push(prompt);
      await onText(`Completed queued prompt: ${prompt}`);
      return {
        output: `Completed queued prompt: ${prompt}`,
        sessionId: "queue-concurrent-observers",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await prisma.chatQueuedMessage.create({
      data: {
        threadId,
        seq: 0,
        content: "dispatch this queued draft once",
        mode: "default",
      },
    });

    const observerResults = await Promise.allSettled([
      chatService.getThreadById(threadId),
      chatService.listQueuedMessages(threadId),
      chatService.listThreadSnapshot(threadId),
      chatService.getThreadById(threadId),
      chatService.listQueuedMessages(threadId),
      chatService.listThreadSnapshot(threadId),
    ]);

    expect(observerResults.every((result) => result.status === "fulfilled")).toBe(true);

    await waitForTerminalEvent(chatService, threadId);

    const queued = await chatService.listQueuedMessages(threadId);
    expect(queued).toHaveLength(0);

    const userMessages = (await chatService.listMessages(threadId)).filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe("dispatch this queued draft once");
    expect(prompts).toHaveLength(1);
  });

  it("updates queued draft content while another run is active", async () => {
    let releaseInitialRun: (() => void) | null = null;

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, abortController }) => {
      await onText("Initial response in progress.");

      await new Promise<void>((resolve) => {
        releaseInitialRun = resolve;
        abortController?.signal.addEventListener("abort", resolve, { once: true });
      });

      if (abortController?.signal.aborted) {
        throw new Error("Aborted unexpectedly");
      }

      await onText(" Initial response completed.");
      return {
        output: "Initial response in progress. Initial response completed.",
        sessionId: "queue-update-session",
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
      content: "initial message",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "message.delta" && event.payload.delta === "Initial response in progress.",
    );

    const queuedMessage = await chatService.queueMessage(threadId, {
      content: "draft before edit",
      mode: "default",
    });

    const updated = await chatService.updateQueuedMessage(threadId, queuedMessage.id, {
      content: "draft after edit",
    });

    expect(updated.content).toBe("draft after edit");

    const queued = await chatService.listQueuedMessages(threadId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe("draft after edit");

    releaseInitialRun?.();
    await waitForTerminalEvent(chatService, threadId);
  });

  it("keeps queued drafts pending until the active response finishes, then drains them in FIFO order", async () => {
    let runCount = 0;
    let releaseInitialRun: (() => void) | null = null;

    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onText, abortController }) => {
      runCount += 1;

      if (runCount === 1) {
        await onText("Initial response in progress.");

        await new Promise<void>((resolve) => {
          releaseInitialRun = resolve;
          abortController?.signal.addEventListener("abort", resolve, { once: true });
        });

        if (abortController?.signal.aborted) {
          throw new Error("Aborted by queued dispatch");
        }

        await onText(" Initial response completed.");
        return {
          output: "Initial response in progress. Initial response completed.",
          sessionId: "queue-sequential-initial",
        };
      }

      await onText(`Completed queued prompt: ${prompt}`);
      return {
        output: `Completed queued prompt: ${prompt}`,
        sessionId: `queue-sequential-${runCount}`,
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
      content: "initial message",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "message.delta" && event.payload.delta === "Initial response in progress.",
    );

    await chatService.queueMessage(threadId, {
      content: "first queued draft",
      mode: "default",
    });
    await chatService.queueMessage(threadId, {
      content: "second queued draft",
      mode: "default",
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    let queued = await chatService.listQueuedMessages(threadId);
    expect(queued.map((message) => message.content)).toEqual([
      "first queued draft",
      "second queued draft",
    ]);

    let userMessages = (await chatService.listMessages(threadId))
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(userMessages).toEqual(["initial message"]);

    releaseInitialRun?.();

    const start = Date.now();
    while (Date.now() - start < 8000) {
      queued = await chatService.listQueuedMessages(threadId);
      userMessages = (await chatService.listMessages(threadId))
        .filter((message) => message.role === "user")
        .map((message) => message.content);

      if (queued.length === 0 && userMessages.length === 3) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(queued).toHaveLength(0);
    expect(userMessages).toEqual([
      "initial message",
      "first queued draft",
      "second queued draft",
    ]);

    const completionEvents = await chatService.listEvents(threadId);
    expect(completionEvents.some((event) => (
      event.type === "chat.completed"
      && event.payload.cancelled === true
      && event.payload.cancellationReason === "queued_message_dispatch"
    ))).toBe(false);
  });

  it("prioritizes send-now drafts ahead of FIFO queued drafts after the current tool boundary", async () => {
    let runCount = 0;
    let releaseToolBoundary: (() => void) | null = null;

    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onToolStarted, onToolFinished, abortController, onText }) => {
      runCount += 1;

      if (runCount === 1) {
        await onToolStarted({
          toolName: "Bash",
          toolUseId: "tool-1",
          parentToolUseId: null,
          command: "sleep 1",
          shell: "bash",
          isBash: true,
        });

        await new Promise<void>((resolve) => {
          releaseToolBoundary = resolve;
        });

        await onToolFinished({
          toolName: "Bash",
          summary: "Finished sleep",
          precedingToolUseIds: ["tool-1"],
          command: "sleep 1",
          shell: "bash",
          isBash: true,
        });

        await new Promise<void>((resolve) => {
          if (abortController?.signal.aborted) {
            resolve();
            return;
          }
          abortController?.signal.addEventListener("abort", () => resolve(), { once: true });
        });

        throw new Error("Aborted by queue dispatch");
      }

      await onText(`Completed: ${prompt}`);
      return {
        output: `Completed: ${prompt}`,
        sessionId: `queue-session-${runCount}`,
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
      content: "initial message",
      mode: "default",
    });

    await waitForEvent(chatService, threadId, (event) => event.type === "tool.started");

    await chatService.queueMessage(threadId, {
      content: "first queued draft",
      mode: "default",
    });
    const secondQueued = await chatService.queueMessage(threadId, {
      content: "urgent queued draft",
      mode: "default",
    });

    await chatService.requestQueuedMessageDispatch(threadId, secondQueued.id);
    releaseToolBoundary?.();

    const start = Date.now();
    while (Date.now() - start < 8000) {
      const queued = await chatService.listQueuedMessages(threadId);
      if (queued.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const userMessages = (await chatService.listMessages(threadId))
      .filter((message) => message.role === "user")
      .map((message) => message.content);

    expect(userMessages).toEqual([
      "initial message",
      "urgent queued draft",
      "first queued draft",
    ]);
  });

  it("rejects send-now while the assistant is waiting on a permission gate", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest }) => {
      await onPermissionRequest({
        requestId: "perm-1",
        toolName: "Bash",
        toolInput: { command: "echo blocked" },
        blockedPath: null,
        decisionReason: null,
        suggestions: null,
        subagentOwnerToolUseId: null,
        launcherToolUseId: null,
      });

      return {
        output: "",
        sessionId: "queue-permission-session",
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
      content: "trigger permission gate",
      mode: "default",
    });

    await waitForEvent(chatService, threadId, (event) => event.type === "permission.requested");

    const queuedMessage = await chatService.queueMessage(threadId, {
      content: "blocked send now",
      mode: "default",
    });

    await expect(chatService.requestQueuedMessageDispatch(threadId, queuedMessage.id)).rejects.toThrow(
      "Cannot dispatch queued messages while the assistant is waiting for approval or review",
    );

    await chatService.deleteQueuedMessage(threadId, queuedMessage.id);
    await chatService.stopRun(threadId);
    await waitForTerminalEvent(chatService, threadId);
  });
});
