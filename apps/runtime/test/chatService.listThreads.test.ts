import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";

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

describe("chatService.listThreads", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("marks the most recently updated idle thread as preferred", async () => {
    const suffix = uniqueSuffix();
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const repository = await prisma.repository.create({
      data: {
        name: `list-threads-${suffix}`,
        rootPath: `/tmp/list-threads-${suffix}`,
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
    await prisma.chatThread.create({
      data: {
        worktreeId: worktree.id,
        title: "Older thread",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const newerThread = await prisma.chatThread.create({
      data: {
        worktreeId: worktree.id,
        title: "Newer thread",
      },
    });

    const listedThreads = await chatService.listThreads(worktree.id);

    expect(listedThreads).toHaveLength(2);
    expect(listedThreads.filter((thread) => thread.preferred === true).map((thread) => thread.id)).toEqual([newerThread.id]);
  });
});
