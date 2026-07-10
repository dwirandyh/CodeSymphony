import { PrismaClient } from "@prisma/client";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadKind, ModelProviderCompatibility } from "@codesymphony/shared-types";
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
  resolveProviderSelection: async () => null,
};

let originalCodexHome: string | undefined;
let originalSlashCommandCacheDir: string | undefined;
let slashCommandCacheDir: string | null = null;

function createStubModelProviderService(
  providersById: Record<string, {
    id: string;
    providerId?: string;
    compatibility: ModelProviderCompatibility;
    apiKey: string | null;
    baseUrl: string | null;
    name: string;
    modelId: string;
  }> = {},
) {
  return {
    resolveProviderSelection: async (providerId: string, modelId: string) => {
      const provider = providersById[providerId] ?? null;
      if (!provider) {
        return null;
      }
      if (provider.modelId !== modelId) {
        throw new Error("Selected model is no longer available in this provider");
      }
      return {
        ...provider,
      };
    },
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

async function persistPendingPlanState(params: {
  threadId: string;
  eventId: string;
  content: string;
  filePath: string;
}) {
  await prisma.chatThread.update({
    where: { id: params.threadId },
    data: {
      pendingPlanEventId: params.eventId,
      pendingPlanContent: params.content,
      pendingPlanFilePath: params.filePath,
    },
  });
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
    vi.spyOn(cursorSessionRunner, "listCursorModels").mockResolvedValue([]);
    originalCodexHome = process.env.CODEX_HOME;
    originalSlashCommandCacheDir = process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codesymphony-test-codex-home-"));
    slashCommandCacheDir = mkdtempSync(join(tmpdir(), "codesymphony-test-slash-command-cache-"));
    process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR = slashCommandCacheDir;
    await resetDatabase();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }

    if (originalSlashCommandCacheDir === undefined) {
      delete process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR;
    } else {
      process.env.CODESYMPHONY_SLASH_COMMAND_CACHE_DIR = originalSlashCommandCacheDir;
    }

    if (slashCommandCacheDir) {
      rmSync(slashCommandCacheDir, { recursive: true, force: true });
      slashCommandCacheDir = null;
    }
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
    expect(codexRunner).toHaveBeenCalledWith(expect.objectContaining({
      includeCommentaryInText: true,
    }));
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

  it("returns local skill slash-command catalog for OpenCode", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
      slashCommands: [{ name: "commit", description: "Create a commit", argumentHint: "" }],
    }));
    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { worktree } = await seedThread("OpenCode slash command catalog");

    mkdirSync(join(worktree.path, ".agents/skills/diagnose"), { recursive: true });
    writeFileSync(
      join(worktree.path, ".agents/skills/diagnose/SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose hard bugs.\n---\n",
    );

    const catalog = await chatService.listSlashCommands(worktree.id, "opencode");

    expect(catalog.commands).toEqual(expect.arrayContaining([
      { name: "diagnose", description: "Diagnose hard bugs.", argumentHint: "" },
    ]));
    expect(claudeRunner).not.toHaveBeenCalled();
  });

  it("persists slash-command catalogs and refreshes them when local skills change", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const cursorCatalogSpy = vi.spyOn(cursorSessionRunner, "listCursorSlashCommands").mockResolvedValue([]);
    const { worktree } = await seedThread("Persistent slash command cache");
    const skillDirPath = join(worktree.path, ".agents/skills/dogfood");
    const skillFilePath = join(skillDirPath, "SKILL.md");
    mkdirSync(skillDirPath, { recursive: true });
    writeFileSync(
      skillFilePath,
      "---\nname: dogfood\ndescription: QA a web app.\n---\n",
    );

    const firstService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const firstCatalog = await firstService.listSlashCommands(worktree.id, "cursor");
    const secondCatalog = await firstService.listSlashCommands(worktree.id, "cursor");

    expect(firstCatalog.commands).toEqual(expect.arrayContaining([
      { name: "dogfood", description: "QA a web app.", argumentHint: "" },
    ]));
    expect(secondCatalog).toEqual(firstCatalog);
    expect(cursorCatalogSpy).toHaveBeenCalledTimes(1);

    const secondService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const persistedCatalog = await secondService.listSlashCommands(worktree.id, "cursor");

    expect(persistedCatalog).toEqual(firstCatalog);
    expect(cursorCatalogSpy).toHaveBeenCalledTimes(1);

    writeFileSync(
      skillFilePath,
      "---\nname: dogfood\ndescription: QA halaman settings.\n---\n",
    );

    const refreshedCatalog = await secondService.listSlashCommands(worktree.id, "cursor");

    expect(refreshedCatalog.commands).toEqual(expect.arrayContaining([
      { name: "dogfood", description: "QA halaman settings.", argumentHint: "" },
    ]));
    expect(cursorCatalogSpy).toHaveBeenCalledTimes(2);
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

  it("normalizes /skill prompts for Cursor threads when the skill comes from .cursor/skills", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    let observedPrompt: string | null = null;
    const cursorRunner: ClaudeRunner = vi.fn(async ({ prompt, onSessionId, onText }) => {
      observedPrompt = prompt;
      await onSessionId?.("cursor-session-cursor-skill");
      await onText("Cursor reply");
      return {
        output: "Cursor reply",
        sessionId: "cursor-session-cursor-skill",
      };
    });

    vi.spyOn(cursorSessionRunner, "listCursorSlashCommands").mockResolvedValue([
      { name: "cursorscan", description: "Scan from .cursor/skills.", argumentHint: "" },
    ]);

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      cursorRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Cursor .cursor/skills rewrite");

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    await chatService.sendMessage(thread.id, {
      content: "/cursorscan audit halaman settings",
    });
    await waitForCompletion(chatService, thread.id);

    expect(cursorRunner).toHaveBeenCalledTimes(1);
    expect(observedPrompt).toBe("Use $cursorscan for this task.\n\naudit halaman settings");
  });

  it("normalizes /skill prompts end-to-end from a real .cursor/skills/SKILL.md on disk", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    let observedPrompt: string | null = null;
    const cursorRunner: ClaudeRunner = vi.fn(async ({ prompt, onSessionId, onText }) => {
      observedPrompt = prompt;
      await onSessionId?.("cursor-session-e2e-skill");
      await onText("Cursor reply");
      return {
        output: "Cursor reply",
        sessionId: "cursor-session-e2e-skill",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      cursorRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread, worktree } = await seedThread("Cursor real .cursor/skills rewrite");

    mkdirSync(join(worktree.path, ".cursor/skills/diskscan"), { recursive: true });
    writeFileSync(
      join(worktree.path, ".cursor/skills/diskscan/SKILL.md"),
      "---\nname: diskscan\ndescription: Real on-disk cursor skill.\n---\n",
    );

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "cursor",
      model: "default[]",
      modelProviderId: null,
    });

    await chatService.sendMessage(thread.id, {
      content: "/diskscan audit halaman settings",
    });
    await waitForCompletion(chatService, thread.id);

    expect(cursorRunner).toHaveBeenCalledTimes(1);
    expect(observedPrompt).toBe("Use $diskscan for this task.\n\naudit halaman settings");
  });

  it("normalizes $skill prompts for OpenCode threads before invoking the runner", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const opencodeRunner: ClaudeRunner = vi.fn(async ({ onSessionId, onText }) => {
      await onSessionId?.("opencode-session-skill");
      await onText("OpenCode reply");
      return {
        output: "OpenCode reply",
        sessionId: "opencode-session-skill",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      opencodeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread, worktree } = await seedThread("OpenCode slash command rewrite");

    mkdirSync(join(worktree.path, ".agents/skills/diagnose"), { recursive: true });
    writeFileSync(
      join(worktree.path, ".agents/skills/diagnose/SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose hard bugs.\n---\n",
    );

    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "opencode",
      model: "opencode-default",
      modelProviderId: null,
    });

    await chatService.sendMessage(thread.id, {
      content: "$diagnose why no skills?",
    });
    await waitForCompletion(chatService, thread.id);

    expect(opencodeRunner).toHaveBeenCalledTimes(1);
    expect(opencodeRunner).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Use $diagnose for this task.\n\nwhy no skills?",
    }));
  });

  it("normalizes /skill prompts for Claude threads with custom providers", async () => {
    let observedPrompt: string | null = null;
    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, providerApiKey, providerBaseUrl, onSessionId, onText }) => {
      observedPrompt = prompt;
      expect(providerApiKey).toBe("provider-key");
      expect(providerBaseUrl).toBe("https://provider.example.com/v1");
      await onSessionId?.("claude-session-skill");
      await onText("Claude reply");
      return {
        output: "Claude reply",
        sessionId: "claude-session-skill",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: createStubModelProviderService({
        "provider-claude-remote": {
          id: "provider-claude-remote",
          compatibility: "anthropic",
          apiKey: "provider-key",
          baseUrl: "https://provider.example.com/v1",
          name: "Remote Claude",
          modelId: "claude-opus-4.6",
        },
      }),
    });
    const { thread, worktree } = await seedThread("Claude slash command rewrite");
    const homePath = mkdtempSync(join(tmpdir(), "codesymphony-home-claude-skills-"));
    const homeSkillDir = join(homePath, ".claude/skills/diagnose");
    mkdirSync(homeSkillDir, { recursive: true });
    writeFileSync(
      join(homeSkillDir, "SKILL.md"),
      "---\nname: diagnose\ndescription: Diagnose hard bugs.\n---\n",
    );
    vi.stubEnv("HOME", homePath);

    await prisma.modelProvider.create({
      data: {
        id: "provider-claude-remote",
        name: "Remote Claude",
        compatibility: "anthropic",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
        models: {
          create: {
            modelId: "claude-opus-4.6",
          },
        },
      },
    });
    await chatService.updateThreadAgentSelection(thread.id, {
      agent: "claude",
      model: "claude-opus-4.6",
      modelProviderId: "provider-claude-remote",
    });

    await chatService.sendMessage(thread.id, {
      content: "/diagnose why is this broken?",
    });
    await waitForCompletion(chatService, thread.id);

    expect(claudeRunner).toHaveBeenCalledTimes(1);
    expect(observedPrompt).toBe("Use $diagnose for this task.\n\nwhy is this broken?");

    const linkedSkillPath = join(worktree.path, ".claude/skills/diagnose");
    expect(existsSync(linkedSkillPath)).toBe(true);
    expect(lstatSync(linkedSkillPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkedSkillPath)).toBe(homeSkillDir);
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

  it("preserves explicit Codex built-in selections while keeping the local CLI default for new threads", async () => {
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
        model: "gpt-5.5",
        modelProviderId: null,
      });

      expect(updatedThread.agent).toBe("codex");
      expect(updatedThread.model).toBe("gpt-5.5");

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
      nextModel: "gpt-5.4",
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
  ])("resets $sessionField on same-agent built-in model switches after messages", async ({
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
    expect(updatedThread[sessionField]).toBeNull();

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.[sessionField]).toBeNull();
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
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
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
    const rawThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(rawThread.pendingPlanEventId).toBeNull();
    expect(rawThread.pendingPlanContent).toBeNull();
    expect(rawThread.pendingPlanFilePath).toBeNull();
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
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
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
    expect(executionThread?.title).toBe("New Thread");
    expect(executionThread?.permissionMode).toBe("full_access");
    expect(executionThread?.permissionProfile).toBe("default");
    expect(executionThread?.agent).toBe("codex");
    expect(executionThread?.model).toBe("gpt-5.4");

    const persistedExecutionThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: result.executionThreadId },
    }) as any;
    expect(persistedExecutionThread.handoffSourceThreadId).toBe(thread.id);
    expect(persistedExecutionThread.handoffSourcePlanEventId).toBe(createdEvent.id);
    const persistedSourceThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(persistedSourceThread.pendingPlanEventId).toBeNull();
    expect(persistedSourceThread.pendingPlanContent).toBeNull();
    expect(persistedSourceThread.pendingPlanFilePath).toBeNull();
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
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
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
    const persistedSourceThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(persistedSourceThread.pendingPlanEventId).toBeNull();
    expect(persistedSourceThread.pendingPlanContent).toBeNull();
    expect(persistedSourceThread.pendingPlanFilePath).toBeNull();

    const executionThread = await chatService.getThreadById(result.executionThreadId);
    expect(executionThread?.agent).toBe("codex");
    expect(executionThread?.model).toBe("gpt-5.4");
    expect(executionThread?.codexSessionId).toBe("codex-forced-handoff-session");
  });

  it("approves a pending plan as a handoff, emits source approval, and starts execution on the handoff thread", async () => {
    const eventHub = createEventHub(prisma);
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: null,
    }));
    const codexRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("gpt-5.4");
      expect(sessionId).toBeNull();
      await onText("Codex executed the approved plan in the handoff thread");
      return {
        output: "Codex executed the approved plan in the handoff thread",
        sessionId: "codex-approved-plan-handoff-session",
      };
    });
    const logService = { log: vi.fn() };
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      codexRunner,
      modelProviderService: stubModelProviderService,
      logService,
    });
    const { thread, worktree } = await seedThread("Pending plan handoff approval");

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

    const planContent = "# Plan\n\n1. Implement the feature";
    const planFilePath = ".claude/plans/plan.md";
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: planContent,
      filePath: planFilePath,
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
      content: planContent,
      filePath: planFilePath,
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });
    const executionEvents = await waitForCompletion(chatService, result.executionThreadId);

    expect(result).toMatchObject({
      executionKind: "handoff",
      sourceThreadId: thread.id,
    });
    expect(result.executionThreadId).not.toBe(thread.id);
    expect(claudeRunner).not.toHaveBeenCalled();
    expect(codexRunner).toHaveBeenCalledTimes(1);

    const listedThreads = await chatService.listThreads(worktree.id);
    expect(listedThreads.map((listedThread) => listedThread.id)).toContain(result.executionThreadId);

    const sourceEvents = await chatService.listEvents(thread.id);
    expect(sourceEvents.some((event) =>
      event.type === "plan.approved"
      && event.payload.filePath === planFilePath,
    )).toBe(true);

    expect(executionEvents.some((event) =>
      event.type === "plan.approved"
      && event.payload.filePath === planFilePath,
    )).toBe(true);
    expect(executionEvents.some((event) => event.type === "chat.completed")).toBe(true);

    const executionMessages = await prisma.chatMessage.findMany({
      where: { threadId: result.executionThreadId },
      orderBy: { seq: "asc" },
    });
    expect(executionMessages[0]).toMatchObject({
      role: "assistant",
      content: planContent,
    });
    expect(executionMessages[1]).toMatchObject({
      role: "assistant",
      content: "Codex executed the approved plan in the handoff thread",
    });

    const persistedExecutionThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: result.executionThreadId },
    }) as any;
    expect(persistedExecutionThread.handoffSourceThreadId).toBe(thread.id);
    expect(persistedExecutionThread.handoffSourcePlanEventId).toBe(createdEvent.id);
    expect(logService.log).toHaveBeenCalledWith(
      "debug",
      "chat.plan.handoff",
      "Created handoff execution thread",
      expect.objectContaining({
        sourceThreadId: thread.id,
        executionThreadId: result.executionThreadId,
        title: "New Thread",
        planEventId: createdEvent.id,
      }),
      {
        worktreeId: worktree.id,
        threadId: result.executionThreadId,
      },
    );
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
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
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
        compatibility: "anthropic",
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
        name: "Remote Claude",
        compatibility: "anthropic",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
        models: {
          create: {
            modelId: "glm-4.7",
          },
        },
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
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
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
    const persistedSourceThread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(persistedSourceThread.pendingPlanEventId).toBeNull();
    expect(persistedSourceThread.pendingPlanContent).toBeNull();
    expect(persistedSourceThread.pendingPlanFilePath).toBeNull();

    const executionThread = await chatService.getThreadById(result.executionThreadId);
    expect(executionThread?.agent).toBe("claude");
    expect(executionThread?.model).toBe("claude-sonnet-4-6");
    expect(executionThread?.modelProviderId).toBeNull();
  });

  it("keeps approved-plan execution in the same review thread when the target selection did not change", async () => {
    const eventHub = createEventHub(prisma);
    const claudeRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("claude-sonnet-4-6");
      expect(sessionId).toBeNull();
      await onText("Executed the approved plan in-place");
      return {
        output: "Executed the approved plan in-place",
        sessionId: "claude-review-session",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { thread } = await seedThread("Review plan approval", "review");

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
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
    });
    await waitForCompletion(chatService, result.executionThreadId);

    expect(result).toEqual({
      executionKind: "same_thread_switch",
      sourceThreadId: thread.id,
      executionThreadId: thread.id,
    });
    expect(claudeRunner).toHaveBeenCalledTimes(1);
    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.claudeSessionId).toBe("claude-review-session");
    expect(persistedThread?.mode).toBe("default");
  });

  it("keeps provider-backed Claude plan approval in the same thread when the target selection did not change", async () => {
    const eventHub = createEventHub(prisma);
    const modelProviderService = createStubModelProviderService({
      "provider-claude-remote": {
        id: "provider-claude-remote",
        compatibility: "anthropic",
        apiKey: "provider-key",
        baseUrl: "https://provider.example.com/v1",
        name: "Remote Claude",
        modelId: "glm-4.7",
      },
    });
    const claudeRunner: ClaudeRunner = vi.fn(async ({ model, onText, sessionId }) => {
      expect(model).toBe("glm-4.7");
      expect(sessionId).toBe("claude-session-remote");
      await onText("Executed the provider-backed approved plan in-place");
      return {
        output: "Executed the provider-backed approved plan in-place",
        sessionId: "claude-session-remote",
      };
    });
    const chatService = createChatService({
      prisma,
      eventHub,
      claudeRunner,
      modelProviderService,
    });
    const { thread } = await seedThread("Provider-backed Claude in-place plan approval");
    await prisma.modelProvider.create({
      data: {
        id: "provider-claude-remote",
        name: "Remote Claude",
        compatibility: "anthropic",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
        models: {
          create: {
            modelId: "glm-4.7",
          },
        },
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
    const createdEvent = await eventHub.emit(thread.id, "plan.created", {
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });
    await persistPendingPlanState({
      threadId: thread.id,
      eventId: createdEvent.id,
      content: "# Plan\n\n1. Implement the feature",
      filePath: ".claude/plans/plan.md",
    });

    const result = await chatService.approvePlan(thread.id, {
      agent: "claude",
      model: "glm-4.7",
      modelProviderId: "provider-claude-remote",
    });
    await waitForCompletion(chatService, result.executionThreadId);

    expect(result).toEqual({
      executionKind: "same_thread_switch",
      sourceThreadId: thread.id,
      executionThreadId: thread.id,
    });
    expect(claudeRunner).toHaveBeenCalledTimes(1);

    const persistedThread = await chatService.getThreadById(thread.id);
    expect(persistedThread?.model).toBe("glm-4.7");
    expect(persistedThread?.modelProviderId).toBe("provider-claude-remote");
    expect(persistedThread?.claudeSessionId).toBe("claude-session-remote");
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
        compatibility: "openai",
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
        compatibility: "anthropic",
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
        name: "Remote Claude",
        compatibility: "anthropic",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
        models: {
          create: {
            modelId: "glm-4.7",
          },
        },
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
