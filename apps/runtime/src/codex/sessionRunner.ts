import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { PermissionDecision } from "@codesymphony/shared-types";
import { DEFAULT_CHAT_MODEL_BY_AGENT, type SlashCommand } from "@codesymphony/shared-types";
import type { ChatAgentRunner, ChatAgentRunnerResult } from "../types.js";
import {
  buildCollaborationMode,
  resolveCodexRuntimePolicy,
  shouldAutoDeclineCodexPlanApproval,
} from "./collaborationMode.js";
import {
  PLAN_FILE_PATH,
  type CodexPlanStep,
  findPlanTextInTurn,
  resolveExplicitCodexPlanContent,
  resolveCodexPlanContent,
  type CodexStructuredPlan,
} from "./plan.js";
import { asArray, asNumber, asObject, asString } from "./protocolUtils.js";
import {
  buildSummaryFromCommandExecution,
  buildSummaryFromFileChange,
  classifyCommandExecution,
  classifyFileChange,
  getToolContext,
  selectPrimaryCodexFileChange,
  toOwnership,
  type ToolContext,
} from "./toolContext.js";

export {
  buildCollaborationMode,
  requestedPermissionsIncludeFileWrite,
  resolveCodexRuntimePolicy,
  shouldAutoDeclineCodexPlanApproval,
} from "./collaborationMode.js";
export {
  buildCodexPlanMarkdown,
  resolveHeuristicPlanContent,
  resolveExplicitCodexPlanContent,
  resolveCodexPlanContent,
} from "./plan.js";
export { selectPrimaryCodexFileChange } from "./toolContext.js";

type JsonRpcRequest = {
  id: string | number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type PendingRequest = {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const CODEX_BINARY = process.env.CODEX_BINARY_PATH ?? "codex";
const REQUEST_TIMEOUT_MS = 20_000;
const CODEX_CUSTOM_PROVIDER_ID = "codesymphony_custom";
const CODEX_CUSTOM_PROVIDER_API_KEY_ENV = "CODESYMPHONY_CODEX_API_KEY";
const CODEX_APP_SERVER_INITIALIZED_MESSAGE = { method: "initialized" } as const;

function normalizeCodexCommandApprovalDecision(decision: PermissionDecision): "accept" | "acceptForSession" | "decline" {
  if (decision === "allow_always") {
    return "acceptForSession";
  }
  return decision === "allow" ? "accept" : "decline";
}

function normalizeCodexFileChangeApprovalDecision(decision: PermissionDecision): "accept" | "acceptForSession" | "decline" {
  if (decision === "allow_always") {
    return "acceptForSession";
  }
  return decision === "allow" ? "accept" : "decline";
}

function buildCodexGrantedPermissions(
  requestedPermissions: Record<string, unknown> | undefined,
  decision: PermissionDecision,
): {
  permissions: Record<string, unknown>;
  scope?: "turn" | "session";
} {
  if (decision === "deny") {
    return {
      permissions: {},
      scope: "turn",
    };
  }

  return {
    permissions: requestedPermissions ?? {},
    scope: decision === "allow_always" ? "session" : "turn",
  };
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexCustomProviderArgs(params: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): string[] {
  const normalizedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const args = [
    "-c",
    `model=${escapeTomlString(params.model.trim())}`,
    "-c",
    `model_provider=${escapeTomlString(CODEX_CUSTOM_PROVIDER_ID)}`,
    "-c",
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.base_url=${escapeTomlString(normalizedBaseUrl)}`,
    "-c",
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.wire_api=${escapeTomlString("responses")}`,
  ];

  if (params.apiKey?.trim()) {
    args.push(
      "-c",
      `model_providers.${CODEX_CUSTOM_PROVIDER_ID}.env_key=${escapeTomlString(CODEX_CUSTOM_PROVIDER_API_KEY_ENV)}`,
    );
  }

  return args;
}

function buildCodexRuntimeLaunchConfig(params: {
  model: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
}): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const normalizedBaseUrl = params.providerBaseUrl?.trim();
  const normalizedApiKey = params.providerApiKey?.trim();

  if (normalizedBaseUrl) {
    return {
      args: [
        "app-server",
        ...buildCodexCustomProviderArgs({
          baseUrl: normalizedBaseUrl,
          model: params.model,
          ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
        }),
      ],
      env: {
        ...env,
        ...(normalizedApiKey ? { [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: normalizedApiKey } : {}),
      },
    };
  }

  if (normalizedApiKey) {
    env.OPENAI_API_KEY = normalizedApiKey;
  }

  return {
    args: ["app-server"],
    env,
  };
}

function toSlashCommandsFromSkillsResponse(response: unknown): SlashCommand[] {
  const entries = asArray(asObject(response)?.data);
  const deduped = new Map<string, SlashCommand>();

  for (const rawEntry of entries) {
    const skills = asArray(asObject(rawEntry)?.skills);
    for (const rawSkill of skills) {
      const skill = asObject(rawSkill);
      if (!skill || skill.enabled === false) {
        continue;
      }

      const name = asString(skill.name)?.trim();
      if (!name) {
        continue;
      }

      const interfaceObject = asObject(skill.interface);
      const description = (
        asString(interfaceObject?.shortDescription)
        ?? asString(skill.shortDescription)
        ?? asString(skill.description)
        ?? ""
      ).trim();

      deduped.set(name.toLowerCase(), {
        name,
        description,
        argumentHint: "",
      });
    }
  }

  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function listCodexSlashCommands(params: {
  cwd: string;
  model?: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
}): Promise<SlashCommand[]> {
  const resolvedModel = params.model?.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.codex;
  const { args, env } = buildCodexRuntimeLaunchConfig({
    model: resolvedModel,
    providerApiKey: params.providerApiKey,
    providerBaseUrl: params.providerBaseUrl,
  });
  const child = spawn(CODEX_BINARY, args, {
    cwd: params.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const output = readline.createInterface({ input: child.stdout });
  const pending = new Map<string, PendingRequest>();
  let finished = false;

  const finish = (error?: Error) => {
    if (finished) {
      return;
    }
    finished = true;

    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      if (error) {
        entry.reject(error);
      }
    }
    pending.clear();

    output.removeAllListeners();
    output.close();
    child.removeAllListeners();
    child.stderr.removeAllListeners();

    if (!child.killed) {
      killChildProcess(child);
    }
  };

  const writeMessage = (message: unknown) => {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const sendRequest = async <TResponse>(method: string, requestParams: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TResponse> => {
    const id = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      pending.set(id, {
        method,
        timeout,
        resolve,
        reject,
      });

      writeMessage({
        id,
        method,
        params: requestParams,
      });
    });

    return result as TResponse;
  };

  try {
    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (!isResponse(parsed)) {
        return;
      }

      const entry = pending.get(String(parsed.id));
      if (!entry) {
        return;
      }

      clearTimeout(entry.timeout);
      pending.delete(String(parsed.id));
      if (parsed.error?.message) {
        entry.reject(new Error(parsed.error.message));
        return;
      }
      entry.resolve(parsed.result);
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("exit", (code, signal) => {
      if (finished) {
        return;
      }
      finish(new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });

    await sendRequest("initialize", {
      clientInfo: {
        name: "codesymphony-runtime",
        title: "CodeSymphony Runtime",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    writeMessage(CODEX_APP_SERVER_INITIALIZED_MESSAGE);

    const response = await sendRequest("skills/list", {
      cwds: [params.cwd],
      forceReload: true,
    });

    return toSlashCommandsFromSkillsResponse(response);
  } finally {
    finish();
  }
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isResponse(value: unknown): value is JsonRpcResponse {
  const candidate = asObject(value);
  return Boolean(candidate && (typeof candidate.id === "string" || typeof candidate.id === "number") && !candidate.method);
}

function isServerRequest(value: unknown): value is JsonRpcRequest {
  const candidate = asObject(value);
  return Boolean(candidate && (typeof candidate.id === "string" || typeof candidate.id === "number") && typeof candidate.method === "string");
}

function isServerNotification(value: unknown): value is JsonRpcNotification {
  const candidate = asObject(value);
  return Boolean(candidate && typeof candidate.method === "string" && candidate.id === undefined);
}

function extractOwnerToolUseId(
  subagentOwnerByThreadId: Map<string, string>,
  params: Record<string, unknown> | undefined,
): string | null {
  const threadId = asString(params?.threadId) ?? asString(asObject(params?.thread)?.id);
  if (!threadId) {
    return null;
  }
  return subagentOwnerByThreadId.get(threadId) ?? null;
}

function buildQuestionOptions(question: Record<string, unknown>): Array<{ label: string; description?: string }> | undefined {
  const options = asArray(question.options)
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => {
      const label = asString(entry.label)?.trim();
      if (!label) {
        return null;
      }
      return {
        label,
        description: asString(entry.description)?.trim(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return options.length > 0 ? options : undefined;
}

function buildQuestionPayload(params: Record<string, unknown> | undefined) {
  return asArray(params?.questions)
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((question, index) => {
      const prompt = asString(question.question)?.trim() ?? asString(question.prompt)?.trim();
      if (!prompt) {
        return null;
      }

      return {
        id: asString(question.id)?.trim() ?? `question_${index + 1}`,
        header: asString(question.header)?.trim() ?? "Question",
        question: prompt,
        options: buildQuestionOptions(question),
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

function toCodexAnswers(answers: Record<string, string>): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => [
      questionId,
      {
        answers: [answer],
      },
    ]),
  );
}

function killChildProcess(child: ChildProcessWithoutNullStreams): void {
  child.kill();
}

function normalizeAgentMessagePhase(phase: string | null | undefined): string {
  const normalized = phase?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "final_answer";
}

function shouldForwardAgentMessagePhase(phase: string, includeCommentaryInText: boolean): boolean {
  return phase === "final_answer" || (includeCommentaryInText && phase === "commentary");
}

function shouldSuppressShortFinalAnswerAfterCommentary(finalText: string, visibleOutput: string): boolean {
  const trimmedFinalText = finalText.trim();
  if (trimmedFinalText.length === 0) {
    return true;
  }

  const isShortFinal = trimmedFinalText.length <= 200 && trimmedFinalText.split(/\r?\n/).length <= 4;
  if (!isShortFinal) {
    return false;
  }

  return visibleOutput.includes(trimmedFinalText);
}

function prefixAgentMessageSegment(currentOutput: string, nextText: string): string {
  if (currentOutput.length === 0 || nextText.length === 0) {
    return nextText;
  }

  if (/\n\n$/u.test(currentOutput) || nextText.startsWith("\n\n")) {
    return nextText;
  }

  if (/\n$/u.test(currentOutput) || nextText.startsWith("\n")) {
    return `\n${nextText}`;
  }

  return `\n\n${nextText}`;
}

export const runCodexWithStreaming: ChatAgentRunner = async ({
  prompt,
  sessionId,
  listSlashCommandsOnly,
  includeCommentaryInText = false,
  cwd,
  abortController,
  onSessionId,
  permissionMode,
  threadPermissionMode,
  model,
  providerApiKey,
  providerBaseUrl,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
  onSubagentStarted,
  onSubagentStopped,
}): Promise<ChatAgentRunnerResult> => {
  if (listSlashCommandsOnly) {
    return {
      output: "",
      sessionId: null,
      slashCommands: [],
    };
  }

  const resolvedModel = model?.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.codex;
  const { approvalPolicy, sandbox } = resolveCodexRuntimePolicy({
    permissionMode,
    threadPermissionMode,
  });
  const { args: runtimeArgs, env: runtimeEnv } = buildCodexRuntimeLaunchConfig({
    model: resolvedModel,
    providerApiKey,
    providerBaseUrl,
  });
  const child = spawn(CODEX_BINARY, runtimeArgs, {
    cwd,
    env: runtimeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const output = readline.createInterface({ input: child.stdout });

  const pending = new Map<string, PendingRequest>();
  const toolStartedAt = new Map<string, number>();
  const toolContextById = new Map<string, ToolContext>();
  const agentMessagePhaseById = new Map<string, string>();
  const observedTextByMessageId = new Map<string, string>();
  const emittedTextByMessageId = new Map<string, string>();
  const subagentOwnerByThreadId = new Map<string, string>();
  const subagentDescriptionByToolUseId = new Map<string, string>();
  const planTextByItemId = new Map<string, string>();

  let providerThreadId: string | null = null;
  let finalOutput = "";
  let visibleOutput = "";
  let fallbackAgentOutput = "";
  let latestPlanText: string | null = null;
  let latestStructuredPlan: CodexStructuredPlan | null = null;
  let completed = false;
  let finished = false;
  let completionError: Error | null = null;
  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  let lastForwardedAgentMessageId: string | null = null;
  let sawForwardedCommentary = false;

  const resolveComplete = () => {
    if (completed) {
      return;
    }
    completed = true;
    resolveCompletion?.();
  };

  const rejectWith = (error: Error) => {
    if (completed) {
      return;
    }
    completed = true;
    completionError = error;
    rejectCompletion?.(error);
  };

  const emitAgentMessageText = async (itemId: string, phase: string, text: string) => {
    if (text.length === 0) {
      return;
    }

    const alreadyEmitted = emittedTextByMessageId.get(itemId) ?? "";
    const nextText = alreadyEmitted.length === 0
      ? prefixAgentMessageSegment(
        lastForwardedAgentMessageId && lastForwardedAgentMessageId !== itemId ? visibleOutput : "",
        text,
      )
      : text;

    emittedTextByMessageId.set(itemId, alreadyEmitted + text);
    visibleOutput += nextText;
    finalOutput += nextText;
    lastForwardedAgentMessageId = itemId;
    if (phase === "commentary") {
      sawForwardedCommentary = true;
    }

    await onText(nextText);
  };

  const finish = (error?: Error) => {
    if (finished) {
      return;
    }
    finished = true;

    if (error) {
      rejectWith(error);
    }

    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      if (error) {
        entry.reject(error);
      }
    }
    pending.clear();

    output.removeAllListeners();
    output.close();
    child.removeAllListeners();
    child.stderr.removeAllListeners();

    if (!child.killed) {
      killChildProcess(child);
    }
  };

  const writeMessage = (message: unknown) => {
    if (!child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const sendRequest = async <TResponse>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<TResponse> => {
    const id = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      pending.set(id, {
        method,
        timeout,
        resolve,
        reject,
      });

      writeMessage({
        id,
        method,
        params,
      });
    });

    return result as TResponse;
  };

  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;

    child.on("error", (error) => {
      rejectWith(error);
    });

    child.on("exit", (code, signal) => {
      if (finished) {
        return;
      }
      if (abortController?.signal.aborted) {
        rejectWith(createAbortError());
        return;
      }
      rejectWith(new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const stderr = chunk.toString().trim();
      if (!stderr) {
        return;
      }
      // Codex app-server writes recoverable tool-router diagnostics to stderr
      // even when the turn continues successfully, so stderr alone is not fatal.
    });

    output.on("line", async (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        rejectWith(new Error("Received invalid JSON from codex app-server."));
        return;
      }

      if (isResponse(parsed)) {
        const entry = pending.get(String(parsed.id));
        if (!entry) {
          return;
        }

        clearTimeout(entry.timeout);
        pending.delete(String(parsed.id));
        if (parsed.error?.message) {
          entry.reject(new Error(parsed.error.message));
          return;
        }
        entry.resolve(parsed.result);
        return;
      }

      if (isServerRequest(parsed)) {
        const params = asObject(parsed.params);
        const ownerToolUseId = extractOwnerToolUseId(subagentOwnerByThreadId, params);
        const ownership = toOwnership(ownerToolUseId);

        try {
          if (
            parsed.method === "item/commandExecution/requestApproval"
            || parsed.method === "item/fileRead/requestApproval"
            || parsed.method === "item/fileChange/requestApproval"
            || parsed.method === "item/permissions/requestApproval"
          ) {
            if (shouldAutoDeclineCodexPlanApproval({
              permissionMode,
              requestMethod: parsed.method,
              requestedPermissions: asObject(params?.permissions),
            })) {
              writeMessage({
                id: parsed.id,
                result: parsed.method === "item/permissions/requestApproval"
                  ? {
                    permissions: {},
                    scope: "turn",
                  }
                  : {
                    decision: "decline",
                  },
              });
              return;
            }

            const requestItemId = asString(params?.itemId);
            const item = asObject(params?.item) ?? params ?? {};
            const cachedToolContext = requestItemId ? toolContextById.get(requestItemId) : undefined;
            const toolContext = parsed.method === "item/permissions/requestApproval"
              ? {
                toolName: "Permissions",
                toolInput: {
                  permissions: asObject(params?.permissions) ?? {},
                },
                editTarget: asString(
                  asArray(asObject(asObject(params?.permissions)?.fileSystem)?.write)[0],
                )
                  ?? asString(
                    asArray(asObject(asObject(params?.permissions)?.fileSystem)?.read)[0],
                )
                  ?? undefined,
                ownership,
              }
              : parsed.method === "item/fileChange/requestApproval"
                ? cachedToolContext ?? classifyFileChange(item, ownerToolUseId)
                : parsed.method === "item/fileRead/requestApproval"
                  ? {
                    toolName: "Read",
                    toolInput: {
                      file_path: asString(item.path) ?? asString(params?.path) ?? cachedToolContext?.editTarget,
                    },
                    editTarget: asString(item.path) ?? asString(params?.path) ?? cachedToolContext?.editTarget,
                    ownership,
                  }
                  : cachedToolContext ?? classifyCommandExecution(item, ownerToolUseId);
            const requestId = randomUUID();
            const toolInput = toolContext.toolInput
              ?? (toolContext.command ? { command: toolContext.command } : {});
            const permissionResult = await onPermissionRequest({
              requestId,
              toolName: toolContext.toolName,
              toolInput,
              blockedPath: asString(params?.path) ?? toolContext.editTarget ?? null,
              decisionReason: asString(params?.reason) ?? null,
              suggestions: parsed.method === "item/commandExecution/requestApproval"
                ? [
                  ...asArray(params?.proposedExecpolicyAmendment),
                  ...asArray(params?.proposedNetworkPolicyAmendments),
                ]
                : null,
              subagentOwnerToolUseId: ownership.subagentOwnerToolUseId ?? null,
              launcherToolUseId: ownership.launcherToolUseId ?? null,
              ownershipReason: ownership.ownershipReason,
            });

            writeMessage({
              id: parsed.id,
              result: parsed.method === "item/permissions/requestApproval"
                ? buildCodexGrantedPermissions(asObject(params?.permissions), permissionResult.decision)
                : {
                  decision: parsed.method === "item/fileChange/requestApproval"
                    ? normalizeCodexFileChangeApprovalDecision(permissionResult.decision)
                    : normalizeCodexCommandApprovalDecision(permissionResult.decision),
                },
            });
            return;
          }

          if (parsed.method === "item/tool/requestUserInput") {
            const requestId = randomUUID();
            const questions = buildQuestionPayload(params);
            if (!questions || questions.length === 0) {
              writeMessage({
                id: parsed.id,
                error: {
                  code: -32602,
                  message: "No questions provided.",
                },
              });
              return;
            }

            const answers = await onQuestionRequest({
              requestId,
              questions,
            });

            writeMessage({
              id: parsed.id,
              result: {
                answers: toCodexAnswers(answers.answers),
              },
            });
            return;
          }

          writeMessage({
            id: parsed.id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${parsed.method}`,
            },
          });
        } catch (error) {
          rejectWith(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      if (!isServerNotification(parsed)) {
        return;
      }

      const params = asObject(parsed.params);
      const item = asObject(params?.item);
      const ownerToolUseId = extractOwnerToolUseId(subagentOwnerByThreadId, params);
      const ownership = toOwnership(ownerToolUseId);

      try {
        if (parsed.method === "thread/started") {
          const nextThreadId = asString(asObject(params?.thread)?.id) ?? asString(params?.threadId);
          if (nextThreadId && nextThreadId !== providerThreadId) {
            providerThreadId = nextThreadId;
            await onSessionId?.(nextThreadId);
          }
          return;
        }

        if (parsed.method === "turn/plan/updated") {
          const steps = asArray(params?.plan)
            .map(asObject)
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => {
              const step = asString(entry.step)?.trim();
              const status = asString(entry.status);
              if (
                !step
                || (status !== "pending" && status !== "inProgress" && status !== "completed")
              ) {
                return null;
              }
              return { step, status };
            })
            .filter((entry): entry is CodexPlanStep => entry !== null);

          if (steps.length > 0 || asString(params?.explanation)?.trim()) {
            latestStructuredPlan = {
              explanation: asString(params?.explanation)?.trim() ?? null,
              steps,
            };
          }
          return;
        }

        if (parsed.method === "item/plan/delta") {
          const itemId = asString(params?.itemId);
          const delta = asString(params?.delta);
          if (itemId && delta) {
            planTextByItemId.set(itemId, (planTextByItemId.get(itemId) ?? "") + delta);
          }
          return;
        }

        if (parsed.method === "item/started" && item) {
          const itemId = asString(item.id);
          const itemType = asString(item.type);
          const normalizedItemType = itemType?.trim().toLowerCase();
          if (!itemId || !itemType) {
            return;
          }

          if (normalizedItemType === "agentmessage") {
            const phase = normalizeAgentMessagePhase(asString(item.phase));
            agentMessagePhaseById.set(itemId, phase);
            const completedText = asString(item.text);
            if (completedText) {
              observedTextByMessageId.set(itemId, completedText);
            }
            return;
          }

          if (normalizedItemType === "plan") {
            const text = asString(item.text);
            if (text) {
              planTextByItemId.set(itemId, text);
            }
            return;
          }

          if (itemType === "collabAgentToolCall") {
            const receiverThreadIds = asArray(item.receiverThreadIds)
              .map(asString)
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
            for (const receiverThreadId of receiverThreadIds) {
              subagentOwnerByThreadId.set(receiverThreadId, itemId);
            }

            const description = asString(item.description) ?? asString(item.prompt) ?? asString(item.title) ?? "Delegated task";
            subagentDescriptionByToolUseId.set(itemId, description);
            await onSubagentStarted({
              agentId: receiverThreadIds[0] ?? itemId,
              agentType: asString(item.agentType) ?? "worker",
              toolUseId: itemId,
              description,
            });
          }

          const toolContext = getToolContext(item, ownerToolUseId);
          if (!toolContext) {
            return;
          }

          toolStartedAt.set(itemId, Date.now());
          toolContextById.set(itemId, toolContext);
          await onToolStarted({
            toolName: toolContext.toolName,
            toolUseId: itemId,
            parentToolUseId: toolContext.ownership?.parentToolUseId ?? null,
            subagentOwnerToolUseId: toolContext.ownership?.subagentOwnerToolUseId ?? null,
            launcherToolUseId: toolContext.ownership?.launcherToolUseId ?? null,
            ownershipReason: toolContext.ownership?.ownershipReason,
            command: toolContext.command,
            searchParams: toolContext.searchParams,
            editTarget: toolContext.editTarget,
            shell: toolContext.shell,
            isBash: toolContext.isBash,
          });
          return;
        }

        if (parsed.method === "item/agentMessage/delta") {
          const itemId = asString(params?.itemId);
          const phase = normalizeAgentMessagePhase(itemId ? agentMessagePhaseById.get(itemId) : undefined);
          const delta = asString(params?.delta);
          if (!delta || delta.length === 0) {
            return;
          }

          if (itemId) {
            observedTextByMessageId.set(itemId, (observedTextByMessageId.get(itemId) ?? "") + delta);
          }

          if (!shouldForwardAgentMessagePhase(phase, includeCommentaryInText)) {
            return;
          }

          if (phase === "final_answer" && includeCommentaryInText && sawForwardedCommentary) {
            return;
          }

          if (!itemId) {
            visibleOutput += delta;
            finalOutput += delta;
            await onText(delta);
            return;
          }

          await emitAgentMessageText(itemId, phase, delta);
          return;
        }

        if (parsed.method === "item/commandExecution/outputDelta") {
          const itemId = asString(params?.itemId);
          if (!itemId) {
            return;
          }
          const startedAt = toolStartedAt.get(itemId) ?? Date.now();
          await onToolOutput({
            toolName: "Bash",
            toolUseId: itemId,
            parentToolUseId: ownership.parentToolUseId ?? null,
            subagentOwnerToolUseId: ownership.subagentOwnerToolUseId ?? null,
            launcherToolUseId: ownership.launcherToolUseId ?? null,
            ownershipReason: ownership.ownershipReason,
            elapsedTimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
          });
          return;
        }

        if (parsed.method === "item/completed" && item) {
          const itemId = asString(item.id);
          const itemType = asString(item.type);
          const normalizedItemType = itemType?.trim().toLowerCase();
          const cachedToolContext = itemId ? toolContextById.get(itemId) : undefined;
          if (!itemId || !itemType) {
            return;
          }

          if (normalizedItemType === "agentmessage") {
            const phase = normalizeAgentMessagePhase(agentMessagePhaseById.get(itemId) ?? asString(item.phase));
            const text = asString(item.text) ?? observedTextByMessageId.get(itemId) ?? "";
            fallbackAgentOutput = text || fallbackAgentOutput;
            if (!shouldForwardAgentMessagePhase(phase, includeCommentaryInText)) {
              return;
            }

            if (phase === "final_answer" && includeCommentaryInText && sawForwardedCommentary) {
              if (shouldSuppressShortFinalAnswerAfterCommentary(text, visibleOutput)) {
                return;
              }
            }

            const emittedText = emittedTextByMessageId.get(itemId) ?? "";
            if (text.length > 0 && emittedText.length === 0) {
              await emitAgentMessageText(itemId, phase, text);
              return;
            }

            if (text.length > emittedText.length && text.startsWith(emittedText)) {
              await emitAgentMessageText(itemId, phase, text.slice(emittedText.length));
            }
            return;
          }

          if (normalizedItemType === "plan") {
            const text = asString(item.text) ?? planTextByItemId.get(itemId) ?? "";
            if (text.trim().length > 0) {
              planTextByItemId.set(itemId, text);
              latestPlanText = text;
            }
            return;
          }

          const toolContext = getToolContext(item, ownerToolUseId);
          if (!toolContext) {
            return;
          }
          const resolvedToolContext = cachedToolContext ?? toolContext;

          const startedAt = toolStartedAt.get(itemId) ?? Date.now();
          const elapsedTimeSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
          await onToolOutput({
            toolName: resolvedToolContext.toolName,
            toolUseId: itemId,
            parentToolUseId: resolvedToolContext.ownership?.parentToolUseId ?? null,
            subagentOwnerToolUseId: resolvedToolContext.ownership?.subagentOwnerToolUseId ?? null,
            launcherToolUseId: resolvedToolContext.ownership?.launcherToolUseId ?? null,
            ownershipReason: resolvedToolContext.ownership?.ownershipReason,
            elapsedTimeSeconds,
          });

          const summary = itemType === "fileChange"
            ? buildSummaryFromFileChange(item, resolvedToolContext.toolName)
            : buildSummaryFromCommandExecution(item, resolvedToolContext.toolName);
          const outputText = asString(item.aggregatedOutput) ?? undefined;
          const exitCode = asNumber(item.exitCode);
          const error = exitCode != null && exitCode !== 0 ? outputText ?? `Exit code ${exitCode}` : undefined;

          await onToolFinished({
            toolName: resolvedToolContext.toolName,
            summary,
            precedingToolUseIds: [itemId],
            subagentOwnerToolUseId: resolvedToolContext.ownership?.subagentOwnerToolUseId ?? null,
            launcherToolUseId: resolvedToolContext.ownership?.launcherToolUseId ?? null,
            ownershipReason: resolvedToolContext.ownership?.ownershipReason,
            command: resolvedToolContext.command,
            searchParams: resolvedToolContext.searchParams,
            editTarget: resolvedToolContext.editTarget,
            toolInput: resolvedToolContext.toolInput,
            output: outputText,
            error,
            shell: resolvedToolContext.shell,
            isBash: resolvedToolContext.isBash,
          });
          toolContextById.delete(itemId);

          if (itemType === "collabAgentToolCall") {
            const description = subagentDescriptionByToolUseId.get(itemId) ?? "Delegated task";
            const receiverThreadIds = asArray(item.receiverThreadIds)
              .map(asString)
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
            await onSubagentStopped({
              agentId: receiverThreadIds[0] ?? itemId,
              agentType: asString(item.agentType) ?? "worker",
              toolUseId: itemId,
              description,
              lastMessage: asString(item.resultMessage) ?? "",
            });
          }
          return;
        }

        if (parsed.method === "turn/completed") {
          const turn = asObject(params?.turn);
          const status = asString(turn?.status) ?? "completed";
          if (status === "failed") {
            rejectWith(new Error(asString(asObject(turn?.error)?.message) ?? "Codex turn failed"));
            return;
          }
          latestPlanText = latestPlanText ?? findPlanTextInTurn(turn);
          resolveComplete();
        }
      } catch (error) {
        rejectWith(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  const abortListener = () => {
    finish(createAbortError());
  };

  abortController?.signal.addEventListener("abort", abortListener, { once: true });

  try {
    await sendRequest("initialize", {
      clientInfo: {
        name: "codesymphony-runtime",
        title: "CodeSymphony Runtime",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    writeMessage(CODEX_APP_SERVER_INITIALIZED_MESSAGE);

    try {
      await sendRequest("skills/list", {
        cwds: [cwd],
        forceReload: true,
      });
    } catch {
      // Skill refresh is best-effort. Turns can still proceed when the runtime
      // cannot enumerate skills up front.
    }

    const threadParams = {
      model: resolvedModel,
      approvalPolicy,
      sandbox,
      experimentalRawEvents: false,
      cwd,
    };

    let threadResponse: Record<string, unknown> | undefined;
    if (sessionId) {
      try {
        threadResponse = asObject(await sendRequest("thread/resume", {
          ...threadParams,
          threadId: sessionId,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const canFallback =
          message.includes("not found")
          || message.includes("missing thread")
          || message.includes("unknown thread")
          || message.includes("does not exist");
        if (!canFallback) {
          throw error;
        }
      }
    }

    if (!threadResponse) {
      threadResponse = asObject(await sendRequest("thread/start", threadParams));
    }

    const openedThreadId = asString(asObject(threadResponse?.thread)?.id) ?? asString(threadResponse?.threadId);
    if (!openedThreadId) {
      throw new Error("Codex thread open response did not include a thread id.");
    }
    providerThreadId = openedThreadId;
    await onSessionId?.(openedThreadId);

    await sendRequest("turn/start", {
      threadId: openedThreadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
      model: resolvedModel,
      collaborationMode: buildCollaborationMode(resolvedModel, permissionMode),
    });

    await completionPromise;

    const normalizedOutput = finalOutput.trim().length > 0 ? finalOutput : fallbackAgentOutput;
    const planCandidateOutput = fallbackAgentOutput.trim().length > 0 ? fallbackAgentOutput : normalizedOutput;
    const detectedPlanContent = permissionMode === "plan"
      ? resolveExplicitCodexPlanContent({
        planText: latestPlanText,
        structuredPlan: latestStructuredPlan,
        agentOutput: planCandidateOutput,
      })
      : null;

    if (permissionMode === "plan" && detectedPlanContent) {
      await onPlanFileDetected({
        filePath: PLAN_FILE_PATH,
        content: detectedPlanContent,
        source: "codex_plan_item",
      });
    }

    const persistedOutput = normalizedOutput.trim().length > 0
      ? normalizedOutput
      : detectedPlanContent ?? normalizedOutput;

    return {
      output: persistedOutput,
      sessionId: providerThreadId,
      slashCommands: [],
    };
  } catch (error) {
    if (abortController?.signal.aborted && !(error instanceof Error && error.name === "AbortError")) {
      throw createAbortError();
    }
    if (completionError) {
      throw completionError;
    }
    throw error;
  } finally {
    abortController?.signal.removeEventListener("abort", abortListener);
    finish(completionError ?? undefined);
  }
};
