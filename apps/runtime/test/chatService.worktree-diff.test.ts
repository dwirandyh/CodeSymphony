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

function worktreeDiffEvents(events: ChatEvent[]): ChatEvent[] {
  return events.filter((event) => event.type === "tool.finished" && event.payload.source === "worktree.diff");
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

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Edit",
        toolUseId: "edit-b",
        parentToolUseId: null,
        editTarget: "src/b.ts",
      });
      writeFileSync(join(worktreePath, "src/b.ts"), "export const b = 2;\n", "utf8");
      await onToolFinished({
        toolName: "Edit",
        summary: "Edited src/b.ts",
        precedingToolUseIds: ["edit-b"],
        editTarget: "src/b.ts",
        toolInput: {
          file_path: "src/b.ts",
          old_string: "export const b = 1;\n",
          new_string: "export const b = 2;\n",
        },
      });
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

  it("emits edit-owned worktree diff before later tool activity in the same run", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = 1;\n",
      "src/helper.ts": "export const helper = 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Edit",
        toolUseId: "edit-main",
        parentToolUseId: null,
        editTarget: "src/main.ts",
      });
      writeFileSync(join(worktreePath, "src/main.ts"), "export const main = 2;\n", "utf8");
      await onToolFinished({
        toolName: "Edit",
        summary: "Edited src/main.ts",
        precedingToolUseIds: ["edit-main"],
        editTarget: "src/main.ts",
        toolInput: {
          file_path: "src/main.ts",
          old_string: "export const main = 1;\n",
          new_string: "export const main = 2;\n",
        },
      });
      await onToolStarted({
        toolName: "Read",
        toolUseId: "read-helper",
        parentToolUseId: null,
      });
      await onToolFinished({
        toolName: "Read",
        summary: "Read src/helper.ts",
        precedingToolUseIds: ["read-helper"],
      });
      await onText("Updated src/main.ts and inspected src/helper.ts");
      return {
        output: "Updated src/main.ts and inspected src/helper.ts",
        sessionId: "session-worktree-edit-midrun",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Mid-run Edit Diff");

    await chatService.sendMessage(threadId, {
      content: "update src/main.ts and then inspect src/helper.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvents = worktreeDiffEvents(events);
    const readStartedEvent = events.find((event) => (
      event.type === "tool.started" && event.payload.toolUseId === "read-helper"
    ));
    const completedEvent = events.find((event) => event.type === "chat.completed");

    expect(diffEvents).toHaveLength(1);
    expect(readStartedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    expect((diffEvents[0]?.idx ?? Number.POSITIVE_INFINITY)).toBeLessThan(readStartedEvent?.idx ?? Number.NEGATIVE_INFINITY);
    expect((diffEvents[0]?.idx ?? Number.POSITIVE_INFINITY)).toBeLessThan(completedEvent?.idx ?? Number.NEGATIVE_INFINITY);
    expect(diffEvents[0]?.payload.changedFiles).toEqual(["src/main.ts"]);
    expect(diffEvents[0]?.payload.precedingToolUseIds).toEqual(["edit-main"]);
    expect(diffEvents[0]?.payload.diff).toContain("diff --git a/src/main.ts b/src/main.ts");
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

  it("does not emit worktree diff for read-only runs when unrelated files change during the run", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText }) => {
      writeFileSync(join(worktreePath, "src/main.ts"), "export const main = () => 2;\n", "utf8");
      await onText("Inspected the codebase.");
      return {
        output: "Inspected the codebase.",
        sessionId: "session-worktree-readonly-external-change",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Read Only");

    await chatService.sendMessage(threadId, {
      content: "analyze only",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(worktreeDiffEvent(events)).toBeUndefined();
  });

  it("emits worktree diff for newly created untracked files inside a new directory", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      const relativePath = "src/generated/new.ts";
      const absolutePath = join(worktreePath, relativePath);
      await onToolStarted({
        toolName: "Write",
        toolUseId: "write-untracked-new",
        parentToolUseId: null,
        editTarget: relativePath,
      });
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "export const generated = true;\n", "utf8");
      await onToolFinished({
        toolName: "Write",
        summary: `Created ${relativePath}`,
        precedingToolUseIds: ["write-untracked-new"],
        editTarget: relativePath,
        toolInput: {
          file_path: relativePath,
          content: "export const generated = true;\n",
        },
      });
      await onText("Created src/generated/new.ts");
      return {
        output: "Created src/generated/new.ts",
        sessionId: "session-worktree-untracked-new-file",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree New Untracked File");

    await chatService.sendMessage(threadId, {
      content: "create src/generated/new.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/generated/new.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/generated/new.ts b/src/generated/new.ts");
    expect(diffEvent?.payload.diff).toContain("--- /dev/null");
    expect(diffEvent?.payload.diff).toContain("+++ b/src/generated/new.ts");
    expect(diffEvent?.payload.diff).toContain("+export const generated = true;");
  });

  it("emits worktree diff for OpenCode write payloads that use camelCase filePath", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      const relativePath = "src/opencode-write.ts";
      const absolutePath = join(worktreePath, relativePath);
      await onToolStarted({
        toolName: "Write",
        toolUseId: "write-opencode-camel-path",
        parentToolUseId: null,
      });
      writeFileSync(absolutePath, "export const opencode = true;\n", "utf8");
      await onToolFinished({
        toolName: "Write",
        summary: `Created ${relativePath}`,
        precedingToolUseIds: ["write-opencode-camel-path"],
        toolInput: {
          filePath: absolutePath,
          content: "export const opencode = true;\n",
        },
      });
      await onText("Created src/opencode-write.ts");
      return {
        output: "Created src/opencode-write.ts",
        sessionId: "session-worktree-opencode-camel-path",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree OpenCode Camel Path");

    await chatService.sendMessage(threadId, {
      content: "create src/opencode-write.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/opencode-write.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/opencode-write.ts b/src/opencode-write.ts");
    expect(diffEvent?.payload.diff).toContain("+++ b/src/opencode-write.ts");
    expect(diffEvent?.payload.diff).toContain("+export const opencode = true;");
  });

  it("emits worktree diff when the current run edits an existing untracked file", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });
    const relativePath = "src/generated/new.ts";
    const absolutePath = join(worktreePath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "export const generated = 1;\n", "utf8");

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Edit",
        toolUseId: "edit-existing-untracked",
        parentToolUseId: null,
        editTarget: relativePath,
      });
      writeFileSync(absolutePath, "export const generated = 2;\n", "utf8");
      await onToolFinished({
        toolName: "Edit",
        summary: `Edited ${relativePath}`,
        precedingToolUseIds: ["edit-existing-untracked"],
        editTarget: relativePath,
        toolInput: {
          file_path: relativePath,
          old_string: "export const generated = 1;\n",
          new_string: "export const generated = 2;\n",
        },
      });
      await onText("Updated src/generated/new.ts");
      return {
        output: "Updated src/generated/new.ts",
        sessionId: "session-worktree-edit-existing-untracked",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Existing Untracked File");

    await chatService.sendMessage(threadId, {
      content: "update src/generated/new.ts",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/generated/new.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/generated/new.ts b/src/generated/new.ts");
    expect(diffEvent?.payload.diff).toContain("-export const generated = 1;");
    expect(diffEvent?.payload.diff).toContain("+export const generated = 2;");
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

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Edit",
        toolUseId: "edit-value",
        parentToolUseId: null,
        editTarget: "src/value.ts",
      });
      writeFileSync(join(worktreePath, "src/value.ts"), original, "utf8");
      await onToolFinished({
        toolName: "Edit",
        summary: "Edited src/value.ts",
        precedingToolUseIds: ["edit-value"],
        editTarget: "src/value.ts",
        toolInput: {
          file_path: "src/value.ts",
          old_string: "export const value = 2;\n",
          new_string: original,
        },
      });
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

  it("omits files that became clean when another file remains changed at the end of a bash run", async () => {
    const originalA = "export const a = 1;\n";
    const worktreePath = createGitWorktree({
      "src/a.ts": originalA,
      "src/b.ts": "export const b = 1;\n",
    });
    writeFileSync(join(worktreePath, "src/a.ts"), "export const a = 2;\n", "utf8");

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Bash",
        toolUseId: "bash-omit-cleaned",
        parentToolUseId: null,
        command: "make deploy-firebase",
        shell: "bash",
        isBash: true,
      });
      writeFileSync(join(worktreePath, "src/a.ts"), originalA, "utf8");
      writeFileSync(join(worktreePath, "src/b.ts"), "export const b = 2;\n", "utf8");
      await onToolFinished({
        toolName: "Bash",
        summary: "Ran make deploy-firebase",
        precedingToolUseIds: ["bash-omit-cleaned"],
        command: "make deploy-firebase",
        shell: "bash",
        isBash: true,
      });
      await onText("Updated src/b.ts and cleaned src/a.ts.");
      return {
        output: "Updated src/b.ts and cleaned src/a.ts.",
        sessionId: "session-worktree-bash-clean-filter",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Bash Final State");

    await chatService.sendMessage(threadId, {
      content: "deploy and leave only src/b.ts changed",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/b.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/b.ts b/src/b.ts");
    expect(diffEvent?.payload.diff).not.toContain("diff --git a/src/a.ts b/src/a.ts");
  });

  it("emits bash-owned worktree diffs even without explicit file targets", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Bash",
        toolUseId: "bash-1",
        parentToolUseId: null,
        command: "python - <<'PY'",
        shell: "bash",
        isBash: true,
      });
      writeFileSync(join(worktreePath, "src/main.ts"), "export const main = () => 2;\n", "utf8");
      await onToolFinished({
        toolName: "Bash",
        summary: "Ran python - <<'PY'",
        precedingToolUseIds: ["bash-1"],
        command: "python - <<'PY'",
        shell: "bash",
        isBash: true,
      });
      await onText("Updated src/main.ts through bash.");
      return {
        output: "Updated src/main.ts through bash.",
        sessionId: "session-worktree-bash-fallback",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Bash Fallback");

    await chatService.sendMessage(threadId, {
      content: "update src/main.ts with bash",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    const diffEvent = worktreeDiffEvent(events);
    expect(diffEvent).toBeDefined();
    expect(diffEvent?.payload.changedFiles).toEqual(["src/main.ts"]);
    expect(diffEvent?.payload.diff).toContain("diff --git a/src/main.ts b/src/main.ts");
  });

  it("ignores plan-file targets outside the worktree when deciding whether to emit a diff", async () => {
    const worktreePath = createGitWorktree({
      "src/main.ts": "export const main = () => 1;\n",
    });

    const claudeRunner: ClaudeRunner = vi.fn(async ({ onText, onToolStarted, onToolFinished }) => {
      await onToolStarted({
        toolName: "Write",
        toolUseId: "write-plan-1",
        parentToolUseId: null,
        editTarget: ".claude/plans/fix.md",
      });
      await onToolFinished({
        toolName: "Write",
        summary: "Edited .claude/plans/fix.md",
        precedingToolUseIds: ["write-plan-1"],
        editTarget: ".claude/plans/fix.md",
        toolInput: {
          file_path: ".claude/plans/fix.md",
          content: "# Fix plan",
        },
      });
      writeFileSync(join(worktreePath, "src/main.ts"), "export const main = () => 2;\n", "utf8");
      await onText("Drafted a plan.");
      return {
        output: "Drafted a plan.",
        sessionId: "session-worktree-plan-target",
      };
    });

    const chatService = createChatService({
      prisma,
      eventHub: createEventHub(prisma),
      claudeRunner,
      modelProviderService: stubModelProviderService,
    });
    const threadId = await seedThreadForWorktree(worktreePath, "Worktree Plan Target");

    await chatService.sendMessage(threadId, {
      content: "write a plan",
      mode: "plan",
    });

    const events = await waitForTerminalEvent(chatService, threadId);
    expect(worktreeDiffEvent(events)).toBeUndefined();
  });
});
