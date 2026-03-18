import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./prisma/test.db";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function seedThread(): Promise<string> {
  const suffix = uniqueSuffix();
  const repo = await prisma.repository.create({
    data: { name: `repo-${suffix}`, rootPath: `/tmp/repo-${suffix}`, defaultBranch: "main" },
  });
  const wt = await prisma.worktree.create({
    data: { repositoryId: repo.id, branch: "main", baseBranch: "main", path: `/tmp/wt-${suffix}`, status: "active" },
  });
  const thread = await prisma.chatThread.create({
    data: { worktreeId: wt.id, title: "Test" },
  });
  return thread.id;
}

beforeEach(async () => {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("eventHub", () => {
  describe("emit", () => {
    it("persists event to database", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const event = await hub.emit(threadId, "message.delta", { text: "hello", role: "assistant" });
      expect(event.id).toBeTruthy();
      expect(event.threadId).toBe(threadId);
      expect(event.type).toBe("message.delta");
      expect(event.payload.text).toBe("hello");
      expect(event.idx).toBe(0);
    });

    it("increments idx for consecutive events", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const e1 = await hub.emit(threadId, "message.delta", { text: "a" });
      const e2 = await hub.emit(threadId, "message.delta", { text: "b" });
      const e3 = await hub.emit(threadId, "chat.completed", {});
      expect(e1.idx).toBe(0);
      expect(e2.idx).toBe(1);
      expect(e3.idx).toBe(2);
    });

    it("notifies subscribers", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const received: string[] = [];
      hub.subscribe(threadId, (event) => {
        received.push(event.type);
      });
      await hub.emit(threadId, "message.delta", { text: "x" });
      await hub.emit(threadId, "chat.completed", {});
      expect(received).toEqual(["message.delta", "chat.completed"]);
    });

    it("handles concurrent emits without idx collision", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const promises = Array.from({ length: 5 }, (_, i) =>
        hub.emit(threadId, "message.delta", { text: `msg-${i}` }),
      );
      const events = await Promise.all(promises);
      const indices = events.map(e => e.idx).sort((a, b) => a - b);
      expect(indices).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("list", () => {
    it("returns all events for thread", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      await hub.emit(threadId, "message.delta", { text: "a" });
      await hub.emit(threadId, "message.delta", { text: "b" });
      const events = await hub.list(threadId);
      expect(events.length).toBe(2);
      expect(events[0].idx).toBe(0);
      expect(events[1].idx).toBe(1);
    });

    it("filters events after idx", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      await hub.emit(threadId, "message.delta", { text: "a" });
      await hub.emit(threadId, "message.delta", { text: "b" });
      await hub.emit(threadId, "chat.completed", {});
      const events = await hub.list(threadId, 0);
      expect(events.length).toBe(2);
      expect(events[0].idx).toBe(1);
    });

    it("returns empty for unknown thread", async () => {
      const hub = createEventHub(prisma);
      const events = await hub.list("nonexistent");
      expect(events).toEqual([]);
    });
  });

  describe("subscribe", () => {
    it("returns unsubscribe function", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const received: string[] = [];
      const unsubscribe = hub.subscribe(threadId, (event) => {
        received.push(event.type);
      });
      await hub.emit(threadId, "message.delta", { text: "before" });
      unsubscribe();
      await hub.emit(threadId, "chat.completed", {});
      expect(received).toEqual(["message.delta"]);
    });

    it("supports multiple subscribers", async () => {
      const hub = createEventHub(prisma);
      const threadId = await seedThread();
      const r1: string[] = [];
      const r2: string[] = [];
      hub.subscribe(threadId, (e) => r1.push(e.type));
      hub.subscribe(threadId, (e) => r2.push(e.type));
      await hub.emit(threadId, "tool.started", { toolName: "bash" });
      expect(r1).toEqual(["tool.started"]);
      expect(r2).toEqual(["tool.started"]);
    });

    it("isolates subscriptions per thread", async () => {
      const hub = createEventHub(prisma);
      const t1 = await seedThread();
      const t2 = await seedThread();
      const received: string[] = [];
      hub.subscribe(t1, (e) => received.push(`t1:${e.type}`));
      hub.subscribe(t2, (e) => received.push(`t2:${e.type}`));
      await hub.emit(t1, "message.delta", {});
      await hub.emit(t2, "chat.completed", {});
      expect(received).toEqual(["t1:message.delta", "t2:chat.completed"]);
    });
  });
});
