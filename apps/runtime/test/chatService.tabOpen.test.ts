import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";

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

function createService() {
  return createChatService({
    prisma,
    eventHub: createEventHub(prisma),
    claudeRunner: vi.fn(),
    modelProviderService: stubModelProviderService,
  });
}

async function seedWorktree() {
  const suffix = uniqueSuffix();
  const repository = await prisma.repository.create({
    data: {
      name: `tab-open-${suffix}`,
      rootPath: `/tmp/tab-open-${suffix}`,
      defaultBranch: "main",
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      repositoryId: repository.id,
      branch: "main",
      baseBranch: "main",
      path: repository.rootPath,
      status: "active",
    },
  });
  return worktree;
}

describe("chatService.setThreadTabOpen", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("defaults new threads to an open tab", async () => {
    const chatService = createService();
    const worktree = await seedWorktree();

    const thread = await chatService.createThread(worktree.id, { title: "Hello" });

    expect(thread.tabOpen).toBe(true);
  });

  it("closes the tab without deleting the thread row", async () => {
    const chatService = createService();
    const worktree = await seedWorktree();
    const thread = await chatService.createThread(worktree.id, { title: "Hello" });

    const updated = await chatService.setThreadTabOpen(thread.id, false);

    expect(updated.id).toBe(thread.id);
    expect(updated.tabOpen).toBe(false);
    const stillExists = await prisma.chatThread.findUnique({ where: { id: thread.id } });
    expect(stillExists).not.toBeNull();
  });

  it("reopens a previously closed tab", async () => {
    const chatService = createService();
    const worktree = await seedWorktree();
    const thread = await chatService.createThread(worktree.id, { title: "Hello" });

    await chatService.setThreadTabOpen(thread.id, false);
    const reopened = await chatService.setThreadTabOpen(thread.id, true);

    expect(reopened.tabOpen).toBe(true);
  });

  it("throws when the thread does not exist", async () => {
    const chatService = createService();

    await expect(chatService.setThreadTabOpen("missing", false)).rejects.toThrow();
  });
});
