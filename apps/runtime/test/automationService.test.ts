import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventHub } from "../src/events/eventHub";
import { createWorkspaceEventHub } from "../src/events/workspaceEventHub";
import { createAutomationService } from "../src/services/automationService";

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

async function resetDatabase(): Promise<void> {
  await prisma.chatEvent.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.chatThread.deleteMany();
  await prisma.automationRun.deleteMany();
  await prisma.automationPromptVersion.deleteMany();
  await prisma.automation.deleteMany();
  await prisma.worktree.deleteMany();
  await prisma.repository.deleteMany();
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function waitForRunStatus(
  automationService: ReturnType<typeof createAutomationService>,
  automationId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await automationService.listRuns(automationId);
    if (runs[0]?.status === expectedStatus) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }

  const runs = await automationService.listRuns(automationId);
  expect(runs[0]?.status).toBe(expectedStatus);
}

async function createRepositoryFixture() {
  const suffix = uniqueSuffix();
  const repository = await prisma.repository.create({
    data: {
      name: `repo-${suffix}`,
      rootPath: `/tmp/repo-${suffix}`,
      defaultBranch: "main",
    },
  });
  const worktree = await prisma.worktree.create({
    data: {
      repositoryId: repository.id,
      branch: "main",
      path: `/tmp/repo-${suffix}`,
      baseBranch: "main",
      status: "active",
    },
  });

  return { repository, worktree };
}

function createAutomationHarness() {
  const eventHub = createEventHub(prisma);
  const workspaceEventHub = createWorkspaceEventHub();
  const automationService = createAutomationService({
    prisma,
    eventHub,
    workspaceEventHub,
    chatService: {
      async createThread(targetWorktreeId, input) {
        const thread = await prisma.chatThread.create({
          data: {
            worktreeId: targetWorktreeId,
            title: input?.title ?? "New Thread",
            agent: input?.agent ?? "claude",
            model: input?.model ?? "claude-sonnet-4-6",
            modelProviderId: input?.modelProviderId ?? null,
            permissionMode: input?.permissionMode ?? "default",
            mode: input?.mode ?? "default",
          },
        });

        return {
          id: thread.id,
          worktreeId: thread.worktreeId,
          title: thread.title,
          kind: thread.kind,
          permissionProfile: thread.permissionProfile,
          permissionMode: thread.permissionMode,
          mode: thread.mode,
          titleEditedManually: thread.titleEditedManually,
          agent: thread.agent,
          model: thread.model,
          modelProviderId: thread.modelProviderId,
          claudeSessionId: thread.claudeSessionId,
          codexSessionId: thread.codexSessionId,
          cursorSessionId: thread.cursorSessionId,
          opencodeSessionId: thread.opencodeSessionId,
          handoffSourceThreadId: thread.handoffSourceThreadId,
          handoffSourcePlanEventId: thread.handoffSourcePlanEventId,
          active: false,
          createdAt: thread.createdAt.toISOString(),
          updatedAt: thread.updatedAt.toISOString(),
        };
      },
      async sendMessage(threadId, input) {
        const message = await prisma.chatMessage.create({
          data: {
            threadId,
            seq: 0,
            role: "user",
            content: typeof input === "object" && input !== null && "content" in input
              ? String(input.content)
              : "",
          },
        });

        return {
          id: message.id,
          threadId: message.threadId,
          seq: message.seq,
          role: message.role,
          content: message.content,
          attachments: [],
          createdAt: message.createdAt.toISOString(),
        };
      },
    },
  });

  return { eventHub, workspaceEventHub, automationService };
}

describe("automationService", () => {
  const cleanupCallbacks: Array<() => void> = [];

  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    while (cleanupCallbacks.length > 0) {
      const callback = cleanupCallbacks.pop();
      callback?.();
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs an automation now by creating a new thread in the target worktree", async () => {
    const { repository, worktree } = await createRepositoryFixture();
    const { automationService } = createAutomationHarness();
    cleanupCallbacks.push(() => automationService.dispose());

    const created = await automationService.createAutomation({
      repositoryId: repository.id,
      targetWorktreeId: worktree.id,
      name: "Daily audit",
      prompt: "Check the repo and summarize issues.",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "default",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "UTC",
    });

    const dispatched = await automationService.runAutomationNow(created.id);
    const thread = await prisma.chatThread.findUnique({
      where: { id: dispatched.threadId },
    });
    const runs = await automationService.listRuns(created.id);

    expect(thread).toBeTruthy();
    expect(thread?.worktreeId).toBe(worktree.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.threadId).toBe(dispatched.threadId);
    expect(runs[0]?.triggerKind).toBe("manual");
  });

  it("updates the prompt and keeps a version history", async () => {
    const { repository, worktree } = await createRepositoryFixture();
    const { automationService } = createAutomationHarness();
    cleanupCallbacks.push(() => automationService.dispose());

    const created = await automationService.createAutomation({
      repositoryId: repository.id,
      targetWorktreeId: worktree.id,
      name: "Daily audit",
      prompt: "Check the repo and summarize issues.",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "default",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "UTC",
    });

    const updated = await automationService.updateAutomation(created.id, {
      prompt: "Check the repo, summarize issues, and propose fixes.",
    });
    const versions = await automationService.listPromptVersions(created.id);

    expect(updated.prompt).toBe("Check the repo, summarize issues, and propose fixes.");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.content).toBe("Check the repo, summarize issues, and propose fixes.");
    expect(versions[0]?.source).toBe("update");
    expect(versions[1]?.content).toBe("Check the repo and summarize issues.");
    expect(versions[1]?.source).toBe("create");
  });

  it("pauses and resumes an automation by toggling its enabled state", async () => {
    const { repository, worktree } = await createRepositoryFixture();
    const { automationService } = createAutomationHarness();
    cleanupCallbacks.push(() => automationService.dispose());

    const created = await automationService.createAutomation({
      repositoryId: repository.id,
      targetWorktreeId: worktree.id,
      name: "Daily audit",
      prompt: "Check the repo and summarize issues.",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "default",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "UTC",
    });

    const paused = await automationService.setAutomationEnabled(created.id, false);
    const resumed = await automationService.setAutomationEnabled(created.id, true);

    expect(paused.enabled).toBe(false);
    expect(resumed.enabled).toBe(true);
    expect(new Date(resumed.nextRunAt).getTime()).toBeGreaterThanOrEqual(Date.now() - 1_000);
  });

  it("dispatches a due automation from the scheduler and advances the next run", async () => {
    const { repository, worktree } = await createRepositoryFixture();
    const { automationService } = createAutomationHarness();
    cleanupCallbacks.push(() => automationService.dispose());

    const created = await automationService.createAutomation({
      repositoryId: repository.id,
      targetWorktreeId: worktree.id,
      name: "Hourly audit",
      prompt: "Run the hourly audit.",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "default",
      rrule: "FREQ=HOURLY;BYMINUTE=0",
      timezone: "UTC",
    });

    const forcedDueAt = new Date(Date.now() - 60_000);
    await prisma.automation.update({
      where: { id: created.id },
      data: {
        nextRunAt: forcedDueAt,
      },
    });

    const dispatchedCount = await automationService.dispatchDueAutomations();
    const refreshed = await automationService.getAutomation(created.id);
    const runs = await automationService.listRuns(created.id);

    expect(dispatchedCount).toBe(1);
    expect(new Date(refreshed?.nextRunAt ?? 0).getTime()).toBeGreaterThan(forcedDueAt.getTime());
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerKind).toBe("schedule");
    expect(runs[0]?.threadId).toBeTruthy();
  });

  it("maps linked thread events into run lifecycle state", async () => {
    const { repository, worktree } = await createRepositoryFixture();
    const { automationService, eventHub } = createAutomationHarness();
    cleanupCallbacks.push(() => automationService.dispose());

    const created = await automationService.createAutomation({
      repositoryId: repository.id,
      targetWorktreeId: worktree.id,
      name: "Daily audit",
      prompt: "Check the repo and summarize issues.",
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      permissionMode: "default",
      chatMode: "plan",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: "UTC",
    });

    const dispatched = await automationService.runAutomationNow(created.id);

    await eventHub.emit(dispatched.threadId!, "permission.requested", {
      requestId: "req-1",
      toolName: "exec",
    });
    await waitForRunStatus(automationService, created.id, "waiting_input");
    let runs = await automationService.listRuns(created.id);
    expect(runs[0]?.status).toBe("waiting_input");

    await eventHub.emit(dispatched.threadId!, "permission.resolved", {
      requestId: "req-1",
      decision: "approved",
    });
    await waitForRunStatus(automationService, created.id, "running");
    runs = await automationService.listRuns(created.id);
    expect(runs[0]?.status).toBe("running");

    await eventHub.emit(dispatched.threadId!, "chat.completed", {
      messageId: "message-1",
      threadMode: "plan",
    });
    await waitForRunStatus(automationService, created.id, "succeeded");
    runs = await automationService.listRuns(created.id);
    expect(runs[0]?.status).toBe("succeeded");
    expect(runs[0]?.finishedAt).toBeTruthy();
  });
});
