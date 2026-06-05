import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRuntimeDebugLog, resetRuntimeDebugLog } from "../src/routes/debug";
import { createIssueReportService, redactDiagnosticValue } from "../src/services/issueReportService";

describe("issueReportService", () => {
  let reportsRoot: string;
  const previousReportsDir = process.env.CODESYMPHONY_ISSUE_REPORTS_DIR;

  beforeEach(async () => {
    reportsRoot = await mkdtemp(path.join(os.tmpdir(), "codesymphony-issue-report-test-"));
    process.env.CODESYMPHONY_ISSUE_REPORTS_DIR = reportsRoot;
    resetRuntimeDebugLog({ clearFile: false });
  });

  afterEach(async () => {
    if (previousReportsDir == null) {
      delete process.env.CODESYMPHONY_ISSUE_REPORTS_DIR;
    } else {
      process.env.CODESYMPHONY_ISSUE_REPORTS_DIR = previousReportsDir;
    }
    resetRuntimeDebugLog({ clearFile: false });
    await rm(reportsRoot, { recursive: true, force: true });
  });

  function createPrismaMock() {
    return {
      repository: {
        findUnique: vi.fn(async () => ({
          id: "repo-1",
          name: "App",
          rootPath: "/Users/alice/work/app",
          defaultBranch: "main",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        })),
      },
      worktree: {
        findUnique: vi.fn(async () => ({
          id: "worktree-1",
          repositoryId: "repo-1",
          branch: "fix",
          path: "/Users/alice/work/app",
          baseBranch: "main",
          status: "active",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        })),
      },
      chatThread: {
        findUnique: vi.fn(async () => ({
          id: "thread-1",
          worktreeId: "worktree-1",
          title: "Broken stream",
          kind: "default",
          permissionProfile: "default",
          permissionMode: "default",
          mode: "default",
          agent: "claude",
          model: "claude-sonnet-4-6",
          modelProviderId: null,
          claudeSessionId: "session-secret-like",
          codexSessionId: null,
          cursorSessionId: null,
          opencodeSessionId: null,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        })),
      },
    } as unknown as PrismaClient;
  }

  it("creates a local report folder with markdown, diagnostics, and redacted debug log", async () => {
    appendRuntimeDebugLog({
      source: "thread.stream.lifecycle",
      message: "stream.open",
      data: {
        threadId: "thread-1",
        worktreeId: "worktree-1",
        authorization: "Bearer sk-testsecret1234567890",
      },
    });
    appendRuntimeDebugLog({
      source: "terminal.input",
      message: "onData",
      data: {
        threadId: "thread-1",
        command: "cat .env",
      },
    });

    const service = createIssueReportService({ prisma: createPrismaMock() });
    const report = await service.createIssueReport({
      description: "Stream froze while sending a message with sk-testsecret1234567890",
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
      threadId: "thread-1",
    });

    expect(report.directoryPath.startsWith(reportsRoot)).toBe(true);

    const issue = await readFile(report.issuePath, "utf-8");
    const diagnostics = await readFile(report.diagnosticsPath, "utf-8");
    const debugLog = await readFile(report.debugLogPath, "utf-8");

    expect(issue).toContain("Stream froze while sending a message");
    expect(issue).not.toContain("sk-testsecret1234567890");
    expect(diagnostics).toContain("\"threadId\": \"thread-1\"");
    expect(diagnostics).not.toContain("Bearer sk-testsecret1234567890");
    expect(debugLog).toContain("thread.stream.lifecycle");
    expect(debugLog).not.toContain("terminal.input");
    expect(debugLog).not.toContain("cat .env");
    expect(debugLog).not.toContain("sk-testsecret1234567890");
  });

  it("filters debug entries to the requested workspace context", async () => {
    appendRuntimeDebugLog({
      source: "thread.stream.lifecycle",
      message: "stream.open",
      data: { threadId: "thread-1", worktreeId: "worktree-1" },
    });
    appendRuntimeDebugLog({
      source: "thread.stream.lifecycle",
      message: "stream.open",
      data: { threadId: "thread-2", worktreeId: "worktree-2" },
    });

    const service = createIssueReportService({ prisma: createPrismaMock() });
    const report = await service.createIssueReport({
      description: "Only current thread",
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
      threadId: "thread-1",
    });

    const debugLog = await readFile(report.debugLogPath, "utf-8");
    expect(debugLog).toContain("thread-1");
    expect(debugLog).not.toContain("thread-2");
  });

  it("keeps priority diagnosis entries even when noisy tail entries fill the report", async () => {
    appendRuntimeDebugLog({
      source: "diagnose.selection",
      message: "[DEBUG-worktree-glitch] transient-null-url-update.suppressed",
      data: { repositoryId: "repo-1", worktreeId: "worktree-1" },
    });

    for (let i = 0; i < 1_050; i += 1) {
      appendRuntimeDebugLog({
        source: "thread.workspace.event",
        message: "worktree.git.updated",
        data: { repositoryId: "repo-1", worktreeId: "worktree-1", seq: i },
      });
    }

    const service = createIssueReportService({ prisma: createPrismaMock() });
    const report = await service.createIssueReport({
      description: "Selection oscillated",
      repositoryId: "repo-1",
      worktreeId: "worktree-1",
    });

    const debugLog = await readFile(report.debugLogPath, "utf-8");
    expect(debugLog).toContain("transient-null-url-update.suppressed");
  });

  it("redacts nested secrets and env-like values", () => {
    expect(redactDiagnosticValue({
      nested: {
        apiKey: "sk-verysecret1234567890",
        ANTHROPIC_API_KEY: "sk-anthropic1234567890",
        headers: {
          authorization: "Bearer sk-token1234567890",
        },
      },
    })).toEqual({
      nested: {
        apiKey: "[REDACTED]",
        ANTHROPIC_API_KEY: "[REDACTED]",
        headers: {
          authorization: "[REDACTED]",
        },
      },
    });
  });

  it("creates a report when no workspace identifiers are provided", async () => {
    const service = createIssueReportService({ prisma: createPrismaMock() });
    const report = await service.createIssueReport({
      description: "Startup looked wrong",
    });

    await expect(readFile(report.issuePath, "utf-8")).resolves.toContain("Startup looked wrong");
  });

  it("prepares the issue reports directory before any report exists", async () => {
    const reportsDir = path.join(reportsRoot, "nested-reports");
    process.env.CODESYMPHONY_ISSUE_REPORTS_DIR = reportsDir;
    const service = createIssueReportService({ prisma: createPrismaMock() });

    await expect(stat(reportsDir)).rejects.toThrow();

    await expect(service.ensureReportsDirectory()).resolves.toBe(reportsDir);
    await expect(stat(reportsDir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });
});
