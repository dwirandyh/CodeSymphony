import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { CreateIssueReportInput, IssueReportResult } from "@codesymphony/shared-types";
import { getRuntimeDebugEntries, resolveDatabaseInfo } from "../routes/debug.js";

type DebugLogEntry = {
  seq: number;
  ts: number;
  source: string;
  message: string;
  data: unknown;
};

type CreateIssueReportServiceOptions = {
  prisma: PrismaClient;
};

const SECRET_KEY_PATTERN =
  /(api[-_]?key|authorization|auth|bearer|credential|password|passwd|secret|token|providerApiKey|anthropic|openai|baseUrl)/i;
const ENV_KEY_PATTERN = /^[A-Z0-9_]{3,}$/;
const SECRET_VALUE_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_/-]{32,}\.[A-Za-z0-9_/-]{16,}\.[A-Za-z0-9_/-]{16,}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*)\b/g;
const HOME_PATH_PATTERN = new RegExp(escapeRegExp(os.homedir()), "g");
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 400;
const MAX_OBJECT_KEYS = 80;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveIssueReportsDirectory(): string {
  const configuredPath = process.env.CODESYMPHONY_ISSUE_REPORTS_DIR?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  const debugLogPath = process.env.CODESYMPHONY_DEBUG_LOG_PATH?.trim();
  if (debugLogPath) {
    return path.join(path.dirname(path.resolve(debugLogPath)), "issue-reports");
  }

  return path.join(os.tmpdir(), "codesymphony", "issue-reports");
}

function normalizeNullableId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeReportId(createdAt: Date): string {
  const timestamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function redactString(value: string): string {
  const homeRedacted = value.replace(HOME_PATH_PATTERN, "~");
  const secretRedacted = homeRedacted.replace(SECRET_VALUE_PATTERN, "[REDACTED_SECRET]");

  if (secretRedacted.length <= MAX_STRING_LENGTH) {
    return secretRedacted;
  }

  return `${secretRedacted.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED ${secretRedacted.length - MAX_STRING_LENGTH} chars]`;
}

export function redactDiagnosticValue(value: unknown, keyHint = "", depth = 0): unknown {
  if (value == null) {
    return value;
  }

  if (SECRET_KEY_PATTERN.test(keyHint) || (ENV_KEY_PATTERN.test(keyHint) && typeof value === "string")) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= 6) {
    return "[MAX_DEPTH]";
  }

  if (Array.isArray(value)) {
    const visible = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => redactDiagnosticValue(entry, keyHint, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      visible.push(`[TRUNCATED ${value.length - MAX_ARRAY_LENGTH} items]`);
    }
    return visible;
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const entries = Object.entries(source).slice(0, MAX_OBJECT_KEYS);
    const redacted: Record<string, unknown> = {};

    for (const [key, entryValue] of entries) {
      redacted[key] = redactDiagnosticValue(entryValue, key, depth + 1);
    }

    const remainingKeys = Object.keys(source).length - entries.length;
    if (remainingKeys > 0) {
      redacted.__truncatedKeys = remainingKeys;
    }

    return redacted;
  }

  return String(value);
}

function isTerminalRawPayload(entry: DebugLogEntry): boolean {
  if (!entry.source.startsWith("terminal.")) {
    return false;
  }

  return entry.source === "terminal.input" || /(?:onData|beforeinput|input|output|chunk)/i.test(entry.message);
}

function matchesContext(entry: DebugLogEntry, input: {
  repositoryId: string | null;
  worktreeId: string | null;
  threadId: string | null;
}): boolean {
  const data = entry.data;
  if (data == null || typeof data !== "object") {
    return true;
  }

  const record = data as Record<string, unknown>;
  if (input.threadId && record.threadId === input.threadId) {
    return true;
  }
  if (input.worktreeId && record.worktreeId === input.worktreeId) {
    return true;
  }
  if (input.repositoryId && record.repositoryId === input.repositoryId) {
    return true;
  }

  const hasScopedField = "threadId" in record || "worktreeId" in record || "repositoryId" in record;
  return !hasScopedField;
}

function redactDebugEntries(entries: DebugLogEntry[], input: {
  repositoryId: string | null;
  worktreeId: string | null;
  threadId: string | null;
}): DebugLogEntry[] {
  return entries
    .filter((entry) => !isTerminalRawPayload(entry))
    .filter((entry) => matchesContext(entry, input))
    .slice(-1_000)
    .map((entry) => ({
      ...entry,
      source: redactString(entry.source),
      message: redactString(entry.message),
      data: redactDiagnosticValue(entry.data),
    }));
}

function toNdjson(entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function reportMarkdown(input: {
  description: string;
  createdAt: string;
  repository: unknown;
  worktree: unknown;
  thread: unknown;
  diagnosticsPath: string;
  debugLogPath: string;
  debugEntryCount: number;
}): string {
  return [
    "# CodeSymphony Issue Report",
    "",
    "## Description",
    "",
    input.description,
    "",
    "## Context",
    "",
    `- Created: ${input.createdAt}`,
    `- Repository: ${JSON.stringify(input.repository)}`,
    `- Worktree: ${JSON.stringify(input.worktree)}`,
    `- Thread: ${JSON.stringify(input.thread)}`,
    "",
    "## Diagnostic Capture",
    "",
    `- Diagnostics: ${input.diagnosticsPath}`,
    `- Debug log: ${input.debugLogPath}`,
    `- Debug entries: ${input.debugEntryCount}`,
    "",
    "Raw terminal output, source snippets, environment values, API keys, tokens, and provider credentials are excluded or redacted.",
    "",
  ].join("\n");
}

export function createIssueReportService({ prisma }: CreateIssueReportServiceOptions) {
  async function ensureReportsDirectory(): Promise<string> {
    const reportsDir = resolveIssueReportsDirectory();
    await mkdir(reportsDir, { recursive: true });
    return reportsDir;
  }

  async function createIssueReport(input: CreateIssueReportInput): Promise<IssueReportResult> {
    const createdAt = new Date();
    const createdAtIso = createdAt.toISOString();
    const reportId = safeReportId(createdAt);
    const reportsDir = resolveIssueReportsDirectory();
    const reportDir = path.join(reportsDir, reportId);
    const repositoryId = normalizeNullableId(input.repositoryId);
    const worktreeId = normalizeNullableId(input.worktreeId);
    const threadId = normalizeNullableId(input.threadId);

    const [repository, worktree, thread] = await Promise.all([
      repositoryId
        ? prisma.repository.findUnique({
          where: { id: repositoryId },
          select: { id: true, name: true, rootPath: true, defaultBranch: true, updatedAt: true },
        })
        : Promise.resolve(null),
      worktreeId
        ? prisma.worktree.findUnique({
          where: { id: worktreeId },
          select: { id: true, repositoryId: true, branch: true, path: true, baseBranch: true, status: true, updatedAt: true },
        })
        : Promise.resolve(null),
      threadId
        ? prisma.chatThread.findUnique({
          where: { id: threadId },
          select: {
            id: true,
            worktreeId: true,
            title: true,
            kind: true,
            permissionProfile: true,
            permissionMode: true,
            mode: true,
            agent: true,
            model: true,
            modelProviderId: true,
            claudeSessionId: true,
            codexSessionId: true,
            cursorSessionId: true,
            opencodeSessionId: true,
            updatedAt: true,
          },
        })
        : Promise.resolve(null),
    ]);

    const debugEntries = redactDebugEntries(getRuntimeDebugEntries(), { repositoryId, worktreeId, threadId });
    const diagnostics = redactDiagnosticValue({
      id: reportId,
      createdAt: createdAtIso,
      runtime: {
        pid: process.pid,
        cwd: process.cwd(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSec: Number(process.uptime().toFixed(1)),
        database: resolveDatabaseInfo(process.env.DATABASE_URL),
      },
      app: {
        nodeEnv: process.env.NODE_ENV ?? null,
        runtimeHost: process.env.RUNTIME_HOST ?? null,
        runtimePort: process.env.RUNTIME_PORT ?? null,
        webDistPath: process.env.WEB_DIST_PATH ?? null,
      },
      scope: { repositoryId, worktreeId, threadId },
      repository,
      worktree,
      thread,
      debug: {
        capturedEntries: debugEntries.length,
        totalBufferedEntries: getRuntimeDebugEntries().length,
        sources: Array.from(new Set(debugEntries.map((entry) => entry.source))).sort(),
      },
    });

    const issuePath = path.join(reportDir, "issue.md");
    const diagnosticsPath = path.join(reportDir, "diagnostics.json");
    const debugLogPath = path.join(reportDir, "debug-log.ndjson");

    await mkdir(reportDir, { recursive: true });
    await Promise.all([
      writeFile(
        issuePath,
        reportMarkdown({
          description: redactString(input.description),
          createdAt: createdAtIso,
          repository: redactDiagnosticValue(repository),
          worktree: redactDiagnosticValue(worktree),
          thread: redactDiagnosticValue(thread),
          diagnosticsPath,
          debugLogPath,
          debugEntryCount: debugEntries.length,
        }),
        "utf-8",
      ),
      writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf-8"),
      writeFile(debugLogPath, toNdjson(debugEntries), "utf-8"),
    ]);

    return {
      id: reportId,
      directoryPath: reportDir,
      issuePath,
      diagnosticsPath,
      debugLogPath,
      createdAt: createdAtIso,
    };
  }

  return {
    createIssueReport,
    ensureReportsDirectory,
    getReportsDirectory: resolveIssueReportsDirectory,
    getReportsDirectoryFingerprint: () => createHash("sha1").update(resolveIssueReportsDirectory()).digest("hex").slice(0, 12),
  };
}
