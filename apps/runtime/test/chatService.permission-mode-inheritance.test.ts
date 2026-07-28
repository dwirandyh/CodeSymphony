import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadPermissionMode } from "@codesymphony/shared-types";
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

function createChatServiceForTest() {
  return createChatService({
    prisma,
    eventHub: createEventHub(prisma),
    claudeRunner: vi.fn(),
    modelProviderService: stubModelProviderService,
  });
}

async function seedRepository() {
  const suffix = uniqueSuffix();
  return prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: `/tmp/codesymphony-root-${suffix}`,
      defaultBranch: "main",
    },
  });
}

async function seedWorktree(repositoryId: string, branch: string) {
  const worktreePath = `/tmp/codesymphony-worktree-${uniqueSuffix()}`;
  mkdirSync(worktreePath, { recursive: true });

  return prisma.worktree.create({
    data: {
      repositoryId,
      branch,
      baseBranch: "main",
      path: worktreePath,
      status: "active",
    },
  });
}

async function seedThread(params: {
  worktreeId: string;
  permissionMode: ChatThreadPermissionMode;
  title?: string;
  isAutomation?: boolean;
  updatedAt?: Date;
}) {
  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: params.worktreeId,
      title: params.title ?? `thread-${uniqueSuffix()}`,
      kind: "default",
      isAutomation: params.isAutomation ?? false,
      permissionMode: params.permissionMode,
    },
  });

  if (params.updatedAt) {
    return prisma.chatThread.update({
      where: { id: thread.id },
      data: { updatedAt: params.updatedAt },
    });
  }

  return thread;
}

describe("chatService createThread permission mode inheritance", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("inherits full_access from the most recent thread in the same worktree", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/sticky");

    await seedThread({
      worktreeId: worktree.id,
      permissionMode: "full_access",
    });

    const created = await chatService.createThread(worktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("full_access");
  });

  it("stays on default once the user switches back to default", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/reverted");

    await seedThread({
      worktreeId: worktree.id,
      permissionMode: "full_access",
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await seedThread({
      worktreeId: worktree.id,
      permissionMode: "default",
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    });

    const created = await chatService.createThread(worktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("default");
  });

  it("prefers an explicitly requested permission mode over the inherited one", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/explicit");

    await seedThread({
      worktreeId: worktree.id,
      permissionMode: "full_access",
    });

    const created = await chatService.createThread(worktree.id, {
      title: "New chat",
      permissionMode: "default",
    });

    expect(created.permissionMode).toBe("default");
  });

  it("falls back to the most recent thread in the same repository for a fresh worktree", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const existingWorktree = await seedWorktree(repository.id, "feature/existing");
    const freshWorktree = await seedWorktree(repository.id, "feature/fresh");

    await seedThread({
      worktreeId: existingWorktree.id,
      permissionMode: "full_access",
    });

    const created = await chatService.createThread(freshWorktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("full_access");
  });

  it("does not inherit across repositories", async () => {
    const chatService = createChatServiceForTest();
    const otherRepository = await seedRepository();
    const otherWorktree = await seedWorktree(otherRepository.id, "feature/other");
    await seedThread({
      worktreeId: otherWorktree.id,
      permissionMode: "full_access",
    });

    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/isolated");

    const created = await chatService.createThread(worktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("default");
  });

  it("ignores automation threads when resolving the inherited mode", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/automation");

    await seedThread({
      worktreeId: worktree.id,
      permissionMode: "full_access",
      isAutomation: true,
    });

    const created = await chatService.createThread(worktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("default");
  });

  it("defaults to default when the repository has no prior threads", async () => {
    const chatService = createChatServiceForTest();
    const repository = await seedRepository();
    const worktree = await seedWorktree(repository.id, "feature/empty");

    const created = await chatService.createThread(worktree.id, { title: "New chat" });

    expect(created.permissionMode).toBe("default");
  });
});
