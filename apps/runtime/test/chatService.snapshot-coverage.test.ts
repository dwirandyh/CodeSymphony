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

  it("returns snapshot with messages and no events when unknown event enum values exist", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(),
      modelProviderService: stubModelProviderService,
    });

    const { threadId } = await seedThreadWithMessages(1);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ChatEvent" (id, threadId, idx, type, payload, createdAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      `legacy-${Date.now()}`,
      threadId,
      1,
      "commands_updated",
      JSON.stringify({}),
    );

    const snapshot = await chatService.listThreadSnapshot(threadId);

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.timeline.newestIdx).toBeNull();
  });

  it("skips bogus streaming fallback plan cards in runtime snapshot assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "hi",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "Hello there",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    const events = [
      {
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "plan.created" as const,
        payload: {
          messageId: "m2",
          content: "Hello there",
          filePath: "streaming-plan",
          source: "streaming_fallback",
        },
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "chat.completed" as const,
        payload: { messageId: "m2" },
        createdAt: "2026-01-01T00:00:02Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(assembly.items.filter((item) => item.kind === "plan-file-output")).toHaveLength(0);
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

  it("keeps worktree diff events out of runtime explore activity assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "delete file README.md",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "Deleted the top-level README.md.",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    const events = [
      {
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "tool.finished" as const,
        payload: {
          source: "worktree.diff",
          summary: "Edited 1 file",
          changedFiles: ["README.md"],
          diff: "diff --git a/README.md b/README.md\n-Read the docs\n-find the repo\n",
        },
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "chat.completed" as const,
        payload: { messageId: "m2" },
        createdAt: "2026-01-01T00:00:03Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(assembly.items.filter((item) => item.kind === "explore-activity")).toHaveLength(0);
    expect(
      assembly.items.filter((item) => item.kind === "message" && item.message.role === "assistant"),
    ).toHaveLength(1);
  });


  it("keeps fallback-anchored explore and edit cards ahead of later assistant turns in runtime assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "inspect",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "I checked and updated the UI.",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "m3",
        threadId: "t1",
        seq: 3,
        role: "user" as const,
        content: "thanks",
        attachments: [],
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "m4",
        threadId: "t1",
        seq: 4,
        role: "assistant" as const,
        content: "done",
        attachments: [],
        createdAt: "2026-01-01T00:00:03Z",
      },
    ];
    const events = [
      {
        id: "e1",
        threadId: "t1",
        idx: 50,
        type: "tool.started" as const,
        payload: { toolName: "Glob", toolUseId: "g1", searchParams: "src/**/*.ts" },
        createdAt: "2026-01-01T00:00:10Z",
      },
      {
        id: "e2",
        threadId: "t1",
        idx: 51,
        type: "tool.finished" as const,
        payload: { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] },
        createdAt: "2026-01-01T00:00:11Z",
      },
      {
        id: "e3",
        threadId: "t1",
        idx: 52,
        type: "tool.started" as const,
        payload: { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "src/app.ts", old_string: "a", new_string: "b" } },
        createdAt: "2026-01-01T00:00:12Z",
      },
      {
        id: "e4",
        threadId: "t1",
        idx: 53,
        type: "tool.finished" as const,
        payload: { toolName: "Edit", summary: "Updated src/app.ts", precedingToolUseIds: ["e1"], changedFiles: ["src/app.ts"], additions: 1, deletions: 1 },
        createdAt: "2026-01-01T00:00:13Z",
      },
      {
        id: "e5",
        threadId: "t1",
        idx: 54,
        type: "message.delta" as const,
        payload: { role: "assistant", messageId: "m2", delta: "I checked and updated the UI." },
        createdAt: "2026-01-01T00:00:14Z",
      },
      {
        id: "e6",
        threadId: "t1",
        idx: 200,
        type: "message.delta" as const,
        payload: { role: "assistant", messageId: "m4", delta: "done" },
        createdAt: "2026-01-01T00:00:20Z",
      },
      {
        id: "e7",
        threadId: "t1",
        idx: 201,
        type: "chat.completed" as const,
        payload: { messageId: "m4" },
        createdAt: "2026-01-01T00:00:21Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const exploreIndex = assembly.items.findIndex((item) => item.kind === "explore-activity");
    const editedIndex = assembly.items.findIndex((item) => item.kind === "edited-diff");
    const laterAssistantIndex = assembly.items.findIndex((item) => item.kind === "message" && item.message.id === "m4");

    expect(exploreIndex).toBeGreaterThan(-1);
    expect(editedIndex).toBeGreaterThan(-1);
    expect(laterAssistantIndex).toBeGreaterThan(-1);
    expect(exploreIndex).toBeLessThan(laterAssistantIndex);
    expect(editedIndex).toBeLessThan(laterAssistantIndex);
    expect(exploreIndex).toBeLessThan(editedIndex);
  });

  it("quarantines overlap-unresolved subagent explore events in runtime snapshot assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "run overlapping tasks",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "running",
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
        payload: { toolName: "Task", toolUseId: "call-1" },
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "e2",
        threadId: "t1",
        idx: 2,
        type: "subagent.started" as const,
        payload: { toolUseId: "sa-1", agentId: "agent-1", agentType: "Explore", description: "First" },
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "e3",
        threadId: "t1",
        idx: 3,
        type: "tool.started" as const,
        payload: { toolName: "Task", toolUseId: "call-2" },
        createdAt: "2026-01-01T00:00:03Z",
      },
      {
        id: "e4",
        threadId: "t1",
        idx: 4,
        type: "subagent.started" as const,
        payload: { toolUseId: "sa-2", agentId: "agent-2", agentType: "Explore", description: "Second" },
        createdAt: "2026-01-01T00:00:04Z",
      },
      {
        id: "e5",
        threadId: "t1",
        idx: 5,
        type: "tool.started" as const,
        payload: {
          toolName: "Read",
          toolUseId: "ambiguous-read",
          ownershipReason: "unresolved_overlap_no_lineage",
          activeSubagentToolUseIds: ["sa-1", "sa-2"],
        },
        createdAt: "2026-01-01T00:00:05Z",
      },
      {
        id: "e6",
        threadId: "t1",
        idx: 6,
        type: "tool.finished" as const,
        payload: {
          toolName: "Read",
          toolUseId: "ambiguous-read-finished",
          precedingToolUseIds: ["ambiguous-read"],
          summary: "Read maybe",
          ownershipReason: "unresolved_overlap_no_lineage",
          activeSubagentToolUseIds: ["sa-1", "sa-2"],
        },
        createdAt: "2026-01-01T00:00:06Z",
      },
      {
        id: "e7",
        threadId: "t1",
        idx: 7,
        type: "subagent.finished" as const,
        payload: { toolUseId: "sa-1", lastMessage: "done 1" },
        createdAt: "2026-01-01T00:00:07Z",
      },
      {
        id: "e8",
        threadId: "t1",
        idx: 8,
        type: "subagent.finished" as const,
        payload: { toolUseId: "sa-2", lastMessage: "done 2" },
        createdAt: "2026-01-01T00:00:08Z",
      },
      {
        id: "e9",
        threadId: "t1",
        idx: 9,
        type: "message.completed" as const,
        payload: { messageId: "m2" },
        createdAt: "2026-01-01T00:00:09Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    expect(assembly.items.filter((item) => item.kind === "explore-activity")).toHaveLength(0);
    expect(assembly.items.filter((item) => item.kind === "activity")).toHaveLength(0);
    const subagentItems = assembly.items.filter((item) => item.kind === "subagent-activity");
    expect(subagentItems).toHaveLength(2);
    for (const item of subagentItems) {
      if (item.kind !== "subagent-activity") continue;
      expect(item.steps.some((step) => step.toolUseId.includes("ambiguous-read"))).toBe(false);
    }
  });

  it("keeps an assistant read-confirmation sentence ahead of a later edit card in runtime snapshot assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "inspect and edit",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "Saya akan membaca kedua file tersebut dan melakukan beberapa edit kecil yang tidak berbahaya.Baik, saya sudah membaca kedua file tersebut. Sekarang saya akan melakukan edit kecil.",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    const events = [
      {
        id: "e1",
        threadId: "t1",
        idx: 1,
        type: "message.delta" as const,
        payload: { role: "assistant", messageId: "m2", delta: "Saya akan membaca kedua file tersebut dan melakukan beberapa edit kecil yang tidak berbahaya." },
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "e10",
        threadId: "t1",
        idx: 10,
        type: "tool.started" as const,
        payload: { toolName: "Glob", toolUseId: "g1", searchParams: "**/README.md" },
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "e11",
        threadId: "t1",
        idx: 11,
        type: "tool.finished" as const,
        payload: { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] },
        createdAt: "2026-01-01T00:00:02Z",
      },
      {
        id: "e12",
        threadId: "t1",
        idx: 12,
        type: "tool.started" as const,
        payload: { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "README.md" } },
        createdAt: "2026-01-01T00:00:03Z",
      },
      {
        id: "e13",
        threadId: "t1",
        idx: 13,
        type: "tool.finished" as const,
        payload: { toolName: "Read", summary: "Read README.md", precedingToolUseIds: ["r1"] },
        createdAt: "2026-01-01T00:00:03Z",
      },
      {
        id: "e14",
        threadId: "t1",
        idx: 14,
        type: "message.delta" as const,
        payload: { role: "assistant", messageId: "m2", delta: "Baik" },
        createdAt: "2026-01-01T00:00:04Z",
      },
      {
        id: "e20",
        threadId: "t1",
        idx: 20,
        type: "tool.started" as const,
        payload: { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "README.md", old_string: "a", new_string: "b" } },
        createdAt: "2026-01-01T00:00:05Z",
      },
      {
        id: "e21",
        threadId: "t1",
        idx: 21,
        type: "tool.finished" as const,
        payload: { toolName: "Edit", summary: "Edited README.md", editTarget: "README.md", precedingToolUseIds: ["e1"], changedFiles: ["README.md"], additions: 6, deletions: 5 },
        createdAt: "2026-01-01T00:00:05Z",
      },
      {
        id: "e22",
        threadId: "t1",
        idx: 22,
        type: "message.delta" as const,
        payload: { role: "assistant", messageId: "m2", delta: ", saya sudah membaca kedua file tersebut. Sekarang saya akan melakukan edit kecil." },
        createdAt: "2026-01-01T00:00:06Z",
      },
      {
        id: "e23",
        threadId: "t1",
        idx: 23,
        type: "chat.completed" as const,
        payload: { messageId: "m2" },
        createdAt: "2026-01-01T00:00:07Z",
      },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const exploreIndex = assembly.items.findIndex((item) => item.kind === "explore-activity");
    const confirmationIndex = assembly.items.findIndex(
      (item) =>
        item.kind === "message"
        && item.message.content.includes("Baik, saya sudah membaca kedua file tersebut."),
    );
    const editedIndex = assembly.items.findIndex((item) => item.kind === "edited-diff");

    expect(exploreIndex).toBeGreaterThan(-1);
    expect(confirmationIndex).toBeGreaterThan(-1);
    expect(editedIndex).toBeGreaterThan(-1);
    expect(exploreIndex).toBeLessThan(confirmationIndex);
    expect(confirmationIndex).toBeLessThan(editedIndex);
  });

  it("keeps a short pre-edit fragment with the preceding announcement in runtime snapshot assembly", async () => {
    const messages = [
      {
        id: "m1",
        threadId: "t1",
        seq: 1,
        role: "user" as const,
        content: "inspect and edit",
        attachments: [],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "m2",
        threadId: "t1",
        seq: 2,
        role: "assistant" as const,
        content: "Saya akan membaca kedua file tersebut terlebih dahulu. Baik, saya akan membuat perubahan tidak berbahaya pada kedua file tersebut. Mari saya edit:Selesai!",
        attachments: [],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    const events = [
      { id: "e1", threadId: "t1", idx: 1, type: "message.delta" as const, payload: { role: "assistant", messageId: "m2", delta: "Saya akan membaca kedua file tersebut terlebih dahulu." }, createdAt: "2026-01-01T00:00:01Z" },
      { id: "e10", threadId: "t1", idx: 10, type: "tool.started" as const, payload: { toolName: "Glob", toolUseId: "g1", searchParams: "**/README.md" }, createdAt: "2026-01-01T00:00:02Z" },
      { id: "e11", threadId: "t1", idx: 11, type: "tool.finished" as const, payload: { toolName: "Glob", summary: "Completed Glob", precedingToolUseIds: ["g1"] }, createdAt: "2026-01-01T00:00:02Z" },
      { id: "e12", threadId: "t1", idx: 12, type: "tool.started" as const, payload: { toolName: "Read", toolUseId: "r1", toolInput: { file_path: "README.md" } }, createdAt: "2026-01-01T00:00:03Z" },
      { id: "e13", threadId: "t1", idx: 13, type: "tool.finished" as const, payload: { toolName: "Read", summary: "Read README.md", precedingToolUseIds: ["r1"] }, createdAt: "2026-01-01T00:00:03Z" },
      { id: "e14", threadId: "t1", idx: 14, type: "message.delta" as const, payload: { role: "assistant", messageId: "m2", delta: "Baik, saya akan membuat perubahan tidak berbahaya pada kedua file tersebut. Mari saya" }, createdAt: "2026-01-01T00:00:04Z" },
      { id: "e20", threadId: "t1", idx: 20, type: "tool.started" as const, payload: { toolName: "Edit", toolUseId: "e1", toolInput: { file_path: "README.md", old_string: "a", new_string: "b" } }, createdAt: "2026-01-01T00:00:05Z" },
      { id: "e21", threadId: "t1", idx: 21, type: "tool.finished" as const, payload: { toolName: "Edit", summary: "Edited README.md", editTarget: "README.md", precedingToolUseIds: ["e1"], changedFiles: ["README.md"], additions: 5, deletions: 4 }, createdAt: "2026-01-01T00:00:05Z" },
      { id: "e22", threadId: "t1", idx: 22, type: "message.delta" as const, payload: { role: "assistant", messageId: "m2", delta: " edit:" }, createdAt: "2026-01-01T00:00:05Z" },
      { id: "e23", threadId: "t1", idx: 23, type: "tool.started" as const, payload: { toolName: "Edit", toolUseId: "e2", toolInput: { file_path: "build.gradle", old_string: "a", new_string: "b" } }, createdAt: "2026-01-01T00:00:06Z" },
      { id: "e24", threadId: "t1", idx: 24, type: "tool.finished" as const, payload: { toolName: "Edit", summary: "Edited build.gradle", editTarget: "build.gradle", precedingToolUseIds: ["e2"], changedFiles: ["build.gradle"], additions: 5, deletions: 0 }, createdAt: "2026-01-01T00:00:06Z" },
      { id: "e25", threadId: "t1", idx: 25, type: "message.delta" as const, payload: { role: "assistant", messageId: "m2", delta: "Selesai! Saya telah melakukan perubahan tidak berbahaya pada kedua file:" }, createdAt: "2026-01-01T00:00:07Z" },
      { id: "e26", threadId: "t1", idx: 26, type: "chat.completed" as const, payload: { messageId: "m2" }, createdAt: "2026-01-01T00:00:08Z" },
    ];

    const assembly = buildTimelineFromSeed({
      messages,
      events,
      selectedThreadId: "t1",
      semanticHydrationInProgress: false,
    });

    const firstEditedIndex = assembly.items.findIndex((item) => item.kind === "edited-diff" && item.changedFiles.includes("README.md"));
    const secondEditedIndex = assembly.items.findIndex((item) => item.kind === "edited-diff" && item.changedFiles.includes("build.gradle"));
    const preSecondEditMessageIndex = assembly.items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Mari saya edit:"),
    );
    const doneMessageIndex = assembly.items.findIndex(
      (item) => item.kind === "message" && item.message.content.includes("Selesai!"),
    );

    expect(firstEditedIndex).toBeGreaterThan(-1);
    expect(secondEditedIndex).toBeGreaterThan(-1);
    expect(preSecondEditMessageIndex).toBeGreaterThan(-1);
    expect(doneMessageIndex).toBeGreaterThan(-1);
    expect(firstEditedIndex).toBeLessThan(preSecondEditMessageIndex);
    expect(preSecondEditMessageIndex).toBeLessThan(secondEditedIndex);
    expect(secondEditedIndex).toBeLessThan(doneMessageIndex);
  });
});
