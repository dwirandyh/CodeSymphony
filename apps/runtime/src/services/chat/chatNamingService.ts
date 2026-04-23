import { DEFAULT_CHAT_MODEL_BY_AGENT, type CliAgent } from "@codesymphony/shared-types";
import type { RuntimeDeps } from "../../types.js";
import type { ProviderOptions } from "./chatService.types.js";
import { isDefaultBranchName } from "../worktreeService.js";
import { renameBranch as renameBranchGit } from "../git.js";

const MAX_THREAD_TITLE_LENGTH = 48;
const TITLE_GENERATION_TIMEOUT_MS = 15000;
const MAX_BRANCH_NAME_LENGTH = 60;
const BRANCH_GENERATION_TIMEOUT_MS = 15000;

function isDefaultThreadTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized === "New Thread" || normalized === "Main Thread" || /^Thread\s+\d+$/.test(normalized);
}

export function clampThreadTitle(input: string, maxLength = MAX_THREAD_TITLE_LENGTH): string {
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

function resolveAgent(agent: CliAgent | undefined): CliAgent {
  if (agent === "codex" || agent === "opencode") {
    return agent;
  }
  return "claude";
}

function toRunnerOptional(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getRunnerForAgent(deps: RuntimeDeps, agent: CliAgent) {
  if (agent === "codex") {
    return deps.codexRunner ?? deps.claudeRunner;
  }
  if (agent === "opencode") {
    return deps.opencodeRunner ?? deps.claudeRunner;
  }
  return deps.claudeRunner;
}

function resolveNamingPermissionMode(agent: CliAgent): "default" | "plan" {
  return agent === "opencode" ? "default" : "plan";
}

async function buildThreadTitleWithAi(
  deps: RuntimeDeps,
  threadId: string,
  worktreePath: string,
  firstUserContent: string,
  firstAssistantContent: string,
  providerOptions?: ProviderOptions,
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
  const agent = resolveAgent(providerOptions?.agent);
  const runner = getRunnerForAgent(deps, agent);

  try {
    const result = await runner({
      prompt,
      sessionId: null,
      cwd: worktreePath,
      abortController,
      permissionMode: resolveNamingPermissionMode(agent),
      model: providerOptions?.model ?? DEFAULT_CHAT_MODEL_BY_AGENT[agent],
      providerApiKey: toRunnerOptional(providerOptions?.providerApiKey),
      providerBaseUrl: toRunnerOptional(providerOptions?.providerBaseUrl),
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
    });

    const raw = streamedOutput.trim().length > 0 ? streamedOutput : result.output;
    return normalizeGeneratedThreadTitle(raw);
  } catch (error) {
    deps.logService?.log(
      "warn",
      "chat.thread.title",
      "AI title generation failed; keeping current title.",
      {
        threadId,
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function maybeAutoRenameThreadAfterFirstAssistantReply(
  deps: RuntimeDeps,
  threadId: string,
  expectedAssistantMessageId: string,
  providerOptions?: ProviderOptions,
): Promise<string | null> {
  try {
    const thread = await deps.prisma.chatThread.findUnique({
      where: { id: threadId },
      select: {
        title: true,
        titleEditedManually: true,
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

    if (thread.titleEditedManually) {
      return null;
    }

    const originalTitle = thread.title;
    if (!isDefaultThreadTitle(originalTitle)) {
      return null;
    }

    const assistantMessageCount = await deps.prisma.chatMessage.count({
      where: {
        threadId,
        role: "assistant",
      },
    });
    if (assistantMessageCount !== 1) {
      return null;
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
      return null;
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
        id: true,
        content: true,
      },
    });
    if (!firstAssistantMessage || firstAssistantMessage.id !== expectedAssistantMessageId) {
      return null;
    }

    const nextTitle = await buildThreadTitleWithAi(
      deps,
      threadId,
      thread.worktree.path,
      firstUserMessage.content,
      firstAssistantMessage.content,
      providerOptions,
    );
    if (!nextTitle || nextTitle === originalTitle) {
      return null;
    }

    const updated = await deps.prisma.chatThread.updateMany({
      where: {
        id: threadId,
        titleEditedManually: false,
        title: originalTitle,
      },
      data: { title: nextTitle },
    });

    return updated.count > 0 ? nextTitle : null;
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
  deps: RuntimeDeps,
  threadId: string,
  worktreePath: string,
  firstUserContent: string,
  firstAssistantContent: string,
  providerOptions?: ProviderOptions,
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
  const agent = resolveAgent(providerOptions?.agent);
  const runner = getRunnerForAgent(deps, agent);

  try {
    const result = await runner({
      prompt,
      sessionId: null,
      cwd: worktreePath,
      abortController,
      permissionMode: resolveNamingPermissionMode(agent),
      model: providerOptions?.model ?? DEFAULT_CHAT_MODEL_BY_AGENT[agent],
      providerApiKey: toRunnerOptional(providerOptions?.providerApiKey),
      providerBaseUrl: toRunnerOptional(providerOptions?.providerBaseUrl),
      onText: (chunk) => {
        streamedOutput += chunk;
      },
      onToolStarted: async () => { },
      onToolOutput: async () => { },
      onToolFinished: async () => { },
      onQuestionRequest: async () => ({ answers: {} }),
      onPermissionRequest: () => ({
        decision: "deny",
        message: "Tool use is disabled for branch name generation.",
      }),
      onPlanFileDetected: async () => { },
      onSubagentStarted: async () => { },
      onSubagentStopped: async () => { },
    });

    const raw = streamedOutput.trim().length > 0 ? streamedOutput : result.output;
    return normalizeGeneratedBranchName(raw);
  } catch (error) {
    deps.logService?.log(
      "warn",
      "chat.branch.rename",
      "AI branch name generation failed; keeping current branch.",
      {
        threadId,
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const __testing = {
  resolveNamingPermissionMode,
};

export async function maybeAutoRenameBranchAfterFirstAssistantReply(
  deps: RuntimeDeps,
  threadId: string,
  expectedAssistantMessageId: string,
  providerOptions?: ProviderOptions,
): Promise<string | null> {
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
      select: { id: true, content: true },
    });
    if (!firstAssistantMessage || firstAssistantMessage.id !== expectedAssistantMessageId) return null;

    const newBranch = await buildBranchNameWithAi(
      deps,
      threadId,
      worktree.path,
      firstUserMessage.content,
      firstAssistantMessage.content,
      providerOptions,
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
