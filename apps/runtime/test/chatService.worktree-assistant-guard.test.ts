import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import type { ChatEvent } from "@codesymphony/shared-types";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub.js";
import { createChatService } from "../src/services/chat/index.js";
import type { ClaudeRunner } from "../src/types.js";

const stubModelProviderService = {
  resolveProviderSelection: async () => null,
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

async function seedWorktreeWithThreads(): Promise<{
  worktreeId: string;
  runningThreadId: string;
  secondThreadId: string;
}> {
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

  const runningThread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title: "Running thread",
      kind: "default",
      permissionProfile: "default",
      agent: "codex",
      model: "Xai/composer-2.5",
    },
  });
  const secondThread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title: "Second thread",
      kind: "default",
      permissionProfile: "default",
      agent: "codex",
      model: "Xai/composer-2.5",
    },
  });

  return {
    worktreeId: worktree.id,
    runningThreadId: runningThread.id,
    secondThreadId: secondThread.id,
  };
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

describe("chatService multi-thread worktree concurrency", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("allows starting a second thread while another thread in the same worktree is still active", async () => {
    let releaseRunningThread: (() => void) | null = null;
    let releaseSecondThread: (() => void) | null = null;

    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onText }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Thread title");
        return { output: "Thread title", sessionId: null };
      }

      if (prompt.includes("RUNNING_THREAD_MARKER")) {
        await onText("Running");
        await new Promise<void>((resolve) => {
          releaseRunningThread = resolve;
        });
        return { output: "Running", sessionId: "session-running" };
      }

      if (prompt.includes("SECOND_THREAD_MARKER")) {
        await onText("Second");
        await new Promise<void>((resolve) => {
          releaseSecondThread = resolve;
        });
        return { output: "Second", sessionId: "session-second" };
      }

      throw new Error(`Unexpected prompt: ${prompt}`);
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });

    const { runningThreadId, secondThreadId } = await seedWorktreeWithThreads();

    const runningSend = chatService.sendMessage(runningThreadId, {
      content: "RUNNING_THREAD_MARKER",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      runningThreadId,
      (event) => event.type === "message.delta" && event.payload.role === "assistant",
    );

    const secondSend = chatService.sendMessage(secondThreadId, {
      content: "SECOND_THREAD_MARKER",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      secondThreadId,
      (event) => event.type === "message.delta" && event.payload.role === "assistant",
    );

    releaseRunningThread?.();
    releaseSecondThread?.();
    await Promise.all([runningSend, secondSend]);
  });

  it("keeps status-snapshot/timeline readable on an idle thread while a sibling thread is active", async () => {
    let releaseRunningThread: (() => void) | null = null;

    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onText }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Thread title");
        return { output: "Thread title", sessionId: null };
      }

      if (prompt.includes("RUNNING_THREAD_MARKER")) {
        await onText("Running");
        await new Promise<void>((resolve) => {
          releaseRunningThread = resolve;
        });
        return { output: "Running", sessionId: "session-running" };
      }

      throw new Error(`Unexpected prompt: ${prompt}`);
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });

    const { runningThreadId, secondThreadId } = await seedWorktreeWithThreads();

    const runningSend = chatService.sendMessage(runningThreadId, {
      content: "RUNNING_THREAD_MARKER",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      runningThreadId,
      (event) => event.type === "message.delta" && event.payload.role === "assistant",
    );

    await expect(chatService.listThreadStatusSnapshot(secondThreadId)).resolves.toMatchObject({
      status: "idle",
    });
    await expect(chatService.listThreadSnapshot(secondThreadId, { includeCollections: false }))
      .resolves.toBeTruthy();
    await expect(chatService.listQueuedMessages(secondThreadId)).resolves.toEqual([]);

    releaseRunningThread?.();
    await runningSend;
  });

  it("allows starting a second thread while the first thread is waiting on a permission gate", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, onPermissionRequest, onText }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Thread title");
        return { output: "Thread title", sessionId: null };
      }

      if (prompt.includes("PERMISSION_THREAD_MARKER")) {
        await onPermissionRequest({
          requestId: "perm-guard-1",
          toolName: "Bash",
          toolInput: { command: "echo gated" },
          blockedPath: null,
          decisionReason: null,
          suggestions: null,
          subagentOwnerToolUseId: null,
          launcherToolUseId: null,
        });
        return { output: "", sessionId: "session-gated" };
      }

      if (prompt.includes("SECOND_THREAD_MARKER")) {
        await onText("Second while gated");
        return { output: "Second while gated", sessionId: "session-second" };
      }

      throw new Error(`Unexpected prompt: ${prompt}`);
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });

    const { runningThreadId, secondThreadId } = await seedWorktreeWithThreads();

    const gatedSend = chatService.sendMessage(runningThreadId, {
      content: "PERMISSION_THREAD_MARKER",
      mode: "default",
    });

    await waitForEvent(
      chatService,
      runningThreadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-guard-1",
    );

    await expect(chatService.sendMessage(secondThreadId, {
      content: "SECOND_THREAD_MARKER",
      mode: "default",
    })).resolves.toMatchObject({
      role: "user",
    });

    await waitForTerminalEvent(chatService, secondThreadId);

    await chatService.resolvePermission(runningThreadId, {
      requestId: "perm-guard-1",
      decision: "deny",
    });
    await waitForTerminalEvent(chatService, runningThreadId);
    await gatedSend.catch(() => undefined);
  });
});
