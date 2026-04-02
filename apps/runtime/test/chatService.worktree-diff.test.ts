import { PrismaClient } from "@prisma/client";
import type { ChatEvent } from "@codesymphony/shared-types";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import type { ClaudeRunner } from "../src/types";

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

const tempDirs: string[] = [];

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createGitWorktree(initialFiles: Record<string, string>): string {
  const worktreePath = mkdtempSync(join(tmpdir(), "codesymphony-worktree-diff-"));
  tempDirs.push(worktreePath);

  execFileSync("git", ["init", "-q"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Codesymphony Tests"], { cwd: worktreePath });

  for (const [relativePath, content] of Object.entries(initialFiles)) {
    const absolutePath = join(worktreePath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }

  execFileSync("git", ["add", "-A"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-m", "Initial commit", "-q"], { cwd: worktreePath });

  return worktreePath;
}

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThreadForWorktree(worktreePath: string, title = "Worktree Diff Test"): Promise<string> {
  const suffix = uniqueSuffix();
  const repository = await prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: worktreePath,
      defaultBranch: "main",
    },
  });

  const worktree = await prisma.worktree.create({
    data: {
      repositoryId: repository.id,
      branch: "main",
      baseBranch: "main",
      path: worktreePath,
      status: "active",
    },
  });

  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title,
    },
  });

  return thread.id;
}

async function waitForTerminalEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  timeoutMs = 4000,
): Promise<ChatEvent[]> {
  const startedAt = Date.now();
  let sawCompletion = false;

  while (Date.now() - startedAt < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    const done = events.some((event) => event.type === "chat.completed" || event.type === "chat.failed");
    if (done) {
      if (sawCompletion) {
        return events;
      }
      sawCompletion = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for terminal event");
}

function worktreeDiffEvent(events: ChatEvent[]): ChatEvent | undefined {
  return events.find((event) => event.type === "tool.finished" && event.payload.source === "worktree.diff");
}

describe("chatService worktree diff delta", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits worktree diff for only files changed in the current run", async () => {
    const worktreePath = createGitWorktree({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    writeFileSync(join(worktreePath, "src/a.ts"), "export const a = 2;\n", "utf8");

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      writeFileSync(join(worktreePath, "src/b.ts"), "export const b = 2;\n", "utf8");
      await onText("Updated src/b.ts");
      return {
        output: "Updated src/b.ts",
        sessionId: "session-worktree-delta-1",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Diff Delta");

    await chatService.sendMessage(threadId, {
      content: "update src/b.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    const completedEvent = events.find((event) => event.type === "chat.completed");
    expect(diffEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    expect((diffEvent?.idx ?? Number.POSITIVE_INFINITY)).toBeLessThan(completedEvent?.idx ?? Number.NEGATIVE_INFINITY);
    expect(diffEvent?.payload.changedFiles).toEqual(["src/b.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(diffEvent?.payload.diff).not.toContain("diff --git a/src/a.ts b/src/a.ts");
  });

  it("does not emit worktree diff when no file changes occur", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      await onText("No changes made.");
      return {
        output: "No changes made.",
        sessionId: "session-worktree-delta-2",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree No Changes");

    await chatService.sendMessage(threadId, {
      content: "analyze only",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(worktreeDiffEvent(events)).toBeUndefined();
  });

  it("rejects sends when expected worktree id does not match the thread worktree", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      await onText("Should not run.");
      return {
        output: "Should not run.",
        sessionId: "session-worktree-mismatch",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree mismatch");

    await expect(chatService.sendMessage(threadId, {
      content: "update src/main.ts",
      expectedWorktreeId: "different-worktree",
    })).rejects.toThrow("Selected worktree no longer matches this thread");
    expect(claudeRunner).not.toHaveBeenCalled();
  });

  it("records changedFiles when a previously dirty file becomes clean", async () => {
    const original = "export const value = 1;\n";
    const worktreePath = createGitWorktree({
      "src/value.ts": original,
    });
    writeFileSync(join(worktreePath, "src/value.ts"), "export const value = 2;\n", "utf8");

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      writeFileSync(join(worktreePath, "src/value.ts"), original, "utf8");
      await onText("Reverted file to clean state.");
      return {
        output: "Reverted file to clean state.",
        sessionId: "session-worktree-delta-3",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Clean Transition");

    await chatService.sendMessage(threadId, {
      content: "revert local changes",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/value.ts"]);
    expect(diffEvent?.payload.diff).toBe("");
    expect(diffEvent?.payload.diffTruncated).toBe(false);
  });
});
