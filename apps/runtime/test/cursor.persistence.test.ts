import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import type { ClaudeRunner } from "../src/types";

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
  getActiveProvider: async () => null,
  getProviderById: async () => null,
};

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatAttachment.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.modelProvider.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedWorktree() {
  const suffix = uniqueSuffix();
  const worktreePath = `/tmp/codesymphony-cursor-persistence-${suffix}`;
  mkdirSync(worktreePath, { recursive: true });

  const repository = await prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: `/tmp/codesymphony-root-${suffix}`,
      defaultBranch: "main",
    },
  });

  return await prisma.worktree.create({
    data: {
      repositoryId: repository.id,
      branch: "main",
      baseBranch: "main",
      path: worktreePath,
      status: "active",
    },
  });
}

describe("Cursor thread persistence", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps sane defaults for threads created without an explicit agent", async () => {
    const worktree = await seedWorktree();

    const thread = await prisma.chatThread.create({
      data: {
        worktreeId: worktree.id,
        title: "Default Thread",
        kind: "default",
        permissionProfile: "default",
      },
    });

    expect(thread.agent).toBe("claude");
    expect(thread.model).toBe("claude-sonnet-4-6");
    expect(thread.cursorSessionId).toBeNull();
  });

  it("persists Cursor selection when creating a new thread through chatService", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const worktree = await seedWorktree();

    const created = await chatService.createThread(worktree.id, {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    expect(created.agent).toBe("cursor");
    expect(created.model).toBe("default[]");
    expect(created.modelProviderId).toBeNull();

    const persisted = await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } });
    expect(persisted.agent).toBe("cursor");
    expect(persisted.model).toBe("default[]");
    expect(persisted.modelProviderId).toBeNull();
    expect(persisted.cursorSessionId).toBeNull();
  });

  it("persists and reloads cursorSessionId on the thread row", async () => {
    const worktree = await seedWorktree();
    const created = await prisma.chatThread.create({
      data: {
        worktreeId: worktree.id,
        title: "Cursor Session",
        kind: "default",
        permissionProfile: "default",
        agent: "cursor",
        model: "default[]",
        cursorSessionId: "cursor-session-99",
      },
    });

    const reloaded = await prisma.chatThread.findUniqueOrThrow({ where: { id: created.id } });
    expect(reloaded.cursorSessionId).toBe("cursor-session-99");
    expect(reloaded.agent).toBe("cursor");
    expect(reloaded.model).toBe("default[]");
  });
});
