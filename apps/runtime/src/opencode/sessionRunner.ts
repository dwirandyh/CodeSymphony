import {
  createOpencodeClient,
  type Config as OpencodeConfig,
  type Event as OpencodeEvent,
  type FilePartInput,
  type Part as OpencodePart,
  type Permission as OpencodePermission,
  type ToolPart as OpencodeToolPart,
} from "@opencode-ai/sdk";
import { DEFAULT_CHAT_MODEL_BY_AGENT, type AgentTodoItem, type PermissionDecision } from "@codesymphony/shared-types";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import type { ChatAgentRunner } from "../types.js";
import {
  commandFromUnknownToolInput,
  editTargetFromUnknownToolInput,
  isBashTool,
  resolveToolPresentationContext,
  searchParamsFromUnknownToolInput,
  skillNameFromUnknownToolInput,
} from "../claude/toolClassification.js";
import { resolveHeuristicPlanContent } from "../codex/plan.js";
import { runOpencodePlanModeViaAcp } from "./acpRunner.js";
import { ensureConfiguredOpencodeBinaryOnPath, resolveOpencodeBinaryPath } from "./binary.js";
import { buildAttachmentDataUrl, buildAttachmentFileUrl, isImageAttachment } from "../agentAttachments.js";

const OPENCODE_CUSTOM_PROVIDER_ID = "codesymphony_custom";
const OPENCODE_SERVER_HOST = "127.0.0.1";
const OPENCODE_SERVER_START_TIMEOUT_MS = 20_000;
const OPENCODE_INITIAL_ACTIVITY_TIMEOUT_MS = 30_000;
const OPENCODE_PROGRESS_STALL_TIMEOUT_MS = 45_000;
const OPENCODE_PLAN_FILE_PATH = ".opencode/plans/opencode-plan.md";

type OpencodeServerProcess = ChildProcessByStdio<null, Readable, Readable>;

type ToolLifecycleEntry = {
  status: "pending" | "running" | "completed" | "error" | null;
  startedAtMs: number | null;
  lastElapsedTimeSeconds: number;
  startedEmitted: boolean;
  finishedEmitted: boolean;
};

type OpencodeSubtaskPart = Extract<OpencodePart, { type: "subtask" }>;
type OpencodeV2PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: {
    messageID: string;
    callID: string;
  };
};
type OpencodePermissionRequest = OpencodePermission | OpencodeV2PermissionRequest;
type OpencodeRuntimeEvent =
  | OpencodeEvent
  | {
    type: "message.part.delta";
    properties: {
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    };
  }
  | {
    type: "permission.asked";
    properties: OpencodeV2PermissionRequest;
  }
  | {
    type: "permission.replied";
    properties: {
      sessionID: string;
      requestID: string;
      reply: "once" | "always" | "reject";
    };
  }
  | {
    type: "session.created" | "session.updated" | "session.deleted";
    properties: {
      sessionID: string;
      info?: unknown;
    };
  }
  | {
    type: "server.heartbeat";
    properties: Record<string, never>;
  };
type OpencodeMessagePartUpdatedEvent = Extract<OpencodeRuntimeEvent, { type: "message.part.updated" }>;
type OpencodeMessagePartDeltaEvent = Extract<OpencodeRuntimeEvent, { type: "message.part.delta" }>;

type ActiveSubtaskEntry = {
  agentType: string;
  description: string;
  stopped: boolean;
};

type OpencodeTodoStatus = AgentTodoItem["status"];
type OpencodeTodoEntry = {
  content: string;
  status: OpencodeTodoStatus;
};

ensureConfiguredOpencodeBinaryOnPath();

function normalizeOpencodeTodoStatus(status: string): OpencodeTodoStatus | null {
  return status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled"
    ? status
    : null;
}

function normalizeOpencodeTodoEntries(entries: Array<{ content: string; status: string }>): OpencodeTodoEntry[] {
  return entries
    .map((entry) => ({
      content: entry.content.trim(),
      status: normalizeOpencodeTodoStatus(entry.status),
    }))
    .filter((entry): entry is OpencodeTodoEntry => entry.content.length > 0 && entry.status !== null);
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

function withOpencodeSetupHint(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (!/opencode|ENOENT|Timeout waiting for server to start/i.test(error.message)) {
    return error;
  }

  const message = [
    error.message,
    "",
    "OpenCode CLI could not be started for the runtime user.",
    "Verify `opencode --version` works in the same shell/user that runs the runtime.",
    "If the binary is installed outside the default PATH, set `OPENCODE_BINARY_PATH`.",
  ].join("\n");
  return new Error(message);
}

function stopOpencodeServerProcess(child: OpencodeServerProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return;
    }
  }

  child.kill();
}

function bindOpencodeServerAbort(
  child: OpencodeServerProcess,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): () => void {
  if (!signal) {
    return () => {};
  }

  const abort = () => {
    clear();
    stopOpencodeServerProcess(child);
    onAbort?.();
  };

  const clear = () => {
    signal.removeEventListener("abort", abort);
    child.off("exit", clear);
    child.off("error", clear);
  };

  signal.addEventListener("abort", abort, { once: true });
  child.on("exit", clear);
  child.on("error", clear);

  if (signal.aborted) {
    abort();
  }

  return clear;
}

async function createTrackedOpencodeServer(options: {
  hostname: string;
  port: number;
  timeout: number;
  config: OpencodeConfig;
  signal?: AbortSignal;
}): Promise<{
  url: string;
  pid: number | null;
  close: () => void;
}> {
  const child = spawn(resolveOpencodeBinaryPath(), [
    "serve",
    `--hostname=${options.hostname}`,
    `--port=${options.port}`,
    ...(options.config.logLevel ? [`--log-level=${options.config.logLevel}`] : []),
  ], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let clearAbortBinding = () => {};
  const url = await new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      clearAbortBinding();
      stopOpencodeServerProcess(child);
      reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
    }, options.timeout);

    let output = "";
    let resolved = false;

    const rejectWithOutput = (message: string) => {
      clearTimeout(timeoutId);
      const suffix = output.trim().length > 0 ? `\nServer output: ${output}` : "";
      reject(new Error(`${message}${suffix}`));
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (resolved) {
        return;
      }

      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }

        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) {
          clearAbortBinding();
          stopOpencodeServerProcess(child);
          clearTimeout(timeoutId);
          rejectWithOutput(`Failed to parse server url from output: ${line}`);
          return;
        }

        resolved = true;
        clearTimeout(timeoutId);
        resolve(match[1]);
        return;
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });

    child.once("exit", (code) => {
      if (resolved) {
        return;
      }

      clearTimeout(timeoutId);
      rejectWithOutput(`Server exited with code ${code ?? "null"}`);
    });

    child.once("error", (error) => {
      if (resolved) {
        return;
      }

      clearTimeout(timeoutId);
      reject(error);
    });

    clearAbortBinding = bindOpencodeServerAbort(child, options.signal, () => {
      clearTimeout(timeoutId);
      reject(options.signal?.reason);
    });
  });

  return {
    url,
    pid: typeof child.pid === "number" && child.pid > 0 ? child.pid : null,
    close() {
      clearAbortBinding();
      stopOpencodeServerProcess(child);
    },
  };
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, OPENCODE_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve an OpenCode server port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isLegacyPermissionRequest(permission: OpencodePermissionRequest): permission is OpencodePermission {
  return "type" in permission;
}

function parseBuiltInOpencodeModel(model: string): { providerID: string; modelID: string } {
  const trimmedModel = model.trim();
  const slashIndex = trimmedModel.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmedModel.length - 1) {
    throw new Error(
      `Invalid OpenCode model "${model}". Built-in OpenCode models must use the "provider/model" format, for example "openai/gpt-5".`,
    );
  }

  return {
    providerID: trimmedModel.slice(0, slashIndex),
    modelID: trimmedModel.slice(slashIndex + 1),
  };
}

function buildOpencodePermissionConfig(threadPermissionMode: "default" | "full_access" | undefined): NonNullable<OpencodeConfig["permission"]> {
  if (threadPermissionMode === "full_access") {
    return {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    };
  }

  return {
    edit: "ask",
    bash: "ask",
    webfetch: "ask",
    doom_loop: "ask",
    external_directory: "ask",
  };
}

function buildOpencodeRuntimeConfig(params: {
  permissionMode: "default" | "plan" | undefined;
  threadPermissionMode: "default" | "full_access" | undefined;
  model: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
}): {
  config: OpencodeConfig;
  model: {
    providerID: string;
    modelID: string;
  };
  agent: string;
} {
  const normalizedModel = params.model.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.opencode;
  const trimmedBaseUrl = params.providerBaseUrl?.trim();
  const trimmedApiKey = params.providerApiKey?.trim();
  const agent = params.permissionMode === "plan" ? "plan" : "build";
  const permission = buildOpencodePermissionConfig(params.threadPermissionMode);
  const config: OpencodeConfig = {
    logLevel: "ERROR",
    permission,
    agent: {
      build: {
        permission,
      },
      plan: {
        permission,
      },
    },
  };

  if (trimmedBaseUrl) {
    config.provider = {
      [OPENCODE_CUSTOM_PROVIDER_ID]: {
        name: "CodeSymphony Custom",
        npm: "@ai-sdk/openai",
        options: {
          baseURL: trimmedBaseUrl,
          ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
        },
        models: {
          [normalizedModel]: {
            name: normalizedModel,
          },
        },
      },
    };

    return {
      config,
      model: {
        providerID: OPENCODE_CUSTOM_PROVIDER_ID,
        modelID: normalizedModel,
      },
      agent,
    };
  }

  return {
    config,
    model: parseBuiltInOpencodeModel(normalizedModel),
    agent,
  };
}

function getEventSessionId(event: OpencodeRuntimeEvent): string | null {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.part.delta":
      return event.properties.sessionID;
    case "message.removed":
      return event.properties.sessionID;
    case "message.part.removed":
      return event.properties.sessionID;
    case "permission.asked":
      return event.properties.sessionID;
    case "permission.updated":
      return event.properties.sessionID;
    case "permission.replied":
      return event.properties.sessionID;
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const sessionID = toRecord(event.properties).sessionID;
      return typeof sessionID === "string" ? sessionID : null;
    }
    case "session.status":
    case "session.idle":
    case "session.compacted":
    case "session.diff":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    case "todo.updated":
    case "command.executed":
      return event.properties.sessionID;
    default:
      return null;
  }
}

function derivePermissionBlockedPath(permission: OpencodePermissionRequest): string | null {
  if (!isLegacyPermissionRequest(permission)) {
    const firstPattern = permission.patterns.find((entry) => typeof entry === "string" && entry.trim().length > 0);
    if (firstPattern) {
      return firstPattern.trim();
    }
    return null;
  }

  if (typeof permission.pattern === "string" && permission.pattern.trim().length > 0) {
    return permission.pattern.trim();
  }

  if (Array.isArray(permission.pattern)) {
    const firstPattern = permission.pattern.find((entry) => typeof entry === "string" && entry.trim().length > 0);
    if (firstPattern) {
      return firstPattern.trim();
    }
  }

  const metadata = toRecord(permission.metadata);
  const candidateKeys = ["path", "file_path", "file", "directory", "cwd", "target"];
  for (const key of candidateKeys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function normalizePermissionRequest(permission: OpencodePermissionRequest): {
  requestId: string;
  callId: string | null;
  toolNameFallback: string;
  toolInput: Record<string, unknown>;
  blockedPath: string | null;
} {
  if (isLegacyPermissionRequest(permission)) {
    const blockedPath = derivePermissionBlockedPath(permission);
    const toolInput = toRecord(permission.metadata);
    if (Object.keys(toolInput).length === 0 && blockedPath) {
      const normalizedToolName = (permission.type ?? permission.title).trim().toLowerCase();
      if (normalizedToolName === "bash" || normalizedToolName === "shell") {
        toolInput.command = blockedPath;
      } else if (/^(edit|multiedit|write)$/.test(normalizedToolName)) {
        toolInput.file_path = blockedPath;
      }
    }

    return {
      requestId: permission.id,
      callId: typeof permission.callID === "string" ? permission.callID : null,
      toolNameFallback: permission.type ?? permission.title,
      toolInput,
      blockedPath,
    };
  }

  const blockedPath = derivePermissionBlockedPath(permission);
  const toolInput = toRecord(permission.metadata);
  if (Object.keys(toolInput).length === 0 && blockedPath) {
    const normalizedToolName = permission.permission.trim().toLowerCase();
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      toolInput.command = blockedPath;
    } else if (/^(edit|multiedit|write)$/.test(normalizedToolName)) {
      toolInput.file_path = blockedPath;
    }
  }

  return {
    requestId: permission.id,
    callId: typeof permission.tool?.callID === "string" ? permission.tool.callID : null,
    toolNameFallback: permission.permission,
    toolInput,
    blockedPath,
  };
}

function mapPermissionDecision(decision: PermissionDecision): "once" | "always" | "reject" {
  if (decision === "allow_always") {
    return "always";
  }
  return decision === "allow" ? "once" : "reject";
}

function buildToolMetadata(part: OpencodeToolPart): {
  toolName: string;
  toolKind?: "mcp" | "web_search";
  toolInput: Record<string, unknown>;
  command?: string;
  searchParams?: string;
  editTarget?: string;
  skillName?: string;
  isBash: boolean;
} {
  const presentation = resolveToolPresentationContext({
    toolName: part.tool.trim(),
    title: ("title" in part.state && typeof part.state.title === "string") ? part.state.title : part.tool,
    kind: null,
    input: part.state.input,
  });
  const toolName = presentation.toolName;
  const toolInput = toRecord(part.state.input);
  const command = commandFromUnknownToolInput(toolInput);
  const editTarget = editTargetFromUnknownToolInput(toolName, toolInput);
  const searchParams = presentation.searchParams ?? searchParamsFromUnknownToolInput(toolName, toolInput);
  const skillName = skillNameFromUnknownToolInput(toolName, toolInput);
  const isBash = isBashTool(toolName) || toolName.trim().toLowerCase() === "shell";

  return {
    toolName,
    ...(presentation.toolKind ? { toolKind: presentation.toolKind } : {}),
    toolInput,
    ...(command ? { command } : {}),
    ...(searchParams ? { searchParams } : {}),
    ...(editTarget ? { editTarget } : {}),
    ...(skillName ? { skillName } : {}),
    isBash,
  };
}

function summarizeStalledOpencodeSession(params: {
  sawAssistantActivity: boolean;
}): string {
  if (params.sawAssistantActivity) {
    return "OpenCode session stalled before completion. The upstream provider stopped sending progress updates.";
  }

  return "OpenCode session stalled before producing any output. The upstream provider did not stream any events or completion signal.";
}

async function buildOpencodePromptParts(params: {
  prompt: string;
  promptWithAttachments?: string;
  attachments?: Parameters<ChatAgentRunner>[0]["attachments"];
}): Promise<Array<{ type: "text"; text: string } | FilePartInput>> {
  const parts: Array<{ type: "text"; text: string } | FilePartInput> = [];

  for (const attachment of params.attachments ?? []) {
    if (!isImageAttachment(attachment)) {
      continue;
    }

    const url = buildAttachmentFileUrl(attachment) ?? await buildAttachmentDataUrl(attachment);
    if (!url) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.filename,
      url,
    });
  }

  const textPrompt = params.prompt;
  const fallbackTextPrompt = params.promptWithAttachments ?? textPrompt;

  if (textPrompt.trim().length > 0 || parts.length === 0) {
    parts.push({
      type: "text",
      text: parts.length > 0 ? textPrompt : fallbackTextPrompt,
    });
  }

  return parts;
}

export const runOpencodeWithStreaming: ChatAgentRunner = async ({
  prompt,
  promptWithAttachments,
  attachments,
  sessionId,
  listSlashCommandsOnly,
  cwd,
  abortController,
  onSessionId,
  onProcessSpawned,
  permissionMode,
  threadPermissionMode,
  autoAcceptTools,
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
  onTodoUpdate,
  onSubagentStarted,
  onSubagentStopped,
}) => {
  if (listSlashCommandsOnly) {
    return {
      output: "",
      sessionId: null,
      slashCommands: [],
    };
  }

  const hasCustomProviderOverride = Boolean(providerApiKey?.trim() || providerBaseUrl?.trim());
  if (permissionMode === "plan" && !hasCustomProviderOverride) {
    return await runOpencodePlanModeViaAcp({
      prompt,
      sessionId,
      listSlashCommandsOnly,
      cwd,
      abortController,
      onSessionId,
      onProcessSpawned,
      permissionMode,
      threadPermissionMode,
      autoAcceptTools,
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
      onTodoUpdate,
      onSubagentStarted,
      onSubagentStopped,
    });
  }

  void onQuestionRequest;

  const { config, model: resolvedModel, agent } = buildOpencodeRuntimeConfig({
    permissionMode,
    threadPermissionMode,
    model: model?.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.opencode,
    providerApiKey,
    providerBaseUrl,
  });

  const port = await findAvailablePort();
  const server = await createTrackedOpencodeServer({
    hostname: OPENCODE_SERVER_HOST,
    port,
    timeout: OPENCODE_SERVER_START_TIMEOUT_MS,
    config,
    signal: abortController?.signal,
  }).catch((error) => {
    throw withOpencodeSetupHint(error);
  });
  if (server.pid !== null) {
    await onProcessSpawned?.(server.pid);
  }

  const streamAbortController = new AbortController();
  const externalAbortSignal = abortController?.signal;
  const combinedSignal = externalAbortSignal
    ? AbortSignal.any([externalAbortSignal, streamAbortController.signal])
    : streamAbortController.signal;
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: cwd,
  });

  let activeSessionId = sessionId?.trim() || null;
  let fullOutput = "";
  let latestErrorMessage: string | null = null;
  let sawSessionIdle = false;
  let sawAssistantActivity = false;
  let resolvedDone = false;
  let forcedFailure: Error | null = null;
  let abortSessionPromise: Promise<void> | null = null;
  let streamLoop: Promise<void> | null = null;
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLifecycleActivityAtMs = Date.now();
  let lifecycleTimerPaused = false;
  const runnerStartedAtMs = Date.now();
  const todoGroupId = `opencode:${runnerStartedAtMs}`;

  const existingMessageIds = new Set<string>();
  const assistantMessageIds = new Set<string>();
  const pendingPartsByMessageId = new Map<string, Array<OpencodeMessagePartUpdatedEvent>>();
  const pendingTextDeltasByMessageId = new Map<string, Array<OpencodeMessagePartDeltaEvent>>();
  const textByPartId = new Map<string, string>();
  const partTypeByPartId = new Map<string, OpencodePart["type"]>();
  const toolPartByCallId = new Map<string, OpencodeToolPart>();
  const toolLifecycleByCallId = new Map<string, ToolLifecycleEntry>();
  const repliedPermissionIds = new Set<string>();
  const activeSubtasksById = new Map<string, ActiveSubtaskEntry>();

  let resolveCompletion: (() => void) | null = null;
  let rejectCompletion: ((error: Error) => void) | null = null;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveCompletion = () => {
      if (resolvedDone) {
        return;
      }
      resolvedDone = true;
      resolve();
    };
    rejectCompletion = (error) => {
      if (resolvedDone) {
        return;
      }
      resolvedDone = true;
      reject(error);
    };
  });

  const rejectWithError = (error: unknown) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (rejectCompletion) {
      rejectCompletion(normalizedError);
    }
  };

  const finalizeIfIdle = () => {
    if (!sawSessionIdle) {
      return;
    }
    resolveCompletion?.();
  };

  const clearInactivityTimer = () => {
    if (inactivityTimer === null) {
      return;
    }
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  };

  const inactivityTimeoutMs = () => (
    sawAssistantActivity ? OPENCODE_PROGRESS_STALL_TIMEOUT_MS : OPENCODE_INITIAL_ACTIVITY_TIMEOUT_MS
  );

  const markLifecycleActivity = () => {
    lastLifecycleActivityAtMs = Date.now();
    if (resolvedDone || forcedFailure || lifecycleTimerPaused) {
      return;
    }
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      void handleSessionStall();
    }, inactivityTimeoutMs());
    inactivityTimer.unref?.();
  };

  const handleSessionStall = async () => {
    if (resolvedDone || forcedFailure || lifecycleTimerPaused) {
      return;
    }

    const elapsedMs = Date.now() - lastLifecycleActivityAtMs;
    const timeoutMs = inactivityTimeoutMs();
    if (elapsedMs < timeoutMs) {
      markLifecycleActivity();
      return;
    }

    forcedFailure = new Error(summarizeStalledOpencodeSession({
      sawAssistantActivity,
    }));
    latestErrorMessage = forcedFailure.message;
    streamAbortController.abort(forcedFailure);
    await stopActiveSubtasks(forcedFailure.message);
    if (activeSessionId) {
      abortSessionPromise = client.session.abort({
        path: { id: activeSessionId },
        throwOnError: true,
      })
        .then(() => undefined)
        .catch(() => {});
    }
    rejectWithError(forcedFailure);
  };

  const pauseLifecycleTimer = () => {
    lifecycleTimerPaused = true;
    clearInactivityTimer();
  };

  const resumeLifecycleTimer = () => {
    lifecycleTimerPaused = false;
    markLifecycleActivity();
  };

  const stopActiveSubtasks = async (lastMessage?: string) => {
    const normalizedLastMessage = lastMessage?.trim() || fullOutput.trim();
    for (const [agentId, entry] of activeSubtasksById) {
      if (entry.stopped) {
        continue;
      }
      entry.stopped = true;
      await onSubagentStopped({
        agentId,
        agentType: entry.agentType,
        toolUseId: agentId,
        description: entry.description,
        lastMessage: normalizedLastMessage,
      });
    }
  };

  const flushBufferedParts = async (messageID: string) => {
    const buffered = pendingPartsByMessageId.get(messageID);
    if (!buffered || buffered.length === 0) {
      return;
    }

    pendingPartsByMessageId.delete(messageID);
    for (const event of buffered) {
      await processMessagePartEvent(event);
    }
  };

  const flushBufferedTextDeltas = async (messageID: string) => {
    const buffered = pendingTextDeltasByMessageId.get(messageID);
    if (!buffered || buffered.length === 0) {
      return;
    }

    pendingTextDeltasByMessageId.delete(messageID);
    const unresolved: OpencodeMessagePartDeltaEvent[] = [];
    for (const event of buffered) {
      const partType = partTypeByPartId.get(event.properties.partID);
      if (!assistantMessageIds.has(messageID) || !partType) {
        unresolved.push(event);
        continue;
      }

      if (partType !== "text" || event.properties.field !== "text" || !event.properties.delta) {
        continue;
      }

      const previousText = textByPartId.get(event.properties.partID) ?? "";
      textByPartId.set(event.properties.partID, `${previousText}${event.properties.delta}`);
      sawAssistantActivity = true;
      fullOutput += event.properties.delta;
      await onText(event.properties.delta);
    }

    if (unresolved.length > 0) {
      pendingTextDeltasByMessageId.set(messageID, unresolved);
    }
  };

  const processTextPart = async (event: OpencodeMessagePartUpdatedEvent) => {
    const part = event.properties.part;
    if (part.type !== "text") {
      return;
    }

    const previousText = textByPartId.get(part.id) ?? "";
    const delta = typeof event.properties.delta === "string"
      ? event.properties.delta
      : part.text.startsWith(previousText)
        ? part.text.slice(previousText.length)
        : part.text;

    textByPartId.set(part.id, part.text);
    if (!delta) {
      return;
    }

    sawAssistantActivity = true;
    fullOutput += delta;
    await onText(delta);
  };

  const processToolPart = async (part: OpencodeToolPart) => {
    const metadata = buildToolMetadata(part);
    const lifecycle = toolLifecycleByCallId.get(part.callID) ?? {
      status: null,
      startedAtMs: null,
      lastElapsedTimeSeconds: 0,
      startedEmitted: false,
      finishedEmitted: false,
    };
    const nextStatus = part.state.status;
    const startedAtMs = "time" in part.state && part.state.time?.start
      ? part.state.time.start
      : lifecycle.startedAtMs ?? Date.now();
    lifecycle.startedAtMs = startedAtMs;

    if (!lifecycle.startedEmitted) {
      await onToolStarted({
        toolName: metadata.toolName,
        ...(metadata.toolKind ? { toolKind: metadata.toolKind } : {}),
        toolUseId: part.callID,
        parentToolUseId: null,
        ...(metadata.command ? { command: metadata.command } : {}),
        ...(metadata.searchParams ? { searchParams: metadata.searchParams } : {}),
        ...(metadata.editTarget ? { editTarget: metadata.editTarget } : {}),
        ...(metadata.skillName ? { skillName: metadata.skillName } : {}),
        ...(metadata.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
      });
      lifecycle.startedEmitted = true;
    }

    if (nextStatus === "running") {
      const elapsedTimeSeconds = Math.max(
        lifecycle.lastElapsedTimeSeconds,
        Math.max(0, (Date.now() - startedAtMs) / 1000),
      );
      lifecycle.lastElapsedTimeSeconds = elapsedTimeSeconds;
      await onToolOutput({
        toolName: metadata.toolName,
        ...(metadata.toolKind ? { toolKind: metadata.toolKind } : {}),
        toolUseId: part.callID,
        parentToolUseId: null,
        elapsedTimeSeconds,
      });
    }

    if ((nextStatus === "completed" || nextStatus === "error") && !lifecycle.finishedEmitted) {
      const summary = nextStatus === "completed"
        ? metadata.toolKind === "web_search"
          ? metadata.searchParams
            ? `Searched ${metadata.searchParams}`
            : "Searched the web"
          : metadata.toolKind === "mcp"
            ? `Ran ${metadata.toolName}`
            : part.state.title?.trim() || `${metadata.toolName} completed`
        : metadata.toolKind === "web_search"
          ? "Web search failed"
          : metadata.toolKind === "mcp"
            ? `Failed ${metadata.toolName}`
            : part.state.error?.trim() || `${metadata.toolName} failed`;
      await onToolFinished({
        toolName: metadata.toolName,
        ...(metadata.toolKind ? { toolKind: metadata.toolKind } : {}),
        summary,
        precedingToolUseIds: [part.callID],
        ...(metadata.command ? { command: metadata.command } : {}),
        ...(metadata.searchParams ? { searchParams: metadata.searchParams } : {}),
        ...(metadata.editTarget ? { editTarget: metadata.editTarget } : {}),
        ...(metadata.skillName ? { skillName: metadata.skillName } : {}),
        ...(Object.keys(metadata.toolInput).length > 0 ? { toolInput: metadata.toolInput } : {}),
        ...(nextStatus === "completed" ? { output: part.state.output } : {}),
        ...(nextStatus === "error" ? { error: part.state.error } : {}),
        ...(metadata.isBash ? { shell: "bash" as const, isBash: true as const } : {}),
      });
      lifecycle.finishedEmitted = true;
    }

    lifecycle.status = nextStatus;
    toolLifecycleByCallId.set(part.callID, lifecycle);
    toolPartByCallId.set(part.callID, part);
  };

  const processSubtaskPart = async (part: OpencodeSubtaskPart) => {
    const existing = activeSubtasksById.get(part.id);
    if (existing && !existing.stopped) {
      return;
    }

    const agentType = part.agent.trim() || "subtask";
    const description = part.description.trim() || part.prompt.trim() || "OpenCode subtask";
    activeSubtasksById.set(part.id, {
      agentType,
      description,
      stopped: false,
    });
    await onSubagentStarted({
      agentId: part.id,
      agentType,
      toolUseId: part.id,
      description,
    });
  };

  async function processMessagePartDeltaEvent(event: OpencodeMessagePartDeltaEvent) {
    const messageBuffered = pendingTextDeltasByMessageId.get(event.properties.messageID) ?? [];
    messageBuffered.push(event);
    pendingTextDeltasByMessageId.set(event.properties.messageID, messageBuffered);
    await flushBufferedTextDeltas(event.properties.messageID);
  }

  async function processMessagePartEvent(event: OpencodeMessagePartUpdatedEvent) {
    const part = event.properties.part;
    partTypeByPartId.set(part.id, part.type);
    if (!assistantMessageIds.has(part.messageID)) {
      const buffered = pendingPartsByMessageId.get(part.messageID) ?? [];
      buffered.push(event);
      pendingPartsByMessageId.set(part.messageID, buffered);
      return;
    }

    if (part.type === "text") {
      await processTextPart(event);
      await flushBufferedTextDeltas(part.messageID);
      return;
    }

    if (part.type === "tool") {
      sawAssistantActivity = true;
      await processToolPart(part);
      await flushBufferedTextDeltas(part.messageID);
      return;
    }

    if (part.type === "subtask") {
      sawAssistantActivity = true;
      await processSubtaskPart(part);
      await flushBufferedTextDeltas(part.messageID);
    }
  }

  async function processPermissionEvent(permission: OpencodePermissionRequest) {
    const normalizedPermission = normalizePermissionRequest(permission);
    if (!activeSessionId || repliedPermissionIds.has(normalizedPermission.requestId)) {
      return;
    }

    repliedPermissionIds.add(normalizedPermission.requestId);

    const toolPart = normalizedPermission.callId ? toolPartByCallId.get(normalizedPermission.callId) : undefined;
    const toolMetadata = toolPart ? buildToolMetadata(toolPart) : null;
    const toolName = toolMetadata?.toolName ?? normalizedPermission.toolNameFallback;
    const toolMetadataInput = toolMetadata?.toolInput ?? {};
    const toolInput = Object.keys(toolMetadataInput).length > 0
      ? {
        ...normalizedPermission.toolInput,
        ...toolMetadataInput,
      }
      : normalizedPermission.toolInput;
    pauseLifecycleTimer();
    const decision = await (async () => {
      try {
        return autoAcceptTools
          ? { decision: "allow" as const }
          : await onPermissionRequest({
            requestId: normalizedPermission.requestId,
            toolName,
            toolInput,
            blockedPath: normalizedPermission.blockedPath,
            decisionReason: null,
            suggestions: null,
            subagentOwnerToolUseId: null,
            launcherToolUseId: null,
          });
      } finally {
        resumeLifecycleTimer();
      }
    })();

    await client.postSessionIdPermissionsPermissionId({
      path: {
        id: activeSessionId,
        permissionID: normalizedPermission.requestId,
      },
      body: {
        response: mapPermissionDecision(decision.decision),
      },
      responseStyle: "data",
      throwOnError: true,
    });
  }

  const handleEvent = async (event: OpencodeRuntimeEvent) => {
    const eventSessionId = getEventSessionId(event);
    if (activeSessionId && eventSessionId && eventSessionId !== activeSessionId) {
      return;
    }
    if (
      eventSessionId
      && event.type !== "session.status"
    ) {
      markLifecycleActivity();
    }

    if (event.type === "message.updated") {
      const info = event.properties.info;
      if (!existingMessageIds.has(info.id) && info.role === "assistant") {
        assistantMessageIds.add(info.id);
        sawAssistantActivity = true;
        if (info.error?.data && "message" in info.error.data && typeof info.error.data.message === "string") {
          latestErrorMessage = info.error.data.message;
        }
        await flushBufferedParts(info.id);
        await flushBufferedTextDeltas(info.id);
      }
      return;
    }

    if (event.type === "message.part.delta") {
      await processMessagePartDeltaEvent(event);
      return;
    }

    if (event.type === "message.part.updated") {
      await processMessagePartEvent(event);
      return;
    }

    if (event.type === "permission.updated" || event.type === "permission.asked") {
      await processPermissionEvent(event.properties);
      return;
    }

    if (event.type === "todo.updated") {
      const normalizedTodos = normalizeOpencodeTodoEntries(event.properties.todos);
      if (normalizedTodos.length === 0) {
        return;
      }

      sawAssistantActivity = true;
      await onTodoUpdate?.({
        agent: "opencode",
        groupId: todoGroupId,
        explanation: null,
        items: normalizedTodos.map((todo, index) => ({
          id: `${todoGroupId}:${index}`,
          content: todo.content,
          status: todo.status,
        })),
      });
      return;
    }

    if (event.type === "session.error") {
      const errorData = event.properties.error?.data;
      if (errorData && typeof errorData === "object" && "message" in errorData && typeof errorData.message === "string") {
        latestErrorMessage = errorData.message;
      } else if (!latestErrorMessage) {
        latestErrorMessage = "OpenCode session failed.";
      }
      await stopActiveSubtasks(latestErrorMessage);
      rejectWithError(new Error(latestErrorMessage));
      return;
    }

    if (event.type === "session.idle") {
      await stopActiveSubtasks();
      sawSessionIdle = true;
      clearInactivityTimer();
      finalizeIfIdle();
    }
  };

  const abortListener = async () => {
    if (!activeSessionId) {
      streamAbortController.abort(externalAbortSignal?.reason);
      return;
    }

    abortSessionPromise = client.session.abort({
      path: { id: activeSessionId },
      throwOnError: true,
    })
      .catch(() => {})
      .then(() => {
        streamAbortController.abort(externalAbortSignal?.reason);
      });
  };

  try {
    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        throw createAbortError();
      }
      externalAbortSignal.addEventListener("abort", abortListener, { once: true });
    }

    if (activeSessionId) {
      try {
        await client.session.get({
          path: { id: activeSessionId },
          throwOnError: true,
        });
      } catch {
        activeSessionId = null;
      }
    }

    if (!activeSessionId) {
      const createdSession = await client.session.create({
        throwOnError: true,
      });
      activeSessionId = createdSession.data.id;
      await onSessionId?.(createdSession.data.id);
    }

    const currentSessionId = activeSessionId;
    if (!currentSessionId) {
      throw new Error("Failed to initialize an OpenCode session.");
    }

    const existingMessagesResponse = await client.session.messages({
      path: { id: currentSessionId },
      throwOnError: true,
    }).catch(() => null);
    const existingMessages = existingMessagesResponse?.data ?? [];
    for (const message of existingMessages) {
      existingMessageIds.add(message.info.id);
    }

    const eventResult = await client.event.subscribe({
      query: { directory: cwd },
      signal: combinedSignal,
      throwOnError: true,
    });
    markLifecycleActivity();
    streamLoop = (async () => {
      try {
        for await (const event of eventResult.stream) {
          await handleEvent(event as OpencodeEvent);
        }
      } catch (error) {
        if (!isAbortError(error)) {
          rejectWithError(error);
        }
      }
    })();

    await client.session.promptAsync({
      path: { id: currentSessionId },
      body: {
        agent,
        model: resolvedModel,
        parts: await buildOpencodePromptParts({
          prompt,
          promptWithAttachments,
          attachments,
        }),
      },
      throwOnError: true,
      signal: combinedSignal,
    });

    await completionPromise;
    streamAbortController.abort();
    if (streamLoop) {
      await streamLoop;
    }

    if (externalAbortSignal?.aborted) {
      throw createAbortError();
    }

    if (permissionMode === "plan") {
      const planContent = resolveHeuristicPlanContent({
        agentOutput: fullOutput,
      });
      if (planContent) {
        await onPlanFileDetected({
          filePath: OPENCODE_PLAN_FILE_PATH,
          content: planContent,
          source: "streaming_fallback",
        });
      }
    }

    return {
      output: fullOutput,
      sessionId: activeSessionId,
    };
  } catch (error) {
    if (forcedFailure) {
      throw forcedFailure;
    }
    if (isAbortError(error)) {
      throw createAbortError();
    }
    if (latestErrorMessage && fullOutput.trim().length === 0) {
      throw new Error(latestErrorMessage);
    }
    throw withOpencodeSetupHint(error);
  } finally {
    clearInactivityTimer();
    streamAbortController.abort();
    if (abortSessionPromise) {
      await abortSessionPromise;
    }
    if (streamLoop) {
      await streamLoop.catch(() => {});
    }
    await stopActiveSubtasks();
    if (externalAbortSignal) {
      externalAbortSignal.removeEventListener("abort", abortListener);
    }
    server.close();
  }
};

export const __testing = {
  buildOpencodePermissionConfig,
  buildOpencodeRuntimeConfig,
  derivePermissionBlockedPath,
  getEventSessionId,
  normalizePermissionRequest,
};
