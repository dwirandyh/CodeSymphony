import { PrismaClient } from "@prisma/client";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAgent, ChatThreadKind } from "@codesymphony/shared-types";
import * as cursorSessionRunner from "../src/cursor/sessionRunner.js";
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

function createStubModelProviderService(
  providersById: Record<string, {
    id: string;
    agent: CliAgent;
    apiKey: string | null;
    baseUrl: string | null;
    name: string;
    modelId: string;
    isActive?: boolean;
  }> = {},
) {
  return {
    getActiveProvider: async () => null,
    getProviderById: async (id: string) => providersById[id] ?? null,
  };
}

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

async function seedThread(title = "Agent selection thread", kind: ChatThreadKind = "default") {
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
      kind,
      permissionProfile: kind === "review" ? "review_git" : "default",
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
      model: "opencode/minimax-m2.5-free",
      modelProviderId: null,
    });

    expect(updatedThread.agent).toBe("opencode");
    expect(updatedThread.model).toBe("opencode/minimax-m2.5-free");
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

  it("routes Cursor threads through the Cursor runner and persists cursorSessionId", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const cursorRunner: ClaudeRunner = vi.fn(async ({ onSessionId, onText }) => {
      await onSessionId?.("cursor-session-1");
      await onText("Cursor reply");
      return {
        output: "Cursor reply",
        sessionId: "cursor-session-1",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      cursorRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Cursor selection thread");

    const updatedThread = await chatService.updateThreadAgentSelection(thread.id, {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    expect(updatedThread.agent).toBe("cursor");
    expect(updatedThread.model).toBe("default[]");
    expect(updatedThread.claudeSessionId).toBeNull();
    expect(updatedThread.cursorSessionId).toBeNull();

    await chatService.sendMessage(thread.id, {
      content: "Run through Cursor",
    });
    await waitForCompletion(chatService, thread.id);

    expect(cursorRunner).toHaveBeenCalledTimes(1);
    expect(claudeRunner).not.toHaveBeenCalled();

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.cursorSessionId).toBe("cursor-session-1");
    expect(persistedThread?.claudeSessionId).toBeNull();
  });

  it("falls back to local skills when Cursor does not expose a slash-command catalog", async () => {
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
    const { worktree } = await seedThread("Cursor slash command fallback");

    mkdirSync(join(worktree.path, ".agents/skills/dogfood"), { recursive: true });
    writeFileSync(
      join(worktree.path, ".agents/skills/dogfood/SKILL.md"),
      "---\nname: dogfood\ndescription: QA a web app.\n---\n",
    );

    vi.spyOn(cursorSessionRunner, "listCursorSlashCommands").mockResolvedValue([]);

    const catalog = await chatService.listSlashCommands(worktree.id, "cursor");

    expect(catalog.commands).toEqual(expect.arrayContaining([
      { name: "dogfood", description: "QA a web app.", argumentHint: "" },
    ]));
  });

  it("normalizes /skill prompts for Cursor threads before invoking the runner", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const cursorRunner: ClaudeRunner = vi.fn(async ({ prompt, onSessionId, onText }) => {
      expect(prompt).toBe("Use $dogfood for this task.\n\naudit halaman settings");
      await onSessionId?.("cursor-session-skill");
      await onText("Cursor reply");
      return {
        output: "Cursor reply",
        sessionId: "cursor-session-skill",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      cursorRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread, worktree } = await seedThread("Cursor slash command rewrite");

    mkdirSync(join(worktree.path, ".agents/skills/dogfood"), { recursive: true });
    writeFileSync(
      join(worktree.path, ".agents/skills/dogfood/SKILL.md"),
      "---\nname: dogfood\ndescription: QA a web app.\n---\n",
    );

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    await chatService.sendMessage(thread.id, {
      content: "/dogfood audit halaman settings",
    });
    await waitForCompletion(chatService, thread.id);

    expect(cursorRunner).toHaveBeenCalledTimes(1);
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

  it("aligns built-in Codex model selection with the local Codex CLI config", async () => {
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
      const { thread, worktree } = await seedThread("Codex CLI config alignment");

      const updatedThread = await chatService.updateThreadAgentSelection(thread.id, {
        agent: "codex",
        model: "gpt-5.3-codex-spark",
        modelProviderId: null,
      });

      expect(updatedThread.agent).toBe("codex");
      expect(updatedThread.model).toBe("gpt-5.4");

      const createdThread = await chatService.createThread(worktree.id, {
        agent: "codex",
      });

      expect(createdThread.agent).toBe("codex");
      expect(createdThread.model).toBe("gpt-5.4");
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
  });

  it.each([
    {
      agent: "claude" as const,
      initialModel: "claude-sonnet-4-6",
      nextModel: "claude-opus-4-6",
      sessionField: "claudeSessionId" as const,
      sessionId: "claude-session-1",
    },
    {
      agent: "codex" as const,
      initialModel: "gpt-5.4",
      nextModel: "gpt-5.4-mini",
      sessionField: "codexSessionId" as const,
      sessionId: "codex-session-1",
    },
    {
      agent: "cursor" as const,
      initialModel: "default[]",
      nextModel: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      sessionField: "cursorSessionId" as const,
      sessionId: "cursor-session-1",
    },
    {
      agent: "opencode" as const,
      initialModel: "opencode/minimax-m2.5-free",
      nextModel: "opencode/ling-2.6-flash-free",
      sessionField: "opencodeSessionId" as const,
      sessionId: "opencode-session-1",
    },
  ])("preserves $sessionField on same-agent built-in model switches after messages", async ({
    agent,
    initialModel,
    nextModel,
    sessionField,
    sessionId,
  }) => {
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

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent,
        model: initialModel,
        [sessionField]: sessionId,
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Already used",
      },
    });

    const updatedThread = await chatService.updateThreadAgentSelection(thread.id, {
      agent,
      model: nextModel,
      modelProviderId: null,
    });

    expect(updatedThread.agent).toBe(agent);
    expect(updatedThread.model).toBe(nextModel);
    expect(updatedThread[sessionField]).toBe(sessionId);

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.[sessionField]).toBe(sessionId);
  });

  it("approves a pending plan with a same-thread execution switch for valid same-agent targets", async () => {
    const eventHub = createEventHub(prisma);
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const codexRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("gpt-5.4-mini");
      expect(sessionId).toBe("codex-session-existing");
      await onText("Executing approved plan");
      return {
        output: "Executing approved plan",
        sessionId: "codex-session-existing",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      codexRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Plan switch thread");

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "codex",
        model: "gpt-5.4",
        mode: "plan",
        codexSessionId: "codex-session-existing",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Please make a plan",
      },
    });
    await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "codex",
      model: "gpt-5.4-mini",
      modelProviderId: null,
    });
    await waitForCompletion(chatService, thread.id);

    expect(result).toEqual({
      executionKind: "same_thread_switch",
      sourceThreadId: thread.id,
      executionThreadId: thread.id,
    });
    expect(codexRunner).toHaveBeenCalledTimes(1);
    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.agent).toBe("codex");
    expect(persistedThread?.model).toBe("gpt-5.4-mini");
    expect(persistedThread?.mode).toBe("default");
    expect(persistedThread?.codexSessionId).toBe("codex-session-existing");
  });

  it("approves a pending plan by handing off to a new execution thread when the target agent changes", async () => {
    const eventHub = createEventHub(prisma);
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const codexRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("gpt-5.4");
      expect(sessionId).toBeNull();
      await onText("Codex executed the approved plan");
      return {
        output: "Codex executed the approved plan",
        sessionId: "codex-handoff-session",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      codexRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread, worktree } = await seedThread("Plan handoff thread");

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "claude",
        model: "claude-sonnet-4-6",
        mode: "plan",
        permissionMode: "full_access",
        permissionProfile: "default",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Please make a plan",
      },
    });
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
    });
    await waitForCompletion(chatService, result.executionThreadId);

    expect(result.executionKind).toBe("handoff");
    expect(result.sourceThreadId).toBe(thread.id);
    expect(result.executionThreadId).not.toBe(thread.id);

    const executionThread = await chatService.getThreadById(result.executionThreadId);
    expect(executionThread?.worktreeId).toBe(worktree.id);
    expect(executionThread?.permissionMode).toBe("full_access");
    expect(executionThread?.permissionProfile).toBe("default");
    expect(executionThread?.agent).toBe("codex");
    expect(executionThread?.model).toBe("gpt-5.4");

    const persistedExecutionThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: result.executionThreadId },
    }) as any;
    expect(persistedExecutionThread.handoffSourceThreadId).toBe(thread.id);
    expect(persistedExecutionThread.handoffSourcePlanEventId).toBe(createdEvent.id);
  });

  it("supports an explicit handoff even when the current thread could execute in place", async () => {
    const eventHub = createEventHub(prisma);
    const codexRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("gpt-5.4");
      expect(sessionId).toBeNull();
      await onText("Codex executed the approved plan from a forced handoff thread");
      return {
        output: "Codex executed the approved plan from a forced handoff thread",
        sessionId: "codex-forced-handoff-session",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      codexRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Plan explicit handoff thread");

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "codex",
        model: "gpt-5.4",
        mode: "plan",
        codexSessionId: "codex-session-existing",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Please make a plan",
      },
    });
    await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });
    await waitForCompletion(chatService, result.executionThreadId);

    expect(result.executionKind).toBe("handoff");
    expect(result.executionThreadId).not.toBe(thread.id);

    const sourceThread = await chatService.getThreadById(thread.id);
    expect(sourceThread?.codexSessionId).toBe("codex-session-existing");

    const executionThread = await chatService.getThreadById(result.executionThreadId);
    expect(executionThread?.agent).toBe("codex");
    expect(executionThread?.model).toBe("gpt-5.4");
    expect(executionThread?.codexSessionId).toBe("codex-forced-handoff-session");
  });

  it("seeds the handoff thread with the approved plan card state", async () => {
    const eventHub = createEventHub(prisma);
    const codexRunner: ClaudeRunner = vi.fn(async ({ model, onText }) => {
      expect(model).toBe("gpt-5.4");
      await onText("Executing approved plan in seeded handoff thread");
      return {
        output: "Executing approved plan in seeded handoff thread",
        sessionId: "codex-seeded-handoff-session",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      codexRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Plan seed handoff thread");

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "claude",
        model: "claude-sonnet-4-6",
        mode: "plan",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Please make a plan",
      },
    });

    const planContent = "# Plan\n\n1. Implement the feature";
    const planFilePath = ".claude/plans/plan.md";
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: planContent,
      filePath: planFilePath,
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });
    await waitForCompletion(chatService, result.executionThreadId);

    const handoffMessages = await prisma.chatMessage.findMany({
      where: { threadId: result.executionThreadId },
      orderBy: { seq: "asc" },
    });
    expect(handoffMessages[0]).toMatchObject({
      role: "assistant",
      content: planContent,
    });

    const handoffEvents = await chatService.listEvents(result.executionThreadId);
    const handoffPlanCreated = handoffEvents.find((event) => event.type === "plan.created");
    expect(handoffPlanCreated?.payload).toMatchObject({
      content: planContent,
      filePath: planFilePath,
      messageId: handoffMessages[0]?.id,
    });

    expect(handoffEvents.some((event) =>
      event.type === "plan.approved"
      && event.payload.filePath === planFilePath,
    )).toBe(true);

    expect(handoffEvents.some((event) =>
      event.type === "tool.started"
      && event.payload.toolName === "ExitPlanMode",
    )).toBe(true);

    expect(handoffEvents.some((event) =>
      event.type === "tool.finished"
      && event.payload.toolName === "ExitPlanMode",
    )).toBe(true);

    const handoffSnapshot = await chatService.listThreadSnapshot(result.executionThreadId);
    expect(handoffSnapshot.timeline.timelineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plan-file-output",
          messageId: handoffMessages[0]?.id,
          content: planContent,
          filePath: planFilePath,
        }),
      ]),
    );

    const persistedExecutionThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: result.executionThreadId },
    }) as any;
    expect(persistedExecutionThread.handoffSourceThreadId).toBe(thread.id);
    expect(persistedExecutionThread.handoffSourcePlanEventId).toBe(createdEvent.id);
  });

  it("approves a pending plan by auto-handoff when a provider-backed Claude thread is locked", async () => {
    const eventHub = createEventHub(prisma);
    const modelProviderService = createStubModelProviderService({
      "provider-claude-remote": {
        id: "provider-claude-remote",
        agent: "claude",
        apiKey: "provider-key",
        baseUrl: "https://provider.example.com/v1",
        name: "Remote Claude",
        modelId: "glm-4.7",
      },
    });
    const claudeRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("claude-sonnet-4-6");
      expect(sessionId).toBeNull();
      await onText("Claude executed the approved plan in a handoff thread");
      return {
        output: "Claude executed the approved plan in a handoff thread",
        sessionId: "claude-handoff-session",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      modelProviderService,
    });
    const { thread } = await seedThread("Provider-backed Claude handoff");
    await prisma.modelProvider.create({
      data: {
        id: "provider-claude-remote",
        agent: "claude",
        name: "Remote Claude",
        modelId: "glm-4.7",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
      },
    });

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "claude",
        model: "glm-4.7",
        modelProviderId: "provider-claude-remote",
        claudeSessionId: "claude-session-remote",
        mode: "plan",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Please make a plan",
      },
    });
    await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    });
    await waitForCompletion(chatService, result.executionThreadId);

    expect(result.executionKind).toBe("handoff");
    expect(result.executionThreadId).not.toBe(thread.id);

    const sourceThread = await chatService.getThreadById(thread.id);
    expect(sourceThread?.model).toBe("glm-4.7");
    expect(sourceThread?.modelProviderId).toBe("provider-claude-remote");
    expect(sourceThread?.claudeSessionId).toBe("claude-session-remote");

    const executionThread = await chatService.getThreadById(result.executionThreadId);
    expect(executionThread?.agent).toBe("claude");
    expect(executionThread?.model).toBe("claude-sonnet-4-6");
    expect(executionThread?.modelProviderId).toBeNull();
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
    })).rejects.toThrow("Cannot change agent after the thread has messages");
  });

  it("rejects provider source changes once a thread already has messages", async () => {
    const modelProviderService = createStubModelProviderService({
      "provider-codex-1": {
        id: "provider-codex-1",
        agent: "codex",
        apiKey: "sk-test",
        baseUrl: "https://example.invalid/v1",
        name: "Team Codex",
        modelId: "gpt-5-custom",
      },
    });
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
      modelProviderService,
    });
    const { thread } = await seedThread("Provider source locked");

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "codex",
        model: "gpt-5.4",
      },
    });
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
      model: "gpt-5-custom",
      modelProviderId: "provider-codex-1",
    })).rejects.toThrow("Cannot change provider source after the thread has messages");
  });

  it("rejects model changes for review threads once they have messages", async () => {
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Review thread locked", "review");

    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Already used",
      },
    });

    await expect(chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-opus-4-6",
      modelProviderId: null,
    })).rejects.toThrow("Cannot change model for non-default threads");
  });

  it("rejects model changes for provider-backed Claude threads once they have messages", async () => {
    const modelProviderService = createStubModelProviderService({
      "provider-claude-remote": {
        id: "provider-claude-remote",
        agent: "claude",
        apiKey: "provider-key",
        baseUrl: "https://provider.example.com/v1",
        name: "Remote Claude",
        modelId: "glm-4.7",
      },
    });
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(async () => ({
        output: "",
        sessionId: null,
      })),
      modelProviderService,
    });
    const { thread } = await seedThread("Provider-backed Claude locked");
    await prisma.modelProvider.create({
      data: {
        id: "provider-claude-remote",
        agent: "claude",
        name: "Remote Claude",
        modelId: "glm-4.7",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
      },
    });

    await prisma.chatThread.update({
      where: { id: thread.id },
      data: {
        agent: "claude",
        model: "glm-4.7",
        modelProviderId: "provider-claude-remote",
        claudeSessionId: "claude-session-remote",
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Already used",
      },
    });

    await expect(chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    })).rejects.toThrow("Cannot change model for provider-backed Claude threads");
  });
});
