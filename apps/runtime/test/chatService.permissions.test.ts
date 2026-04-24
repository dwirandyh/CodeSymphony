import { PrismaClient } from "@prisma/client";
import type { ChatEvent, ChatThreadPermissionProfile } from "@codesymphony/shared-types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chat";
import { createLogService } from "../src/services/logService";
import type { ClaudeRunner } from "../src/types";
import * as gitService from "../src/services/git.js";
import { buildPromptWithAttachments } from "../src/services/chat/chatAttachmentUtils";

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
  await prisma.modelProvider.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

async function seedThread(
  title = "New Thread",
  options?: { kind?: "default" | "review"; permissionProfile?: ChatThreadPermissionProfile },
): Promise<{ threadId: string; worktreePath: string }> {
  const suffix = uniqueSuffix();
  const worktreePath = `/tmp/codesymphony-worktree-${suffix}`;
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
  mkdirSync(worktreePath, { recursive: true });
  const thread = await prisma.chatThread.create({
    data: {
      worktreeId: worktree.id,
      title,
      kind: options?.kind ?? "default",
      permissionProfile: options?.permissionProfile ?? (options?.kind === "review" ? "review_git" : "default"),
    },
  });

  return { threadId: thread.id, worktreePath };
}

async function waitForTerminalEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  timeoutMs = 4000,
  afterIdx?: number,
): Promise<ChatEvent[]> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId, afterIdx);
    const done = events.some((event) => event.type === "chat.completed" || event.type === "chat.failed");
    if (done) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for assistant completion");
}

async function waitForEvent(
  chatService: ReturnType<typeof createChatService>,
  threadId: string,
  matcher: (event: ChatEvent) => boolean,
  timeoutMs = 4000,
): Promise<ChatEvent> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const events = await chatService.listEvents(threadId);
    const matched = events.find(matcher);
    if (matched) {
      return matched;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for matching event");
}

describe("chatService permission flow", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not emit integrity warning and keeps plain assistant output", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Flutter analyze status");
        return {
          output: "Flutter analyze status",
          sessionId: null,
        };
      }

      await onText("Siap, saya jalankan flutter analyze sekarang.");
      return {
        output: "Siap, saya jalankan flutter analyze sekarang.",
        sessionId: "session-no-guard",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan flutter analyze ya",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "tool.finished"
          && String(event.payload.source ?? "") === "integrity.warning",
      ),
    ).toBe(false);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toContain("Siap, saya jalankan flutter analyze sekarang.");
    expect(assistantMessage?.content).not.toContain("runtime-integrity-warning");
    expect(claudeRunner).toHaveBeenCalledTimes(2);
  });

  it("passes autoAcceptTools for full access threads", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ autoAcceptTools, onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Permission test");
        return {
          output: "Permission test",
          sessionId: null,
        };
      }

      expect(autoAcceptTools).toBe(true);
      await onText("Berhasil.");
      return {
        output: "Berhasil.",
        sessionId: "session-full-access",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();
    await chatService.updateThreadPermissionMode(threadId, { permissionMode: "full_access" });

    await chatService.sendMessage(threadId, {
      content: "jalankan task tanpa prompt approval",
    });

    await waitForTerminalEvent(chatService, threadId);
    expect(claudeRunner).toHaveBeenCalled();
  });

  it("auto-approves permission requests for full access threads without emitting prompts", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Full access approval");
        return {
          output: "Full access approval",
          sessionId: null,
        };
      }

      const decision = await onPermissionRequest({
        requestId: "perm-full-access",
        toolName: "Bash",
        toolInput: {
          command: "echo full-access",
        },
        blockedPath: null,
        decisionReason: null,
        suggestions: null,
        subagentOwnerToolUseId: null,
        launcherToolUseId: null,
      });
      expect(decision).toEqual({ decision: "allow" });

      await onText("Command auto-approved.");
      return {
        output: "Command auto-approved.",
        sessionId: "session-full-access-permission",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();
    await chatService.updateThreadPermissionMode(threadId, { permissionMode: "full_access" });

    await chatService.sendMessage(threadId, {
      content: "run a command without approval UI",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
    expect(events.some((event) => event.type === "permission.resolved")).toBe(false);
  });

  it("auto-approves in-worktree edit permission requests without user prompt", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Workspace edit");
        return {
          output: "Workspace edit",
          sessionId: null,
        };
      }

      const decision = await onPermissionRequest({
        requestId: "perm-worktree-edit",
        toolName: "Edit",
        toolInput: {
          file_path: "src/main.ts",
          old_string: "before",
          new_string: "after",
        },
        blockedPath: "src/main.ts",
        decisionReason: "Path requires approval",
        suggestions: null,
        subagentOwnerToolUseId: null,
        launcherToolUseId: null,
      });
      expect(decision).toEqual({ decision: "allow" });

      await onText("Edited inside workspace.");
      return {
        output: "Edited inside workspace.",
        sessionId: "session-workspace-edit",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "edit src/main.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
    expect(events.some((event) => event.type === "permission.resolved")).toBe(false);
  });

  it("auto renames default thread title after first assistant reply via metadata event", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Summarize README.md");
        return {
          output: "Summarize README.md",
          sessionId: null,
        };
      }

      await onText("Siap.");
      return {
        output: "Siap.",
        sessionId: "session-thread-title-auto",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "i want you to find/search file README.md file and read if then summary it for me",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const completed = events.find((event) => event.type === "chat.completed");

    expect(completed).toBeDefined();
    expect(completed?.payload.threadTitle).toBeUndefined();

    const titleEvent = await waitForEvent(
      chatService,
      threadId,
      (event) =>
        event.type === "tool.finished"
        && String(event.payload.source ?? "") === "chat.thread.metadata"
        && String(event.payload.threadTitle ?? "") === "Summarize README.md",
    );
    expect(titleEvent.payload.threadTitle).toBe("Summarize README.md");

    const thread = await chatService.getThreadById(threadId);
    expect(thread?.title).toBe("Summarize README.md");
  });

  it("passes selected provider config to AI title generation", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({
      onText,
      prompt,
      model,
      providerApiKey,
      providerBaseUrl,
    }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        expect(model).toBe("claude-3-7-sonnet");
        expect(providerApiKey).toBe("provider-key");
        expect(providerBaseUrl).toBe("https://provider.example.com/v1");
        await onText("Provider-aware title");
        return {
          output: "Provider-aware title",
          sessionId: null,
        };
      }

      await onText("Siap.");
      return {
        output: "Siap.",
        sessionId: "session-provider-title",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: {
        getActiveProvider: async () => ({
          id: "provider-1",
          agent: "claude",
          apiKey: "provider-key",
          baseUrl: "https://provider.example.com/v1",
          name: "Custom Provider",
          modelId: "claude-3-7-sonnet",
        }),
        getProviderById: async () => ({
          id: "provider-1",
          agent: "claude",
          apiKey: "provider-key",
          baseUrl: "https://provider.example.com/v1",
          name: "Custom Provider",
          modelId: "claude-3-7-sonnet",
          isActive: true,
        }),
      },
    });
    const { threadId } = await seedThread();
    await prisma.modelProvider.create({
      data: {
        id: "provider-1",
        agent: "claude",
        name: "Custom Provider",
        modelId: "claude-3-7-sonnet",
        baseUrl: "https://provider.example.com/v1",
        apiKey: "provider-key",
        isActive: true,
      },
    });
    await prisma.chatThread.update({
      where: { id: threadId },
      data: {
        agent: "claude",
        model: "claude-3-7-sonnet",
        modelProviderId: "provider-1",
      },
    });

    await chatService.sendMessage(threadId, {
      content: "Summarize project setup flow",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) =>
        event.type === "tool.finished"
        && String(event.payload.source ?? "") === "chat.thread.metadata"
        && String(event.payload.threadTitle ?? "") === "Provider-aware title",
    );
  });

  it("does not overwrite non-default thread title and emits no metadata title event", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      await onText("Done.");
      return {
        output: "Done.",
        sessionId: "session-thread-title-preserve",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread("Session Integrasi API");

    await chatService.sendMessage(threadId, {
      content: "Tolong cek rute auth",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const completed = events.find((event) => event.type === "chat.completed");
    expect(completed).toBeDefined();
    expect(completed?.payload.threadTitle).toBeUndefined();

    const metadataTitleEvent = events.find(
      (event) =>
        event.type === "tool.finished"
        && String(event.payload.source ?? "") === "chat.thread.metadata"
        && typeof event.payload.threadTitle === "string",
    );
    expect(metadataTitleEvent).toBeUndefined();

    const thread = await chatService.getThreadById(threadId);
    expect(thread?.title).toBe("Session Integrasi API");
  });

  it("emits chat.completed before delayed auto title metadata and allows immediate next message", async () => {
    let releaseTitleGeneration: (() => void) | null = null;
    const titleGenerationStarted = new Promise<void>((resolve) => {
      releaseTitleGeneration = resolve;
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await titleGenerationStarted;
        await onText("Async title");
        return {
          output: "Async title",
          sessionId: null,
        };
      }

      await onText("First reply.");
      return {
        output: "First reply.",
        sessionId: "session-async-title",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "please summarize this thread",
    });

    const completed = await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "chat.completed",
    );
    expect(completed.payload.threadTitle).toBeUndefined();

    const threadAfterCompletion = await chatService.getThreadById(threadId);
    expect(threadAfterCompletion?.active).toBe(false);

    const secondMessage = await chatService.sendMessage(threadId, {
      content: "second message right away",
    });
    expect(secondMessage.role).toBe("user");

    releaseTitleGeneration?.();

    const titleEvent = await waitForEvent(
      chatService,
      threadId,
      (event) =>
        event.type === "tool.finished"
        && String(event.payload.source ?? "") === "chat.thread.metadata"
        && String(event.payload.threadTitle ?? "") === "Async title",
    );
    expect(titleEvent.payload.threadTitle).toBe("Async title");

    const eventsAfterSecondMessage = await waitForTerminalEvent(
      chatService,
      threadId,
      4000,
      completed.idx,
    );
    expect(eventsAfterSecondMessage.some((event) => event.type === "chat.completed")).toBe(true);
  });

  it("does not overwrite a manual thread title if delayed auto rename finishes later", async () => {
    let releaseTitleGeneration: (() => void) | null = null;
    const titleGenerationStarted = new Promise<void>((resolve) => {
      releaseTitleGeneration = resolve;
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await titleGenerationStarted;
        await onText("Delayed auto title");
        return {
          output: "Delayed auto title",
          sessionId: null,
        };
      }

      await onText("First reply.");
      return {
        output: "First reply.",
        sessionId: "session-manual-wins",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "please rename this thread",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "chat.completed",
    );

    const renamed = await chatService.renameThreadTitle(threadId, { title: "Manual title" });
    expect(renamed.title).toBe("Manual title");

    releaseTitleGeneration?.();
    await waitForTerminalEvent(chatService, threadId, 4000);

    const events = await chatService.listEvents(threadId);
    const metadataTitleEvent = events.find(
      (event) =>
        event.type === "tool.finished"
        && String(event.payload.source ?? "") === "chat.thread.metadata"
        && String(event.payload.threadTitle ?? "") === "Delayed auto title",
    );
    expect(metadataTitleEvent).toBeUndefined();

    const thread = await chatService.getThreadById(threadId);
    expect(thread?.title).toBe("Manual title");
  });

  it("emits permission requested and proceeds after approve", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onToolStarted, onToolFinished, onText }) => {
      const decision = await onPermissionRequest({
        requestId: "perm-1",
        toolName: "Bash",
        toolInput: { command: "cat /etc/hosts" },
        blockedPath: "/etc/hosts",
        decisionReason: "Path outside project directory",
        suggestions: [{ type: "addRules" }],
      });

      if (decision.decision === "allow") {
        await onToolStarted({
          toolName: "Bash",
          toolUseId: "tool-1",
          parentToolUseId: null,
        });
        await onToolFinished({
          summary: "Ran cat /etc/hosts",
          precedingToolUseIds: ["tool-1"],
        });
        await onText("Perintah berhasil dijalankan.");
      }

      return {
        output: "Perintah berhasil dijalankan.",
        sessionId: "session-approve",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan bash untuk baca /etc/hosts",
    });

    const requested = await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-1",
    );
    expect(requested.payload.toolName).toBe("Bash");
    expect(requested.payload.ownershipReason).toBeNull();
    expect(requested.payload.ownershipCandidates).toEqual([]);

    await chatService.resolvePermission(threadId, {
      requestId: "perm-1",
      decision: "allow",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(
      events.some((event) => event.type === "permission.resolved" && event.payload.requestId === "perm-1"),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool.started")).toBe(true);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toContain("Perintah berhasil dijalankan.");
  });

  it("persists bash command output metadata in tool events", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onToolStarted, onToolFinished, onText }) => {
      await onToolStarted({
        toolName: "Bash",
        toolUseId: "tool-metadata",
        parentToolUseId: null,
        command: "git status --short",
        shell: "bash",
        isBash: true,
      });

      await onToolFinished({
        summary: "Ran git status --short",
        precedingToolUseIds: ["tool-metadata"],
        command: "git status --short",
        output: "M README.md",
        error: "",
        shell: "bash",
        isBash: true,
        truncated: false,
        outputBytes: 11,
      });

      await onText("Done.");
      return {
        output: "Done.",
        sessionId: "session-metadata",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "cek status git",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const started = events.find((event) => event.type === "tool.started");
    const finished = events.find((event) => event.type === "tool.finished" && event.payload.summary === "Ran git status --short");

    expect(started?.payload.command).toBe("git status --short");
    expect(started?.payload.isBash).toBe(true);
    expect(finished?.payload.command).toBe("git status --short");
    expect(finished?.payload.output).toBe("M README.md");
    expect(finished?.payload.error).toBe("");
    expect(finished?.payload.truncated).toBe(false);
    expect(finished?.payload.outputBytes).toBe(11);
  });

  it("writes tool instrumentation logs with thread context", async () => {
    const runtimeLogService = createLogService();
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onToolInstrumentation, onText, permissionProfile }) => {
      expect(permissionProfile).toBe("default");
      await onToolInstrumentation?.({
        stage: "requested",
        toolUseId: "tool-log-1",
        toolName: "Read",
        parentToolUseId: null,
        preview: {
          input: {
            path: "README.md",
          },
        },
      });
      await onToolInstrumentation?.({
        stage: "anomaly",
        toolUseId: "tool-log-1",
        toolName: "Read",
        parentToolUseId: null,
        anomaly: {
          code: "started_not_finished",
          message: "Tool started but no finish event was observed.",
        },
      });
      await onText("Done.");
      return {
        output: "Done.",
        sessionId: "session-log-instrumentation",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      logService: runtimeLogService,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "cek instrumentation",
    });

    await waitForTerminalEvent(chatService, threadId);

    const entries = runtimeLogService.getEntries();
    const lifecycleEntry = entries.find((entry) => entry.source === "claude.tool");
    const anomalyEntry = entries.find((entry) => entry.source === "claude.tool.sync");
    expect(lifecycleEntry).toBeDefined();
    expect(anomalyEntry).toBeDefined();
    expect((lifecycleEntry?.data as Record<string, unknown>).threadId).toBe(threadId);
    expect((lifecycleEntry?.data as Record<string, unknown>).toolUseId).toBe("tool-log-1");
    expect((anomalyEntry?.data as Record<string, unknown>).stage).toBe("anomaly");
  });

  it("creates or reuses dedicated PR/MR threads with review git profile", async () => {
    const resolveReviewRemoteMock = vi.spyOn(gitService, "resolveReviewRemote")
      .mockResolvedValue({ remote: "origin", remoteUrl: "https://github.com/acme/repo", provider: "github" });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(async () => ({ output: "", sessionId: null })),
      modelProviderService: stubModelProviderService,
    });

    const { threadId, worktreePath } = await seedThread("PR / MR", { kind: "review", permissionProfile: "default" });
    const existingThread = await prisma.chatThread.findUnique({ where: { id: threadId } });
    const reused = await chatService.getOrCreatePrMrThread(existingThread!.worktreeId);

    expect(reused.id).toBe(threadId);
    expect(reused.kind).toBe("review");
    expect(reused.permissionProfile).toBe("review_git");
    expect(reused.title).toBe("Create Pull Request");
    expect(resolveReviewRemoteMock).toHaveBeenCalledTimes(1);

    const suffix = uniqueSuffix();
    const repository = await prisma.repository.create({
      data: {
        name: `repo-review-${suffix}`,
        rootPath: `/tmp/codesymphony-root-review-${suffix}`,
        defaultBranch: "main",
      },
    });
    const worktree = await prisma.worktree.create({
      data: {
        repositoryId: repository.id,
        branch: "feature/review",
        baseBranch: "main",
        path: `${worktreePath}-new-${suffix}`,
        status: "active",
      },
    });
    mkdirSync(worktree.path, { recursive: true });

    const created = await chatService.getOrCreatePrMrThread(worktree.id);
    expect(created.kind).toBe("review");
    expect(created.permissionProfile).toBe("review_git");
    expect(created.title).toBe("Create Pull Request");
  });

  it("creates GitLab review threads with merge request title and preserves custom titles", async () => {
    const resolveReviewRemoteMock = vi.spyOn(gitService, "resolveReviewRemote")
      .mockResolvedValue({ remote: "origin", remoteUrl: "https://gitlab.com/acme/repo", provider: "gitlab" });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner: vi.fn(async () => ({ output: "", sessionId: null })),
      modelProviderService: stubModelProviderService,
    });

    const suffix = uniqueSuffix();
    const repository = await prisma.repository.create({
      data: {
        name: `repo-gitlab-${suffix}`,
        rootPath: `/tmp/codesymphony-root-gitlab-${suffix}`,
        defaultBranch: "main",
      },
    });
    const worktree = await prisma.worktree.create({
      data: {
        repositoryId: repository.id,
        branch: "feature/gitlab",
        baseBranch: "main",
        path: `/tmp/codesymphony-worktree-gitlab-${suffix}`,
        status: "active",
      },
    });
    mkdirSync(worktree.path, { recursive: true });

    const created = await chatService.getOrCreatePrMrThread(worktree.id);
    expect(created.title).toBe("Create Merge Request");
    expect(created.permissionProfile).toBe("review_git");

    const custom = await prisma.chatThread.create({
      data: {
        worktreeId: worktree.id,
        title: "Release Review",
        titleEditedManually: true,
        kind: "review",
        permissionProfile: "default",
        mode: "default",
      },
    });

    const reused = await chatService.getOrCreatePrMrThread(worktree.id);
    expect(reused.id).toBe(custom.id);
    expect(reused.title).toBe("Release Review");
    expect(reused.permissionProfile).toBe("review_git");
    expect(resolveReviewRemoteMock).toHaveBeenCalledTimes(1);
  });

  it("emits permission requested and proceeds with deny decision", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText }) => {
      const decision = await onPermissionRequest({
        requestId: "perm-2",
        toolName: "Bash",
        toolInput: { command: "cat /etc/hosts" },
        blockedPath: "/etc/hosts",
        decisionReason: "Path outside project directory",
        suggestions: [{ type: "addRules" }],
      });

      if (decision.decision === "deny") {
        await onText(`Ditolak user: ${decision.message ?? "unknown"}`);
      }

      return {
        output: "Unexpected",
        sessionId: "session-deny",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan bash untuk baca /etc/hosts",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-2",
    );

    await chatService.resolvePermission(threadId, {
      requestId: "perm-2",
      decision: "deny",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(events.some((event) => event.type === "permission.resolved")).toBe(true);
    const resolvedEvent = events.find(
      (event) => event.type === "permission.resolved" && event.payload.requestId === "perm-2",
    );
    expect(resolvedEvent?.payload.ownershipReason).toBeNull();
    expect(resolvedEvent?.payload.ownershipCandidates).toEqual([]);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toContain("Tool execution denied by user.");
  });

  it("rejects duplicate or missing permission resolve", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText }) => {
      const decision = await onPermissionRequest({
        requestId: "perm-3",
        toolName: "Bash",
        toolInput: { command: "cat /etc/hosts" },
        blockedPath: "/etc/hosts",
        decisionReason: "Path outside project directory",
        suggestions: [{ type: "addRules" }],
      });

      await onText(`Decision: ${decision.decision}`);
      return {
        output: `Decision: ${decision.decision}`,
        sessionId: "session-resolve-errors",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan bash untuk baca /etc/hosts",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-3",
    );

    // Missing requestId should resolve gracefully (emit dismissal event, not throw)
    await chatService.resolvePermission(threadId, {
      requestId: "missing",
      decision: "deny",
    });

    await chatService.resolvePermission(threadId, {
      requestId: "perm-3",
      decision: "allow",
    });

    // Already-resolved requestId should be ignored silently (no second resolution event)
    await chatService.resolvePermission(threadId, {
      requestId: "perm-3",
      decision: "deny",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const resolvedEvents = events.filter((event) => event.type === "permission.resolved" && event.payload.requestId === "perm-3");
    expect(resolvedEvents).toHaveLength(1);
  });

  it("treats duplicate permission callback for same requestId as idempotent", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText }) => {
      const first = onPermissionRequest({
        requestId: "perm-dup",
        toolName: "Bash",
        toolInput: { command: "flutter analyze" },
        blockedPath: null,
        decisionReason: "Tool requires approval",
        suggestions: [],
      });
      const second = onPermissionRequest({
        requestId: "perm-dup",
        toolName: "Bash",
        toolInput: { command: "flutter analyze" },
        blockedPath: null,
        decisionReason: "Tool requires approval",
        suggestions: [],
      });

      const [firstDecision, secondDecision] = await Promise.all([first, second]);
      await onText(`Decisions: ${firstDecision.decision}/${secondDecision.decision}`);
      return {
        output: `Decisions: ${firstDecision.decision}/${secondDecision.decision}`,
        sessionId: "session-dup",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan flutter analyze ya",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-dup",
    );

    await chatService.resolvePermission(threadId, {
      requestId: "perm-dup",
      decision: "allow",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const requestEvents = events.filter(
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-dup",
    );
    expect(requestEvents.length).toBe(1);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toContain("Decisions: allow/allow");
  });

  it("stops active run and keeps partial assistant output", async () => {
    let receivedAbortController: AbortController | undefined;
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, abortController }) => {
      receivedAbortController = abortController;
      if (!abortController) {
        throw new Error("Missing abort controller");
      }

      await onText("Partial output before stop.");

      await new Promise<void>((resolve) => {
        if (abortController.signal.aborted) {
          resolve();
          return;
        }
        abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      throw new Error("Aborted by user.");
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "tolong jalankan proses lama",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) =>
        event.type === "message.delta"
        && event.payload.role === "assistant"
        && String(event.payload.delta ?? "").includes("Partial output before stop."),
    );

    await chatService.stopRun(threadId);

    const events = await waitForTerminalEvent(chatService, threadId);
    const completedEvent = events.find((event) => event.type === "chat.completed" && event.payload.cancelled === true);
    expect(completedEvent).toBeDefined();
    expect(events.some((event) => event.type === "chat.failed")).toBe(false);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toBe("Partial output before stop.");
    expect(assistantMessage?.content).not.toContain("[runtime-error]");
    expect(receivedAbortController).toBeDefined();
    expect(receivedAbortController?.signal.aborted).toBe(true);
  });

  it("stops run while waiting for question without aborting controller", async () => {
    let receivedAbortController: AbortController | undefined;
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onQuestionRequest, abortController }) => {
      receivedAbortController = abortController;
      if (!abortController) {
        throw new Error("Missing abort controller");
      }

      await onQuestionRequest({
        requestId: "q-stop-1",
        questions: [{ question: "Continue with the task?" }],
      });

      return {
        output: "Unexpected completion",
        sessionId: "session-stop-question",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "ask me first before continuing",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "question.requested" && event.payload.requestId === "q-stop-1",
    );

    await chatService.stopRun(threadId);

    const events = await waitForTerminalEvent(chatService, threadId);
    const completedEvent = events.find((event) => event.type === "chat.completed" && event.payload.cancelled === true);
    expect(completedEvent).toBeDefined();
    expect(events.some((event) => event.type === "chat.failed")).toBe(false);
    expect(receivedAbortController).toBeDefined();
    expect(receivedAbortController?.signal.aborted).toBe(false);
  });

  it("rejects stop when no active run exists", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: "session-noop",
    }));

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await expect(chatService.stopRun(threadId)).rejects.toThrow("No active assistant run for this thread");
  });

  it("persists allow_always rule to local workspace settings", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText }) => {
      const firstDecision = await onPermissionRequest({
        requestId: "perm-always-1",
        toolName: "Bash",
        toolInput: { command: "flutter analyze" },
        blockedPath: null,
        decisionReason: "Tool requires approval",
        suggestions: [],
      });

      await onText(`Decision: ${firstDecision.decision}`);
      return {
        output: `Decision: ${firstDecision.decision}`,
        sessionId: "session-always",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId, worktreePath } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan flutter analyze ya",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-always-1",
    );

    await chatService.resolvePermission(threadId, {
      requestId: "perm-always-1",
      decision: "allow_always",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(
      events.some(
        (event) =>
          event.type === "permission.resolved"
          && event.payload.requestId === "perm-always-1"
          && event.payload.decision === "allow_always",
      ),
    ).toBe(true);

    const messages = await chatService.listMessages(threadId);
    const assistantMessage = messages.find((message) => message.role === "assistant");
    expect(assistantMessage?.content).toContain("Decision: allow");

    const settingsPath = join(worktreePath, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
    };
    expect(settings.permissions?.allow).toContain("Bash(flutter analyze:*)");
  });

  it("returns error for allow_always when local settings file has invalid JSON", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPermissionRequest, onText }) => {
      const decision = await onPermissionRequest({
        requestId: "perm-always-invalid",
        toolName: "Bash",
        toolInput: { command: "flutter analyze" },
        blockedPath: null,
        decisionReason: "Tool requires approval",
        suggestions: [],
      });

      await onText(`Decision: ${decision.decision}`);
      return {
        output: `Decision: ${decision.decision}`,
        sessionId: "session-always-invalid",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId, worktreePath } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "jalankan flutter analyze ya",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "permission.requested" && event.payload.requestId === "perm-always-invalid",
    );

    const settingsDir = join(worktreePath, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.local.json"), "{invalid json", "utf8");

    await expect(
      chatService.resolvePermission(threadId, {
        requestId: "perm-always-invalid",
        decision: "allow_always",
      }),
    ).rejects.toThrow("Invalid JSON in");

    await chatService.resolvePermission(threadId, {
      requestId: "perm-always-invalid",
      decision: "allow",
    });

    await waitForTerminalEvent(chatService, threadId);
  });

  it("does not emit question.requested events in default (execute) mode", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      await onText("I will proceed with my best judgment.");
      return {
        output: "I will proceed with my best judgment.",
        sessionId: "session-no-question",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "do something complex",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(events.some((event) => event.type === "question.requested")).toBe(false);

    const calledArgs = (claudeRunner as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledArgs.permissionMode).toBe("default");
  });

  it("emits question.requested events in plan mode", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onQuestionRequest, onText, permissionMode }) => {
      if (permissionMode === "plan") {
        const result = await onQuestionRequest({
          requestId: "q-plan-1",
          questions: [{ question: "Which approach do you prefer?" }],
        });
        await onText(`User chose: ${JSON.stringify(result.answers)}`);
        return {
          output: `User chose: ${JSON.stringify(result.answers)}`,
          sessionId: "session-plan-question",
        };
      }

      await onText("Done.");
      return { output: "Done.", sessionId: "session-plan-q" };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "plan something",
      mode: "plan",
    });

    const questionEvent = await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "question.requested" && event.payload.requestId === "q-plan-1",
    );
    expect(questionEvent).toBeDefined();
    expect(questionEvent.payload.questions).toHaveLength(1);

    await chatService.answerQuestion(threadId, {
      requestId: "q-plan-1",
      answers: { "0": "Option A" },
    });

    await waitForTerminalEvent(chatService, threadId);
  });

  it("dismisses pending plan question and cancels the active run", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onQuestionRequest, onText, permissionMode }) => {
      if (permissionMode === "plan") {
        try {
          await onQuestionRequest({
            requestId: "q-dismiss-1",
            questions: [{ question: "Which approach do you prefer?" }],
          });
        } catch {
          // Dismiss path cancels the waiting question.
        }

        await onText("Question flow ended.");
        return {
          output: "Question flow ended.",
          sessionId: "session-plan-dismiss",
        };
      }

      await onText("Done.");
      return { output: "Done.", sessionId: "session-plan-dismiss-default" };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "plan something",
      mode: "plan",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "question.requested" && event.payload.requestId === "q-dismiss-1",
    );

    await chatService.dismissQuestion(threadId, {
      requestId: "q-dismiss-1",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const dismissed = events.find((event) => event.type === "question.dismissed" && event.payload.requestId === "q-dismiss-1");
    expect(dismissed).toBeDefined();
    expect(dismissed?.payload.persisted).toBe(true);

    const completed = events.find((event) => event.type === "chat.completed");
    expect(completed).toBeDefined();
  });

  it("records stale dismisses as non-persisted and keeps run stable", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onQuestionRequest, onText, permissionMode }) => {
      if (permissionMode === "plan") {
        const result = await onQuestionRequest({
          requestId: "q-stale-1",
          questions: [{ question: "Pick one" }],
        });
        await onText(`Answer: ${JSON.stringify(result.answers)}`);
        return {
          output: `Answer: ${JSON.stringify(result.answers)}`,
          sessionId: "session-plan-stale-dismiss",
        };
      }

      await onText("Done.");
      return { output: "Done.", sessionId: "session-plan-stale-dismiss-default" };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "plan something",
      mode: "plan",
    });

    await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "question.requested" && event.payload.requestId === "q-stale-1",
    );

    await chatService.answerQuestion(threadId, {
      requestId: "q-stale-1",
      answers: { "0": "Option A" },
    });

    await waitForTerminalEvent(chatService, threadId);

    await chatService.dismissQuestion(threadId, {
      requestId: "q-stale-1",
    });

    const staleDismissed = await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "question.dismissed" && event.payload.requestId === "q-stale-1" && event.payload.persisted === false,
    );

    expect(staleDismissed.payload.resolver).toBe("system");
  });

  it("dismisses a pending plan and records a persisted lifecycle event", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onPlanFileDetected, onText, permissionMode }) => {
      if (permissionMode === "plan") {
        await onText("Drafting plan...");
        await onPlanFileDetected({
          filePath: ".claude/plans/plan.md",
          content: "# Plan\n\n1. Ship it",
          source: "claude_plan_file",
        });
        await onText("# Plan\n\n1. Ship it");
        return {
          output: "# Plan\n\n1. Ship it",
          sessionId: "session-plan-dismissed",
        };
      }

      await onText("Done.");
      return { output: "Done.", sessionId: "session-plan-dismissed-default" };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "plan something",
      mode: "plan",
    });

    await waitForTerminalEvent(chatService, threadId);

    await chatService.dismissPlan(threadId, {});

    const dismissed = await waitForEvent(
      chatService,
      threadId,
      (event) => event.type === "plan.dismissed" && event.payload.filePath === ".claude/plans/plan.md",
    );

    expect(dismissed.payload.reason).toBe("Plan dismissed by user.");
  });

  it("normalizes relative file mentions against the selected worktree root before scheduling the assistant", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ prompt, cwd, onText }) => {
      expect(cwd).toContain("codesymphony-worktree-");
      expect(prompt).toContain(`${cwd}/packages/design_system/widgetbook/README.md`);
      expect(prompt).not.toContain("@file:packages/design_system/widgetbook/README.md");
      await onText("Siap.");
      return {
        output: "Siap.",
        sessionId: "session-mention-normalized",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId, worktreePath } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "coba baca file @file:packages/design_system/widgetbook/README.md jelaskan",
    });

    await waitForTerminalEvent(chatService, threadId);
    expect(claudeRunner).toHaveBeenCalledWith(expect.objectContaining({
      cwd: worktreePath,
    }));
  });

  it("preserves filename-only chip rendering while expanding prompt mentions for the agent", () => {
    const prompt = buildPromptWithAttachments(
      "coba baca file @file:packages/design_system/widgetbook/README.md jelaskan",
      [],
      { workspaceRoot: "/Users/dwirandyh/Work/likearthstudio/finly_app" },
    );

    expect(prompt).toContain("/Users/dwirandyh/Work/likearthstudio/finly_app/packages/design_system/widgetbook/README.md");
    expect(prompt).not.toContain("@file:packages/design_system/widgetbook/README.md");
  });

  it("stores image attachments outside the worktree", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, prompt }) => {
      if (prompt.includes("You generate concise chat thread titles.")) {
        await onText("Image attachment");
        return {
          output: "Image attachment",
          sessionId: null,
        };
      }

      await onText("Noted.");
      return {
        output: "Noted.",
        sessionId: "session-image-attachment",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const { threadId, worktreePath } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "",
      attachments: [
        {
          filename: "Home.png",
          mimeType: "image/png",
          content: Buffer.from("fake-image").toString("base64"),
          source: "clipboard_image",
        },
      ],
    });

    await waitForTerminalEvent(chatService, threadId);

    const attachment = await prisma.chatAttachment.findFirst({
      where: {
        message: {
          threadId,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    expect(attachment?.storagePath).toBeTruthy();
    expect(attachment?.storagePath?.startsWith(worktreePath)).toBe(false);
    expect(attachment?.storagePath?.includes("/.codesymphony/attachments/")).toBe(true);
    expect(existsSync(attachment!.storagePath!)).toBe(true);
    expect(existsSync(join(worktreePath, ".codesymphony"))).toBe(false);
  });

});
