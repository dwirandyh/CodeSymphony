import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes("test.db")
    ? process.env.DATABASE_URL
    : "file:./test.db";

const prisma = new PrismaClient({
  datasources: { db: { url: TEST_DATABASE_URL } },
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function seedThread(client: PrismaClient = prisma): Promise<string> {
  const suffix = uniqueSuffix();
  const repo = await client.repository.create({
    data: { name: `repo-${suffix}`, rootPath: `/tmp/repo-${suffix}`, defaultBranch: "main" },
  });
  const wt = await client.worktree.create({
    data: { repositoryId: repo.id, branch: "main", baseBranch: "main", path: `/tmp/wt-${suffix}`, status: "active" },
  });
  const thread = await client.chatThread.create({
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

    it("recovers idx allocation when two hubs emit to the same thread", async () => {
      const leftHub = createEventHub(prisma);
      const rightHub = createEventHub(prisma);
      const threadId = await seedThread();

      const events = await Promise.all([
        leftHub.emit(threadId, "chat.completed", { source: "left" }),
        rightHub.emit(threadId, "chat.completed", { source: "right" }),
      ]);

      const indices = events.map((event) => event.idx).sort((a, b) => a - b);
      const persisted = await prisma.chatEvent.findMany({
        where: { threadId },
        orderBy: { idx: "asc" },
        select: { idx: true },
      });

      expect(indices).toEqual([0, 1]);
      expect(persisted.map((event) => event.idx)).toEqual([0, 1]);
    });

    it("keeps retrying idx collisions until persistence succeeds", async () => {
      const collisionPrisma = new PrismaClient({
        datasources: { db: { url: TEST_DATABASE_URL } },
      });

      try {
        const hub = createEventHub(collisionPrisma);
        const threadId = await seedThread(collisionPrisma);
        const actualCreate = collisionPrisma.chatEvent.create.bind(collisionPrisma.chatEvent);

        const collisionThreadId = await seedThread(collisionPrisma);
        await actualCreate({
          data: {
            id: `collision-seed-${uniqueSuffix()}`,
            threadId: collisionThreadId,
            idx: 0,
            type: "message_delta",
            payload: {},
            createdAt: new Date(),
          },
        });

        let collisionError: unknown;
        try {
          await actualCreate({
            data: {
              id: `collision-trigger-${uniqueSuffix()}`,
              threadId: collisionThreadId,
              idx: 0,
              type: "message_delta",
              payload: {},
              createdAt: new Date(),
            },
          });
        } catch (error) {
          collisionError = error;
        }

        expect(collisionError).toBeTruthy();

        let collisionCount = 0;
        const createSpy = vi.spyOn(collisionPrisma.chatEvent, "create").mockImplementation(async (...args) => {
          if (collisionCount < 4) {
            await actualCreate({
              data: {
                id: `collision-row-${collisionCount}-${uniqueSuffix()}`,
                threadId,
                idx: collisionCount,
                type: "message_delta",
                payload: {},
                createdAt: new Date(),
              },
            });
            collisionCount += 1;
            throw collisionError;
          }

          return actualCreate(...args);
        });

        const event = await hub.emit(threadId, "message.delta", { text: "eventual-success" });
        createSpy.mockRestore();

        const persisted = await collisionPrisma.chatEvent.findMany({
          where: { threadId },
          orderBy: { idx: "asc" },
          select: { idx: true },
        });

        expect(event.idx).toBe(4);
        expect(persisted.map((row) => row.idx)).toEqual([0, 1, 2, 3, 4]);
      } finally {
        await collisionPrisma.$disconnect();
      }
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

    it("returns empty when unknown enum values exist in the database", async () => {
      const threadId = await seedThread();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ChatEvent" (id, threadId, idx, type, payload, createdAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        `legacy-${Date.now()}`,
        threadId,
        0,
        "commands_updated",
        JSON.stringify({}),
      );

      const hub = createEventHub(prisma);
      const events = await hub.list(threadId);
      expect(events).toEqual([]);
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
