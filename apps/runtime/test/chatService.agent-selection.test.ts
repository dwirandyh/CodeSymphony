import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThread(title = "Agent selection thread") {
  const suffix = uniqueSuffix();
  const worktreePath = `/tmp/codesymphony-worktree-${suffix}`;
  mkdirSync(worktreePath, { recursive: true });

  const repository = await prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: `/tmp/codesymphony-root-${suffix}`,
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
      kind: "default",
      permissionProfile: "default",
    },
  });

  return { thread, worktree };
}

async function waitForCompletion(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  timeoutMs = 4000,
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    if (events.some((event) => event.type === "chat.completed" || event.type === "chat.failed")) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for completion");
}

describe("chatService agent selection", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("routes Codex threads through the Codex runner and persists codexSessionId", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const codexRunner: ClaudeRunner = vi.fn(async ({ onSessionId, onText }) => {
      await onSessionId?.("codex-session-1");
      await onText("Codex reply");
      return {
        output: "Codex reply",
        sessionId: "codex-session-1",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      codexRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread();

    const updatedThread = await chatService.updateThreadAgentSelection(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    });

    expect(updatedThread.agent).toBe("codex");
    expect(updatedThread.model).toBe("gpt-5.4");
    expect(updatedThread.claudeSessionId).toBeNull();
    expect(updatedThread.codexSessionId).toBeNull();

    await chatService.sendMessage(thread.id, {
      content: "Run through Codex",
    });
    await waitForCompletion(chatService, thread.id);

    expect(codexRunner).toHaveBeenCalledTimes(1);
    expect(claudeRunner).not.toHaveBeenCalled();

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.codexSessionId).toBe("codex-session-1");
    expect(persistedThread?.claudeSessionId).toBeNull();
  });

  it("routes OpenCode threads through the OpenCode runner and persists opencodeSessionId", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const opencodeRunner: ClaudeRunner = vi.fn(async ({ onSessionId, onText }) => {
      await onSessionId?.("opencode-session-1");
      await onText("OpenCode reply");
      return {
        output: "OpenCode reply",
        sessionId: "opencode-session-1",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      opencodeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("OpenCode selection thread");

    const updatedThread = await chatService.updateThreadAgentSelection(thread.id, {
      agent: "opencode",
      model: "openai/gpt-5",
      modelProviderId: null,
    });

    expect(updatedThread.agent).toBe("opencode");
    expect(updatedThread.model).toBe("openai/gpt-5");
    expect(updatedThread.claudeSessionId).toBeNull();
    expect(updatedThread.opencodeSessionId).toBeNull();

    await chatService.sendMessage(thread.id, {
      content: "Run through OpenCode",
    });
    await waitForCompletion(chatService, thread.id);

    expect(opencodeRunner).toHaveBeenCalledTimes(1);
    expect(claudeRunner).not.toHaveBeenCalled();

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.opencodeSessionId).toBe("opencode-session-1");
    expect(persistedThread?.claudeSessionId).toBeNull();
  });

  it("includes the effective Codex CLI provider in runtime errors for built-in Codex threads", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const codexHome = mkdtempSync(join(tmpdir(), "codesymphony-codex-home-"));
    writeFileSync(join(codexHome, "config.toml"), [
      "model_provider = \"cliproxyapi\"",
      "model = \"gpt-5.4\"",
      "",
      "[model_providers.cliproxyapi]",
      "name = \"cliproxyapi\"",
      "base_url = \"http://127.0.0.1:8317/v1\"",
      "wire_api = \"responses\"",
      "",
    ].join("\n"));
    process.env.CODEX_HOME = codexHome;

    try {
      const claudeRunner: ClaudeRunner = vi.fn(async () => ({
        output: "",
        sessionId: null,
      }));
      const codexRunner: ClaudeRunner = vi.fn(async () => {
        throw new Error("stream disconnected before completion");
      });

      const chatService = createChatService({
        prisma,
        eventHub: createEventHub(prisma),
        claudeRunner,
        codexRunner,
        modelProviderService: stubModelProviderService,
      });
      const { thread } = await seedThread("Codex CLI override error");

      await chatService.updateThreadAgentSelection(thread.id, {
        agent: "codex",
        model: "gpt-5.4",
        modelProviderId: null,
      });

      await chatService.sendMessage(thread.id, {
        content: "Trigger the runtime error path",
      });
      const events = await waitForCompletion(chatService, thread.id);

      expect(events.at(-1)?.type).toBe("chat.failed");
      expect(codexRunner).toHaveBeenCalledTimes(1);

      const messages = await chatService.listMessages(thread.id);
      const assistantMessage = messages.find((message) => message.role === "assistant");
      expect(assistantMessage?.content).toContain("Selected codex model: \"gpt-5.4\".");
      expect(assistantMessage?.content).toContain("Effective Codex CLI provider: \"cliproxyapi\" via http://127.0.0.1:8317/v1 using responses.");
      expect(assistantMessage?.content).toContain("not Settings → Models.");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it("rejects agent changes once a thread already has messages", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      codexRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Locked thread");

    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Already used",
      },
    });

    await expect(chatService.updateThreadAgentSelection(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    })).rejects.toThrow("Cannot change agent or model after the thread has messages");
  });
});
