import { PrismaClient, type ChatEventType } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import { buildTimelineFromSeed } from "../src/services/chat/chatTimelineAssembler";

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

  it("matches runtime snapshot assembly for subagent-owned explore activity", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "Inspect the codebase",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "Working on it",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    const events = [
      {
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "tool.started" as const,
        payload: { toolName: "Task", toolUseId: "call-task-1" },
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "subagent.started" as const,
        payload: { toolUseId: "subagent-1", agentId: "agent-1", agentType: "Explore", description: "" },
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "e3",
        threadId: "t1",
        idx: 3,
        type: "tool.started" as const,
        payload: { toolName: "Read", toolUseId: "read-1", parentToolUseId: "subagent-1", toolInput: { file_path: "src/app.ts" } },
        createdAt: "2026-01-01T00:00:03Z",
      },
      {
        id: "e4",
        threadId: "t1",
        idx: 4,
        type: "tool.finished" as const,
        payload: { toolName: "Read", toolUseId: "read-1-finished", precedingToolUseIds: ["read-1"], summary: "Read src/app.ts" },
        createdAt: "2026-01-01T00:00:04Z",
      },
      {
        id: "e5",
        threadId: "t1",
        idx: 5,
        type: "tool.started" as const,
        payload: { toolName: "Glob", toolUseId: "glob-1", parentToolUseId: "subagent-1", searchParams: "src/**/*.ts" },
        createdAt: "2026-01-01T00:00:05Z",
      },
      {
        id: "e6",
        threadId: "t1",
        idx: 6,
        type: "tool.finished" as const,
        payload: { toolName: "Glob", toolUseId: "glob-1-finished", precedingToolUseIds: ["glob-1"], summary: "Completed Glob" },
        createdAt: "2026-01-01T00:00:06Z",
      },
      {
        id: "e7",
        threadId: "t1",
        idx: 7,
        type: "subagent.finished" as const,
        payload: { toolUseId: "subagent-1", description: "Inspect the codebase and report what you found", lastMessage: "Found the relevant files." },
        createdAt: "2026-01-01T00:00:07Z",
      },
      {
        id: "e8",
        threadId: "t1",
        idx: 8,
        type: "message.completed" as const,
        payload: { messageId: "m2" },
        createdAt: "2026-01-01T00:00:08Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(assembly.items.filter((item) => item.kind === "explore-activity")).toHaveLength(0);
    const subagentItems = assembly.items.filter((item) => item.kind === "subagent-activity");
    expect(subagentItems).toHaveLength(1);
    expect(subagentItems[0].kind === "subagent-activity" ? subagentItems[0].description : "").toBe(
      "Inspect the codebase and report what you found",
    );
  });
});
