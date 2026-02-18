import { PrismaClient } from "@prisma/client";
import type { ChatEvent } from "@codesymphony/shared-types";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createChatService } from "../src/services/chatService";
import { createLogService } from "../src/services/logService";
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

async function seedThread(title = "Main Thread"): Promise<{ threadId: string; worktreePath: string }> {
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

  it("auto renames default thread title after first assistant reply and emits threadTitle on completion", async () => {
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
    });
    const { threadId } = await seedThread();

    await chatService.sendMessage(threadId, {
      content: "i want you to find/search file README.md file and read if then summary it for me",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const completed = events.find((event) => event.type === "chat.completed");

    expect(completed).toBeDefined();
    expect(completed?.payload.threadTitle).toBe("Summarize README.md");

    const thread = await chatService.getThreadById(threadId);
    expect(thread?.title).toBe("Summarize README.md");
  });

  it("does not overwrite non-default thread title and still emits threadTitle on completion", async () => {
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
    });
    const { threadId } = await seedThread("Session Integrasi API");

    await chatService.sendMessage(threadId, {
      content: "Tolong cek rute auth",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const completed = events.find((event) => event.type === "chat.completed");
    expect(completed).toBeDefined();
    expect(completed?.payload.threadTitle).toBe("Session Integrasi API");

    const thread = await chatService.getThreadById(threadId);
    expect(thread?.title).toBe("Session Integrasi API");
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
    const claudeRunner: ClaudeRunner = vi.fn(async ({ onToolInstrumentation, onText }) => {
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

    await expect(
      chatService.resolvePermission(threadId, {
        requestId: "missing",
        decision: "deny",
      }),
    ).rejects.toThrow("Permission request not found");

    await chatService.resolvePermission(threadId, {
      requestId: "perm-3",
      decision: "allow",
    });

    await expect(
      chatService.resolvePermission(threadId, {
        requestId: "perm-3",
        decision: "deny",
      }),
    ).rejects.toThrow("Permission request not found");

    await waitForTerminalEvent(chatService, threadId);
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

  it("rejects stop when no active run exists", async () => {
    const claudeRunner: ClaudeRunner = vi.fn(async () => ({
      output: "",
      sessionId: "session-noop",
    }));

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
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
});
