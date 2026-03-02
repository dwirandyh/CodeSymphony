import { PrismaClient, type ChatEventType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chatService";

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

type SeededThread = {
  threadId: string;
  messageIdBySeq: Map<number, string>;
};

async function seedThreadWithMessages(messageCount: number): Promise<SeededThread> {
  const suffix = uniqueSuffix();
  const repository = await prisma.repository.create({
    data: {
      name: `snapshot-coverage-${suffix}`,
      rootPath: `/tmp/snapshot-coverage-${suffix}`,
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

  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title: "Snapshot Coverage",
    },
  });

  const messageIdBySeq = new Map<number, string>();
  for (let seq = 1; seq <= messageCount; seq += 1) {
    const message = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq,
        role: "assistant",
        content: `assistant-${seq}`,
      },
    });
    messageIdBySeq.set(seq, message.id);
  }

  return { threadId: thread.id, messageIdBySeq };
}

async function insertEvents(
  threadId: string,
  events: Array<{ idx: number; type: ChatEventType; payload: Record<string, unknown> }>,
): Promise<void> {
  await prisma.chatEvent.createMany({
    data: events.map((event) => ({
      threadId,
      idx: event.idx,
      type: event.type,
      payload: event.payload,
    })),
  });
}

describe("chatService snapshot coverage", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("marks snapshot as complete when loaded message window has contextual events", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId, messageIdBySeq } = await seedThreadWithMessages(3);
    await insertEvents(threadId, [
      { idx: 1, type: "chat_completed", payload: { messageId: messageIdBySeq.get(1) } },
      { idx: 2, type: "chat_completed", payload: { messageId: messageIdBySeq.get(2) } },
      { idx: 3, type: "chat_completed", payload: { messageId: messageIdBySeq.get(3) } },
    ]);

    const snapshot = await chatService.listThreadSnapshot(threadId, {
      messageLimit: 3,
      eventLimit: 3,
    });

    expect(snapshot.coverage).toEqual({
      eventsStatus: "complete",
      recommendedBackfill: false,
      nextBeforeIdx: null,
    });
  });

  it("marks snapshot as needs_backfill when there are older events and loaded messages lack context", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId } = await seedThreadWithMessages(5);
    const events = Array.from({ length: 50 }, (_, index) => ({
      idx: index + 1,
      type: "tool_output" as const,
      payload: { text: `event-${index + 1}` },
    }));
    await insertEvents(threadId, events);

    const snapshot = await chatService.listThreadSnapshot(threadId, {
      messageLimit: 5,
      eventLimit: 5,
    });

    expect(snapshot.coverage.eventsStatus).toBe("needs_backfill");
    expect(snapshot.coverage.recommendedBackfill).toBe(true);
    expect(snapshot.coverage.nextBeforeIdx).toBe(snapshot.events.pageInfo.nextBeforeIdx);
    expect(snapshot.events.pageInfo.hasMoreOlder).toBe(true);
  });

  it("marks snapshot as capped when event limit exceeds server budget and older events remain", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId } = await seedThreadWithMessages(1);
    const events = Array.from({ length: 2105 }, (_, index) => ({
      idx: index + 1,
      type: "tool_output" as const,
      payload: { text: `bulk-${index + 1}` },
    }));
    await insertEvents(threadId, events);

    const snapshot = await chatService.listThreadSnapshot(threadId, {
      messageLimit: 1,
      eventLimit: 5000,
    });

    expect(snapshot.coverage.eventsStatus).toBe("capped");
    expect(snapshot.coverage.recommendedBackfill).toBe(true);
    expect(snapshot.events.data).toHaveLength(2000);
    expect(snapshot.events.pageInfo.hasMoreOlder).toBe(true);
    expect(snapshot.coverage.nextBeforeIdx).toBe(snapshot.events.pageInfo.nextBeforeIdx);
  });
});
