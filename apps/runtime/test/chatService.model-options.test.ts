import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import type { ClaudeRunner, ClaudeRunnerResult } from "../src/types";

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

const stubModelProviderService = {
  resolveProviderSelection: async () => null,
};

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatAttachment.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThread() {
  const suffix = uniqueSuffix();
  const worktreePath = `/tmp/codesymphony-worktree-${suffix}`;
  mkdirSync(worktreePath, { recursive: true });

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
  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title: "Model options thread",
      permissionProfile: "default",
    },
  });

  return { thread, worktree };
}

const stubRunnerResult: ClaudeRunnerResult = {
  output: "done",
  sessionId: "test-session",
};

function createStubRunner(): ClaudeRunner {
  return vi.fn(async () => stubRunnerResult) as unknown as ClaudeRunner;
}

async function waitForCompletion(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  timeoutMs = 4000,
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    if (events.some((event) => event.type === "chat.completed" || event.type === "chat.failed")) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for completion");
}

let originalCodexHome: string | undefined;
let originalSlashCommandCacheDir: string | undefined;
let slashCommandCacheDir: string | null = null;

describe("chatService model options", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    originalCodexHome = process.env.CODEX_HOME;
    originalSlashCommandCacheDir = process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codesymphony-test-codex-home-"));
    slashCommandCacheDir = mkdtempSync(join(tmpdir(), "codesymphony-test-slash-command-cache-"));
    process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR = slashCommandCacheDir;
    await resetDatabase();
  });

  afterEach(async () => {
    process.env.CODEX_HOME = originalCodexHome;
    process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR = originalSlashCommandCacheDir;
    if (slashCommandCacheDir) {
      rmSync(slashCommandCacheDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists modelOptions on thread via updateThreadAgentSelection", async () => {
    const stubRunner = createStubRunner();
    const eventHub = createEventHub(prisma);
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: stubRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();

    const updated = await chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      modelOptions: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(updated.modelOptions).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("passes modelOptions to runner when sending a message", async () => {
    const stubRunner = createStubRunner();
    const eventHub = createEventHub(prisma);
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: stubRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      modelOptions: [
        { id: "reasoningEffort", value: "high" },
      ],
    });

    await chatService.sendMessage(thread.id, {
      content: "hello",
      mode: "default",
      attachments: [],
    });

    await waitForCompletion(chatService, thread.id);

    expect(stubRunner).toHaveBeenCalled();
    const runnerCall = (stubRunner as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runnerCall[0].modelOptions).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: false },
    ]);
  });

  it("preserves modelOptions when selection change omits them", async () => {
    const stubRunner = createStubRunner();
    const eventHub = createEventHub(prisma);
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: stubRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
    });

    // Same agent+model = selection unchanged, early return with existing data
    const updated = await chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    });

    // Debug: check what we get back
    expect(updated.modelOptions).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("returns undefined modelOptions for threads without options", async () => {
    const stubRunner = createStubRunner();
    const eventHub = createEventHub(prisma);
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: stubRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();

    const fetched = await chatService.getThreadById(thread.id);
    expect(fetched?.modelOptions).toBeUndefined();
  });

  it("ignores stale per-model composer fastMode overrides when sending a message", async () => {
    const cursorRunner = vi.fn(async ({ onText }) => {
      await onText("done");
      return stubRunnerResult;
    }) as unknown as ClaudeRunner;
    const eventHub = createEventHub(prisma);
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: createStubRunner(),
      cursorRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();
    const modelKey = "cursor::composer-2.5[fast=true]::";

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "cursor",
      model: "composer-2.5[fast=true]",
      modelProviderId: null,
      modelOptions: [],
      modelOptionsPerModel: {
        [modelKey]: [{ id: "fastMode", value: false }],
      },
    });

    await chatService.sendMessage(thread.id, {
      content: "hello",
      mode: "default",
      attachments: [],
    });

    await waitForCompletion(chatService, thread.id);

    expect(cursorRunner).toHaveBeenCalled();
    const runnerCall = (cursorRunner as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runnerCall[0].modelOptions).toBeUndefined();
  });
});
