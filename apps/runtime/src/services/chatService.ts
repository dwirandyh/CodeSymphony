import type { PrismaClient } from "@prisma/client";
import { execFile as execFileRaw } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AnswerQuestionInputSchema,
  CreateChatThreadInputSchema,
  PlanRevisionInputSchema,
  ResolvePermissionInputSchema,
  SendChatMessageInputSchema,
  type AnswerQuestionInput,
  type ChatEvent,
  type ChatMessage,
  type ChatMode,
  type ChatThread,
  type CreateChatThreadInput,
  type PlanRevisionInput,
  type ResolvePermissionInput,
  type SendChatMessageInput,
} from "@codesymphony/shared-types";
import type { ClaudeToolInstrumentationEvent, PlanDetectionSource, RuntimeDeps } from "../types";
import { mapChatMessage, mapChatThread } from "./mappers";
import { isDefaultBranchName } from "./worktreeService";
import { renameBranch as renameBranchGit } from "./git";

const AUTO_EXECUTE_DELAY_MS = 10;
const MAX_DIFF_PREVIEW_CHARS = 20000;
const MAX_THREAD_TITLE_LENGTH = 48;
const TITLE_GENERATION_TIMEOUT_MS = 6000;
const MAX_BRANCH_NAME_LENGTH = 60;
const BRANCH_GENERATION_TIMEOUT_MS = 6000;
const CLAUDE_SETTINGS_DIR = ".claude";
const CLAUDE_LOCAL_SETTINGS_FILE = "settings.local.json";
const execFile = promisify(execFileRaw);

function inferPlanDetectionSource(filePath: string, source?: PlanDetectionSource): PlanDetectionSource {
  if (source === "claude_plan_file" || source === "streaming_fallback") {
    return source;
  }

  return filePath.includes(".claude/plans/") && filePath.endsWith(".md") ? "claude_plan_file" : "streaming_fallback";
}

type WorktreeStateSnapshot = {
  statusOutput: string;
  unstagedDiff: string;
  stagedDiff: string;
  changedFiles: string[];
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function persistAlwaysAllowRule(worktreePath: string, rule: string): { settingsPath: string; persisted: boolean } {
  const claudeDirPath = join(worktreePath, CLAUDE_SETTINGS_DIR);
  const settingsPath = join(claudeDirPath, CLAUDE_LOCAL_SETTINGS_FILE);

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        throw new Error("settings.local.json must contain a JSON object.");
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${settingsPath}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  const existingPermissions =
    typeof settings.permissions === "object" && settings.permissions != null && !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {};

  const allow = toStringArray(existingPermissions.allow);
  const persisted = !allow.includes(rule);
  if (persisted) {
    allow.push(rule);
  }

  const nextSettings: Record<string, unknown> = {
    ...settings,
    permissions: {
      ...existingPermissions,
      allow,
      deny: toStringArray(existingPermissions.deny),
      ask: toStringArray(existingPermissions.ask),
    },
  };

  mkdirSync(claudeDirPath, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  return { settingsPath, persisted };
}

async function nextMessageSeq(prisma: PrismaClient, threadId: string): Promise<number> {
  const result = await prisma.chatMessage.aggregate({
    where: { threadId },
    _max: { seq: true },
  });

  return (result._max.seq ?? -1) + 1;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
  });

  return stdout.trim();
}

function parseChangedFiles(statusOutput: string): string[] {
  if (statusOutput.length === 0) {
    return [];
  }

  const files = new Set<string>();
  for (const line of statusOutput.split("\n")) {
    const normalized = line.trimEnd();
    if (normalized.length === 0) {
      continue;
    }

    let path = "";
    if (normalized.startsWith("?? ") || normalized.startsWith("!! ")) {
      path = normalized.slice(3).trim();
    } else {
      const porcelainMatch = /^[ MADRCU?!][ MADRCU?!]\s+(.+)$/.exec(normalized);
      if (porcelainMatch?.[1]) {
        path = porcelainMatch[1].trim();
      } else {
        const fallbackParts = normalized.split(/\s+/, 2);
        if (fallbackParts.length === 2) {
          path = fallbackParts[1].trim();
        }
      }
    }

    if (path.length > 0) {
      files.add(path);
    }
  }

  return Array.from(files);
}

type ParsedDiffSections = {
  byFile: Map<string, string>;
  order: string[];
};

function parseDiffSections(diffOutput: string): ParsedDiffSections {
  const byFile = new Map<string, string>();
  const order: string[] = [];

  if (diffOutput.trim().length === 0) {
    return { byFile, order };
  }

  const lines = diffOutput.split(/\r?\n/);
  let currentFile: string | null = null;
  let currentLines: string[] = [];

  function flushCurrentSection(): void {
    if (!currentFile || currentLines.length === 0) {
      currentFile = null;
      currentLines = [];
      return;
    }

    const section = currentLines.join("\n").trimEnd();
    const existing = byFile.get(currentFile);
    if (!existing) {
      byFile.set(currentFile, section);
      order.push(currentFile);
    } else {
      byFile.set(currentFile, `${existing}\n\n${section}`);
    }

    currentFile = null;
    currentLines = [];
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushCurrentSection();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      currentFile = match?.[2] ?? null;
      currentLines = [line];
      continue;
    }

    if (!currentFile) {
      continue;
    }
    currentLines.push(line);
  }

  flushCurrentSection();
  return { byFile, order };
}

function appendUnique(items: string[], seen: Set<string>, candidate: string): void {
  if (seen.has(candidate)) {
    return;
  }
  seen.add(candidate);
  items.push(candidate);
}

function symmetricStatusDelta(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const delta: string[] = [];
  const seen = new Set<string>();

  for (const file of after) {
    if (!beforeSet.has(file)) {
      appendUnique(delta, seen, file);
    }
  }
  for (const file of before) {
    if (!afterSet.has(file)) {
      appendUnique(delta, seen, file);
    }
  }

  return delta;
}

async function captureWorktreeState(worktreePath: string): Promise<WorktreeStateSnapshot | null> {
  try {
    const [statusOutput, unstagedDiff, stagedDiff] = await Promise.all([
      runGit(worktreePath, ["status", "--porcelain"]),
      runGit(worktreePath, ["diff", "--no-color"]),
      runGit(worktreePath, ["diff", "--cached", "--no-color"]),
    ]);

    return {
      statusOutput,
      unstagedDiff,
      stagedDiff,
      changedFiles: parseChangedFiles(statusOutput),
    };
  } catch {
    return null;
  }
}

function buildDiffDelta(before: WorktreeStateSnapshot, after: WorktreeStateSnapshot): {
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
} | null {
  const beforeCombinedDiff = [before.unstagedDiff, before.stagedDiff].filter((part) => part.length > 0).join("\n\n");
  const afterCombinedDiff = [after.unstagedDiff, after.stagedDiff].filter((part) => part.length > 0).join("\n\n");

  if (before.statusOutput === after.statusOutput && beforeCombinedDiff === afterCombinedDiff) {
    return null;
  }

  const beforeSections = parseDiffSections(beforeCombinedDiff);
  const afterSections = parseDiffSections(afterCombinedDiff);

  const diffDeltaFiles = new Set<string>();
  const orderedDiffDeltaFiles: string[] = [];
  const allSectionFiles = new Set([
    ...beforeSections.byFile.keys(),
    ...afterSections.byFile.keys(),
  ]);

  for (const file of afterSections.order) {
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }
  for (const file of beforeSections.order) {
    if (diffDeltaFiles.has(file)) {
      continue;
    }
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }
  for (const file of allSectionFiles) {
    if (diffDeltaFiles.has(file)) {
      continue;
    }
    const beforeSection = beforeSections.byFile.get(file) ?? "";
    const afterSection = afterSections.byFile.get(file) ?? "";
    if (beforeSection !== afterSection) {
      diffDeltaFiles.add(file);
      orderedDiffDeltaFiles.push(file);
    }
  }

  const deltaSections = orderedDiffDeltaFiles
    .map((file) => afterSections.byFile.get(file) ?? "")
    .filter((section) => section.length > 0);
  const diffDelta = deltaSections.join("\n\n");

  const changedFiles: string[] = [];
  const changedFilesSeen = new Set<string>();
  for (const file of orderedDiffDeltaFiles) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  for (const file of symmetricStatusDelta(before.changedFiles, after.changedFiles)) {
    appendUnique(changedFiles, changedFilesSeen, file);
  }

  if (changedFiles.length === 0 && diffDelta.length === 0) {
    return null;
  }

  const diffTruncated = diffDelta.length > MAX_DIFF_PREVIEW_CHARS;
  const diff = diffTruncated
    ? `${diffDelta.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n\n... [diff truncated]`
    : diffDelta;

  return {
    changedFiles,
    diff,
    diffTruncated,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel|interrupt/i.test(error.message));
}

function instrumentationMessage(event: ClaudeToolInstrumentationEvent): string {
  if (event.stage === "anomaly") {
    return event.anomaly?.message ?? `Tool anomaly (${event.toolName})`;
  }

  if (event.stage === "decision") {
    return `${event.toolName} decision: ${event.decision ?? "unknown"}`;
  }

  if (event.stage === "requested") {
    return `${event.toolName} requested`;
  }

  if (event.stage === "started") {
    return `${event.toolName} started`;
  }

  if (event.stage === "failed") {
    return `${event.toolName} failed`;
  }

  return event.summary?.trim().length ? event.summary : `${event.toolName} finished`;
}

export function createChatService(deps: RuntimeDeps) {
  const activeThreads = new Set<string>();
  const scheduledAssistantRunsByThread = new Map<string, ReturnType<typeof setTimeout>>();
  const runningAbortControllersByThread = new Map<string, AbortController>();

  function clearScheduledAssistantRun(threadId: string): boolean {
    const timer = scheduledAssistantRunsByThread.get(threadId);
    if (!timer) {
      return false;
    }

    clearTimeout(timer);
    scheduledAssistantRunsByThread.delete(threadId);
    return true;
  }

  function isDefaultThreadTitle(title: string): boolean {
    const normalized = title.trim();
    return normalized === "Main Thread" || /^Thread\s+\d+$/.test(normalized);
  }

  function clampThreadTitle(input: string, maxLength = MAX_THREAD_TITLE_LENGTH): string {
    if (input.length <= maxLength) {
      return input;
    }

    const sliced = input.slice(0, maxLength).trimEnd();
    const minBoundary = Math.floor(maxLength * 0.6);
    const lastSpace = sliced.lastIndexOf(" ");
    if (lastSpace >= minBoundary) {
      return sliced.slice(0, lastSpace).trim();
    }

    return sliced;
  }

  function normalizeGeneratedThreadTitle(raw: string): string | null {
    const firstLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return null;
    }

    let candidate = firstLine
      .replace(/^[-*]\s*/, "")
      .replace(/^title\s*[:\-]\s*/i, "")
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    candidate = candidate.replace(/[.!?,;:]+$/g, "").trim();
    if (candidate.length === 0) {
      return null;
    }

    const clamped = clampThreadTitle(candidate);
    return clamped.length >= 3 ? clamped : null;
  }

  async function buildThreadTitleWithAi(
    worktreePath: string,
    firstUserContent: string,
    firstAssistantContent: string,
  ): Promise<string | null> {
    const prompt = [
      "You generate concise chat thread titles.",
      "Return exactly one title line only.",
      "Rules:",
      "- Capture the user's core intent.",
      "- Keep it concise (2-6 words, max 48 chars).",
      "- No quotes.",
      "- No trailing punctuation.",
      "",
      `User message: ${firstUserContent.trim()}`,
      `Assistant reply: ${firstAssistantContent.trim()}`,
    ].join("\n");

    let streamedOutput = "";
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, TITLE_GENERATION_TIMEOUT_MS);

    try {
      const result = await deps.claudeRunner({
        prompt,
        sessionId: null,
        cwd: worktreePath,
        abortController,
        permissionMode: "plan",
        onText: (chunk) => {
          streamedOutput += chunk;
        },
        onToolStarted: async () => { },
        onToolOutput: async () => { },
        onToolFinished: async () => { },
        onQuestionRequest: async () => ({ answers: {} }),
        onPermissionRequest: () => ({ decision: "deny", message: "Tool use is disabled for title generation." }),
        onPlanFileDetected: async () => { },
        onSubagentStarted: async () => { },
        onSubagentStopped: async () => { },
        onThinking: async () => { },
      });

      const raw = streamedOutput.trim().length > 0 ? streamedOutput : result.output;
      return normalizeGeneratedThreadTitle(raw);
    } catch (error) {
      deps.logService?.log(
        "warn",
        "chat.thread.title",
        "AI title generation failed; keeping current title.",
        {
          worktreePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function maybeAutoRenameThreadAfterFirstAssistantReply(threadId: string): Promise<string | null> {
    try {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        select: {
          title: true,
          worktree: {
            select: {
              path: true,
            },
          },
        },
      });
      if (!thread) {
        return null;
      }

      if (!isDefaultThreadTitle(thread.title)) {
        return thread.title;
      }

      const assistantMessageCount = await deps.prisma.chatMessage.count({
        where: {
          threadId,
          role: "assistant",
        },
      });
      if (assistantMessageCount !== 1) {
        return thread.title;
      }

      const firstUserMessage = await deps.prisma.chatMessage.findFirst({
        where: {
          threadId,
          role: "user",
        },
        orderBy: {
          seq: "asc",
        },
        select: {
          content: true,
        },
      });
      if (!firstUserMessage) {
        return thread.title;
      }

      const firstAssistantMessage = await deps.prisma.chatMessage.findFirst({
        where: {
          threadId,
          role: "assistant",
        },
        orderBy: {
          seq: "asc",
        },
        select: {
          content: true,
        },
      });
      if (!firstAssistantMessage) {
        return thread.title;
      }

      const nextTitle = await buildThreadTitleWithAi(
        thread.worktree.path,
        firstUserMessage.content,
        firstAssistantMessage.content,
      );
      if (!nextTitle || nextTitle === thread.title) {
        return thread.title;
      }

      const updated = await deps.prisma.chatThread.update({
        where: { id: threadId },
        data: { title: nextTitle },
        select: { title: true },
      });
      return updated.title;
    } catch (error) {
      deps.logService?.log(
        "warn",
        "chat.thread.title",
        "Auto rename failed; keeping current title.",
        {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  function normalizeGeneratedBranchName(raw: string): string | null {
    const firstLine = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) return null;

    let candidate = firstLine
      .replace(/^[-*]\s*/, "")
      .replace(/^branch\s*[:\-]\s*/i, "")
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();

    candidate = candidate
      .toLowerCase()
      .replace(/[^a-z0-9/\-]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .replace(/\/{2,}/g, "/")
      .replace(/(^\/|\/\s*$)/g, "");

    if (candidate.length < 3) return null;
    if (candidate.length > MAX_BRANCH_NAME_LENGTH) {
      candidate = candidate.slice(0, MAX_BRANCH_NAME_LENGTH).replace(/-$/, "");
    }

    return candidate;
  }

  async function buildBranchNameWithAi(
    worktreePath: string,
    firstUserContent: string,
    firstAssistantContent: string,
  ): Promise<string | null> {
    const prompt = [
      "You generate concise git branch names.",
      "Return exactly one branch name line only.",
      "Rules:",
      "- Capture the user's core intent for the code change.",
      "- Use lowercase letters, hyphens only (no spaces, no underscores).",
      "- Keep it concise (2-5 words, max 60 chars).",
      "- Use a conventional prefix: feat/, fix/, refactor/, docs/, chore/",
      "- No quotes, no trailing punctuation.",
      "",
      `User message: ${firstUserContent.trim()}`,
      `Assistant reply: ${firstAssistantContent.trim()}`,
    ].join("\n");

    let streamedOutput = "";
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, BRANCH_GENERATION_TIMEOUT_MS);

    try {
      const result = await deps.claudeRunner({
        prompt,
        sessionId: null,
        cwd: worktreePath,
        abortController,
        permissionMode: "plan",
        onText: (chunk) => {
          streamedOutput += chunk;
        },
        onToolStarted: async () => {},
        onToolOutput: async () => {},
        onToolFinished: async () => {},
        onQuestionRequest: async () => ({ answers: {} }),
        onPermissionRequest: () => ({
          decision: "deny",
          message: "Tool use is disabled for branch name generation.",
        }),
        onPlanFileDetected: async () => {},
        onSubagentStarted: async () => {},
        onSubagentStopped: async () => {},
        onThinking: async () => {},
      });

      const raw = streamedOutput.trim().length > 0 ? streamedOutput : result.output;
      return normalizeGeneratedBranchName(raw);
    } catch (error) {
      deps.logService?.log(
        "warn",
        "chat.branch.rename",
        "AI branch name generation failed; keeping current branch.",
        {
          worktreePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function maybeAutoRenameBranchAfterFirstAssistantReply(threadId: string): Promise<string | null> {
    try {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        select: {
          worktree: {
            select: {
              id: true,
              branch: true,
              path: true,
              branchRenamed: true,
              repositoryId: true,
            },
          },
        },
      });
      if (!thread) return null;

      const worktree = thread.worktree;

      if (worktree.branchRenamed) {
        return null;
      }

      if (!isDefaultBranchName(worktree.branch)) {
        return null;
      }

      const firstUserMessage = await deps.prisma.chatMessage.findFirst({
        where: { threadId, role: "user" },
        orderBy: { seq: "asc" },
        select: { content: true },
      });
      if (!firstUserMessage) return null;

      const firstAssistantMessage = await deps.prisma.chatMessage.findFirst({
        where: { threadId, role: "assistant" },
        orderBy: { seq: "asc" },
        select: { content: true },
      });
      if (!firstAssistantMessage) return null;

      const newBranch = await buildBranchNameWithAi(
        worktree.path,
        firstUserMessage.content,
        firstAssistantMessage.content,
      );

      if (!newBranch || newBranch === worktree.branch) {
        return null;
      }

      const existing = await deps.prisma.worktree.findFirst({
        where: {
          repositoryId: worktree.repositoryId,
          branch: newBranch,
          id: { not: worktree.id },
        },
      });
      if (existing) {
        return null;
      }

      await renameBranchGit({
        cwd: worktree.path,
        oldBranch: worktree.branch,
        newBranch,
      });

      await deps.prisma.worktree.update({
        where: { id: worktree.id },
        data: { branch: newBranch, branchRenamed: true },
      });

      return newBranch;
    } catch (error) {
      deps.logService?.log(
        "warn",
        "chat.branch.rename",
        "Auto branch rename failed; keeping current branch.",
        {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  type PermissionDecisionResult = { decision: "allow" | "deny"; message?: string };
  type PendingPermissionEntry = {
    status: "pending" | "resolved";
    promise: Promise<PermissionDecisionResult>;
    resolve?: (result: PermissionDecisionResult) => void;
    reject?: (error: Error) => void;
    result?: PermissionDecisionResult;
    toolName: string;
    command: string | null;
  };
  const pendingPermissionsByThread = new Map<string, Map<string, PendingPermissionEntry>>();

  function ensureThreadPermissionMap(threadId: string): Map<string, PendingPermissionEntry> {
    const existing = pendingPermissionsByThread.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, PendingPermissionEntry>();
    pendingPermissionsByThread.set(threadId, created);
    return created;
  }

  function rejectPendingPermissions(threadId: string, message: string): void {
    const pendingMap = pendingPermissionsByThread.get(threadId);
    if (!pendingMap) {
      return;
    }

    pendingPermissionsByThread.delete(threadId);
    for (const pending of pendingMap.values()) {
      if (pending.status !== "pending" || !pending.reject) {
        continue;
      }
      pending.reject(new Error(message));
    }
  }

  type QuestionAnswerResult = { answers: Record<string, string> };
  type PendingQuestionEntry = {
    status: "pending" | "resolved";
    promise: Promise<QuestionAnswerResult>;
    resolve?: (result: QuestionAnswerResult) => void;
    reject?: (error: Error) => void;
  };
  const pendingQuestionsByThread = new Map<string, Map<string, PendingQuestionEntry>>();

  function ensureThreadQuestionMap(threadId: string): Map<string, PendingQuestionEntry> {
    const existing = pendingQuestionsByThread.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, PendingQuestionEntry>();
    pendingQuestionsByThread.set(threadId, created);
    return created;
  }

  function rejectPendingQuestions(threadId: string, message: string): void {
    const pendingMap = pendingQuestionsByThread.get(threadId);
    if (!pendingMap) {
      return;
    }

    pendingQuestionsByThread.delete(threadId);
    for (const pending of pendingMap.values()) {
      if (pending.status !== "pending" || !pending.reject) {
        continue;
      }
      pending.reject(new Error(message));
    }
  }

  type PendingPlanEntry = {
    content: string;
    filePath: string;
  };
  const pendingPlanByThread = new Map<string, PendingPlanEntry>();

  async function recoverPendingPlan(threadId: string): Promise<PendingPlanEntry | null> {
    const events = await deps.eventHub.list(threadId);
    let lastPlan: PendingPlanEntry | null = null;

    for (const event of events) {
      if (event.type === "plan.created") {
        const content = typeof event.payload.content === "string" ? event.payload.content : "";
        const filePath = typeof event.payload.filePath === "string" ? event.payload.filePath : "";
        if (content.length > 0) {
          lastPlan = { content, filePath };
        }
      } else if (event.type === "plan.approved" || event.type === "plan.revision_requested") {
        lastPlan = null;
      }
    }

    return lastPlan;
  }

  async function runAssistant(threadId: string, prompt: string, mode: ChatMode = "default", options?: { autoAcceptTools?: boolean }): Promise<void> {
    let assistantMessageId: string | null = null;
    let fullOutput = "";
    const abortController = new AbortController();
    runningAbortControllersByThread.set(threadId, abortController);

    try {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        include: {
          worktree: true,
        },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const worktreePath = thread.worktree.path;
      if (!existsSync(worktreePath)) {
        throw new Error(`Worktree path not found: ${worktreePath}. Create a new worktree from Repository panel.`);
      }
      if (!statSync(worktreePath).isDirectory()) {
        throw new Error(`Worktree path is not a directory: ${worktreePath}. Create a new worktree from Repository panel.`);
      }

      const beforeState = await captureWorktreeState(worktreePath);

      const assistantSeq = await nextMessageSeq(deps.prisma, threadId);
      const assistantMessage = await deps.prisma.chatMessage.create({
        data: {
          threadId,
          seq: assistantSeq,
          role: "assistant",
          content: "",
        },
      });

      assistantMessageId = assistantMessage.id;

      const result = await deps.claudeRunner({
        prompt,
        sessionId: thread.claudeSessionId,
        cwd: worktreePath,
        abortController,
        permissionMode: mode,
        autoAcceptTools: options?.autoAcceptTools,
        onText: async (chunk) => {
          fullOutput += chunk;
          await deps.eventHub.emit(threadId, "message.delta", {
            messageId: assistantMessage.id,
            role: "assistant",
            delta: chunk,
            ...(mode === "plan" ? { mode: "plan" } : {}),
          });
        },
        onThinking: async (chunk) => {
          await deps.eventHub.emit(threadId, "thinking.delta", {
            messageId: assistantMessage.id,
            delta: chunk,
          });
        },
        onToolStarted: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.started", payload);
        },
        onToolOutput: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.output", payload);
        },
        onToolFinished: async (payload) => {
          await deps.eventHub.emit(threadId, "tool.finished", payload);
        },
        onSubagentStarted: async (payload) => {
          await deps.eventHub.emit(threadId, "subagent.started", payload);
        },
        onSubagentStopped: async (payload) => {
          await deps.eventHub.emit(threadId, "subagent.finished", payload);
        },
        onToolInstrumentation: async (event) => {
          if (!deps.logService) {
            return;
          }

          const isAnomaly = event.stage === "anomaly";
          deps.logService.log(
            isAnomaly ? "warn" : "debug",
            isAnomaly ? "claude.tool.sync" : "claude.tool",
            instrumentationMessage(event),
            {
              threadId,
              ...event,
            },
          );
        },
        onQuestionRequest: async (payload) => {
          const pendingMap = ensureThreadQuestionMap(threadId);
          const existing = pendingMap.get(payload.requestId);
          if (existing) {
            return existing.promise;
          }

          const entry = {} as PendingQuestionEntry;
          entry.status = "pending";
          entry.promise = new Promise<QuestionAnswerResult>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          pendingMap.set(payload.requestId, entry);

          try {
            await deps.eventHub.emit(threadId, "question.requested", {
              requestId: payload.requestId,
              questions: payload.questions,
            });
          } catch (error) {
            pendingMap.delete(payload.requestId);
            if (pendingMap.size === 0) {
              pendingQuestionsByThread.delete(threadId);
            }
            entry.reject?.(error instanceof Error ? error : new Error("Failed to emit question.requested event"));
            throw error;
          }
          return entry.promise;
        },
        onPlanFileDetected: async (payload) => {
          const source = inferPlanDetectionSource(payload.filePath, payload.source);
          pendingPlanByThread.set(threadId, {
            content: payload.content,
            filePath: payload.filePath,
          });
          await deps.eventHub.emit(threadId, "plan.created", {
            content: payload.content,
            filePath: payload.filePath,
            messageId: assistantMessage.id,
            source,
          });
        },
        onPermissionRequest: async (payload) => {
          const pendingMap = ensureThreadPermissionMap(threadId);
          const existing = pendingMap.get(payload.requestId);
          if (existing) {
            if (existing.status === "resolved" && existing.result) {
              return existing.result;
            }
            return existing.promise;
          }

          const entry = {} as PendingPermissionEntry;
          entry.status = "pending";
          entry.toolName = payload.toolName;
          const command = payload.toolInput.command;
          entry.command = typeof command === "string" && command.trim().length > 0 ? command.trim() : null;
          entry.promise = new Promise<PermissionDecisionResult>((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
          });
          pendingMap.set(payload.requestId, entry);

          try {
            await deps.eventHub.emit(threadId, "permission.requested", {
              requestId: payload.requestId,
              toolName: payload.toolName,
              toolInput: payload.toolInput,
              command: entry.command,
              blockedPath: payload.blockedPath,
              decisionReason: payload.decisionReason,
              suggestions: payload.suggestions ?? [],
            });
          } catch (error) {
            pendingMap.delete(payload.requestId);
            if (pendingMap.size === 0) {
              pendingPermissionsByThread.delete(threadId);
            }
            entry.reject?.(error instanceof Error ? error : new Error("Failed to emit permission.requested event"));
            throw error;
          }
          return entry.promise;
        },
      });

      await deps.prisma.$transaction(async (tx) => {
        await tx.chatMessage.update({
          where: { id: assistantMessage.id },
          data: {
            content: fullOutput.trim(),
          },
        });

        await tx.chatThread.update({
          where: { id: threadId },
          data: {
            claudeSessionId: result.sessionId,
          },
        });
      });
      const renamedThreadTitle = await maybeAutoRenameThreadAfterFirstAssistantReply(threadId);
      let completionThreadTitle: string | null = renamedThreadTitle;
      if (!completionThreadTitle) {
        try {
          const completionThread = await deps.prisma.chatThread.findUnique({
            where: { id: threadId },
            select: {
              title: true,
            },
          });
          completionThreadTitle = completionThread?.title ?? null;
        } catch (error) {
          deps.logService?.log(
            "warn",
            "chat.thread.title",
            "Failed to read thread title for completion payload.",
            {
              threadId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }

      const afterState = await captureWorktreeState(thread.worktree.path);
      const diffSnapshot = beforeState && afterState ? buildDiffDelta(beforeState, afterState) : null;
      if (diffSnapshot) {
        const fileCount = diffSnapshot.changedFiles.length;
        const summary = fileCount > 0 ? `Edited ${fileCount} file${fileCount === 1 ? "" : "s"}` : "Captured worktree diff";

        await deps.eventHub.emit(threadId, "tool.finished", {
          summary,
          precedingToolUseIds: [],
          source: "worktree.diff",
          changedFiles: diffSnapshot.changedFiles,
          diff: diffSnapshot.diff,
          diffTruncated: diffSnapshot.diffTruncated,
        });
      }

      // Only auto-rename branch when there are actual file changes (not just exploration/Q&A)
      const hasFileChanges = diffSnapshot != null && diffSnapshot.changedFiles.length > 0;
      const renamedBranch = hasFileChanges
        ? await maybeAutoRenameBranchAfterFirstAssistantReply(threadId)
        : null;

      await deps.eventHub.emit(threadId, "chat.completed", {
        messageId: assistantMessage.id,
        ...(completionThreadTitle ? { threadTitle: completionThreadTitle } : {}),
        ...(renamedBranch ? { worktreeBranch: renamedBranch } : {}),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown chat error";
      const wasCancelled = abortController.signal.aborted || isAbortError(error);

      if (assistantMessageId) {
        await deps.prisma.chatMessage.update({
          where: { id: assistantMessageId },
          data: {
            content: wasCancelled ? fullOutput : fullOutput.length > 0 ? fullOutput : `[runtime-error] ${errorMessage}`,
          },
        });
      }

      if (wasCancelled) {
        await deps.eventHub.emit(threadId, "chat.completed", {
          ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
          cancelled: true,
        });
      } else {
        await deps.eventHub.emit(threadId, "chat.failed", {
          message: errorMessage,
        });
      }
    } finally {
      runningAbortControllersByThread.delete(threadId);
      scheduledAssistantRunsByThread.delete(threadId);
      rejectPendingPermissions(threadId, "Permission request cancelled because the chat run ended.");
      rejectPendingQuestions(threadId, "Question cancelled because the chat run ended.");
      activeThreads.delete(threadId);
    }
  }

  function scheduleAssistant(threadId: string, prompt: string, mode: ChatMode = "default", options?: { autoAcceptTools?: boolean }): void {
    clearScheduledAssistantRun(threadId);
    const timer = setTimeout(() => {
      scheduledAssistantRunsByThread.delete(threadId);
      void runAssistant(threadId, prompt, mode, options);
    }, AUTO_EXECUTE_DELAY_MS);
    scheduledAssistantRunsByThread.set(threadId, timer);
  }

  return {
    async listThreads(worktreeId: string): Promise<ChatThread[]> {
      const threads = await deps.prisma.chatThread.findMany({
        where: { worktreeId },
        orderBy: { updatedAt: "desc" },
      });

      return threads.map(mapChatThread);
    },

    async createThread(worktreeId: string, rawInput: unknown): Promise<ChatThread> {
      const input: CreateChatThreadInput = CreateChatThreadInputSchema.parse(rawInput ?? {});

      const worktree = await deps.prisma.worktree.findUnique({ where: { id: worktreeId } });
      if (!worktree) {
        throw new Error("Worktree not found");
      }

      const thread = await deps.prisma.chatThread.create({
        data: {
          worktreeId,
          title: input.title ?? "Main Thread",
        },
      });

      return mapChatThread(thread);
    },

    async getThreadById(threadId: string): Promise<ChatThread | null> {
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      return thread ? mapChatThread(thread) : null;
    },

    async deleteThread(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Cannot delete a thread while assistant is processing");
      }

      await deps.prisma.chatThread.delete({
        where: { id: threadId },
      });
    },

    async listMessages(threadId: string): Promise<ChatMessage[]> {
      const messages = await deps.prisma.chatMessage.findMany({
        where: { threadId },
        orderBy: { seq: "asc" },
      });

      return messages.map(mapChatMessage);
    },

    async listEvents(threadId: string, afterIdx?: number): Promise<ChatEvent[]> {
      return deps.eventHub.list(threadId, afterIdx);
    },

    async stopRun(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (!activeThreads.has(threadId)) {
        throw new Error("No active assistant run for this thread");
      }

      rejectPendingPermissions(threadId, "Permission request cancelled by user.");
      rejectPendingQuestions(threadId, "Question cancelled by user.");

      const cancelledScheduledRun = clearScheduledAssistantRun(threadId);
      if (cancelledScheduledRun) {
        activeThreads.delete(threadId);
        await deps.eventHub.emit(threadId, "chat.completed", {
          cancelled: true,
        });
        return;
      }

      const abortController = runningAbortControllersByThread.get(threadId);
      if (!abortController) {
        throw new Error("Assistant run is not cancellable right now");
      }

      abortController.abort();
    },

    async resolvePermission(threadId: string, rawInput: unknown): Promise<void> {
      const input: ResolvePermissionInput = ResolvePermissionInputSchema.parse(rawInput);
      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
        include: {
          worktree: true,
        },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const pendingMap = pendingPermissionsByThread.get(threadId);
      const entry = pendingMap?.get(input.requestId);
      if (!entry || entry.status !== "pending" || !entry.resolve) {
        await deps.eventHub.emit(threadId, "permission.resolved", {
          requestId: input.requestId,
          decision: "deny",
          resolver: "system",
          message: "Session expired — the assistant is no longer running.",
          persisted: false,
          settingsPath: null,
          permissionRule: null,
        });
        return;
      }

      const denialMessage = "Tool execution denied by user.";
      const isAlwaysAllow = input.decision === "allow_always";
      const isAllow = input.decision === "allow" || isAlwaysAllow;

      let persisted = false;
      let settingsPath: string | null = null;
      let permissionRule: string | null = null;
      if (isAlwaysAllow) {
        if (!entry.command) {
          throw new Error("Always allow requires a command in the permission request.");
        }
        permissionRule = `${entry.toolName}(${entry.command}:*)`;
        const persistedResult = persistAlwaysAllowRule(thread.worktree.path, permissionRule);
        persisted = persistedResult.persisted;
        settingsPath = persistedResult.settingsPath;
      }

      const decisionMessage = input.decision === "allow"
        ? "Allowed once by user."
        : input.decision === "allow_always"
          ? "Always allowed in this workspace by user."
          : denialMessage;

      try {
        await deps.eventHub.emit(threadId, "permission.resolved", {
          requestId: input.requestId,
          decision: input.decision,
          resolver: "user",
          message: decisionMessage,
          persisted,
          settingsPath,
          permissionRule,
        });
      } finally {
        const result: PermissionDecisionResult = isAllow
          ? { decision: "allow" }
          : {
            decision: "deny",
            message: denialMessage,
          };
        const resolve = entry.resolve;
        entry.status = "resolved";
        entry.result = result;
        entry.resolve = undefined;
        entry.reject = undefined;
        resolve?.(result);
      }
    },

    async answerQuestion(threadId: string, rawInput: unknown): Promise<void> {
      const input: AnswerQuestionInput = AnswerQuestionInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      const pendingMap = pendingQuestionsByThread.get(threadId);
      const entry = pendingMap?.get(input.requestId);
      if (!entry || entry.status !== "pending" || !entry.resolve) {
        await deps.eventHub.emit(threadId, "question.answered", {
          requestId: input.requestId,
          answers: input.answers,
        });
        return;
      }

      try {
        await deps.eventHub.emit(threadId, "question.answered", {
          requestId: input.requestId,
          answers: input.answers,
        });
      } finally {
        const resolve = entry.resolve;
        entry.status = "resolved";
        entry.resolve = undefined;
        entry.reject = undefined;
        resolve?.({ answers: input.answers });
      }
    },

    async approvePlan(threadId: string): Promise<void> {
      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      let plan = pendingPlanByThread.get(threadId);
      if (!plan) {
        plan = await recoverPendingPlan(threadId) ?? undefined;
        if (!plan) {
          throw new Error("No pending plan to approve for this thread");
        }
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Assistant is still processing");
      }

      pendingPlanByThread.delete(threadId);
      activeThreads.add(threadId);

      await deps.eventHub.emit(threadId, "plan.approved", {
        filePath: plan.filePath,
      });

      const executePrompt = `The user has approved the following plan. Please execute it now:\n\n${plan.content}`;
      scheduleAssistant(threadId, executePrompt, "default", { autoAcceptTools: true });
    },

    async revisePlan(threadId: string, rawInput: unknown): Promise<void> {
      const input: PlanRevisionInput = PlanRevisionInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({ where: { id: threadId } });
      if (!thread) {
        throw new Error("Chat thread not found");
      }

      let plan = pendingPlanByThread.get(threadId);
      if (!plan) {
        plan = await recoverPendingPlan(threadId) ?? undefined;
        if (!plan) {
          throw new Error("No pending plan to revise for this thread");
        }
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Assistant is still processing");
      }

      pendingPlanByThread.delete(threadId);
      activeThreads.add(threadId);

      const seq = await nextMessageSeq(deps.prisma, threadId);
      const message = await deps.prisma.chatMessage.create({
        data: { threadId, seq, role: "user", content: input.feedback },
      });
      await deps.eventHub.emit(threadId, "message.delta", {
        messageId: message.id,
        role: "user",
        delta: input.feedback,
      });

      await deps.eventHub.emit(threadId, "plan.revision_requested", {
        feedback: input.feedback,
        filePath: plan.filePath,
      });

      const revisePrompt = `The user wants to revise the plan. Here is their feedback:\n\n${input.feedback}\n\nPlease update the plan accordingly.`;
      scheduleAssistant(threadId, revisePrompt, "plan");
    },

    async sendMessage(threadId: string, rawInput: unknown): Promise<ChatMessage> {
      const input: SendChatMessageInput = SendChatMessageInputSchema.parse(rawInput);

      const thread = await deps.prisma.chatThread.findUnique({
        where: { id: threadId },
      });

      if (!thread) {
        throw new Error("Chat thread not found");
      }

      if (activeThreads.has(threadId)) {
        throw new Error("Assistant is still processing the previous message");
      }
      activeThreads.add(threadId);

      try {
        const seq = await nextMessageSeq(deps.prisma, threadId);
        const message = await deps.prisma.chatMessage.create({
          data: {
            threadId,
            seq,
            role: "user",
            content: input.content,
          },
        });

        await deps.eventHub.emit(threadId, "message.delta", {
          messageId: message.id,
          role: "user",
          delta: input.content,
        });

        scheduleAssistant(threadId, input.content, input.mode);

        return mapChatMessage(message);
      } catch (error) {
        activeThreads.delete(threadId);
        throw error;
      }
    },
  };
}
