import { PrismaClient, type ChatEventType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";

const stubModelProviderService = {
  getActiveProvider: async () => null,
};

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./prisma/test.db";

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

describe("chatService snapshot", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns all messages and events in a snapshot", async () => {
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

    const snapshot = await chatService.listThreadSnapshot(threadId);

    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.timeline.newestIdx).toBe(3);
  });

  it("returns all events even with many events", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId } = await seedThreadWithMessages(1);
    const events = Array.from({ length: 100 }, (_, index) => ({
      idx: index + 1,
      type: "tool_output" as const,
      payload: { text: `event-${index + 1}` },
    }));
    await insertEvents(threadId, events);

    const snapshot = await chatService.listThreadSnapshot(threadId);

    expect(snapshot.events).toHaveLength(100);
    expect(snapshot.timeline.newestIdx).toBe(100);
  });

  it("returns empty snapshot for thread with no data", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId } = await seedThreadWithMessages(0);

    const snapshot = await chatService.listThreadSnapshot(threadId);

    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.timeline.newestIdx).toBeNull();
    expect(snapshot.timeline.newestSeq).toBeNull();
  });
});
