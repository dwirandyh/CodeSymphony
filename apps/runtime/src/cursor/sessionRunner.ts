import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  ndJsonStream,
  type AvailableCommand,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationPropertySchema,
  type EnumOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallUpdate,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import {
  DEFAULT_CHAT_MODEL_BY_AGENT,
  type PermissionDecision,
  type SlashCommand,
} from "@codesymphony/shared-types";
import type { ChatAgentRunner, ChatAgentRunnerResult } from "../types.js";

const CURSOR_BINARY = process.env.CURSOR_AGENT_BINARY_PATH ?? "cursor-agent";
const CURSOR_CATALOG_TIMEOUT_MS = 2_500;
const CURSOR_SHUTDOWN_TIMEOUT_MS = 1_000;

type CursorAcpMode = "agent" | "ask" | "plan";

type CursorToolState = {
  toolUseId: string;
  title: string;
  kind: ToolKind | null;
  status: "pending" | "in_progress" | "completed" | "failed" | null;
  rawInput: unknown;
  rawOutput: unknown;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
  startedAtMs: number | null;
  startedEmitted: boolean;
  finishedEmitted: boolean;
};

type CursorCatalogSnapshot = {
  commands: SlashCommand[];
  models: Array<{ id: string; name: string }>;
};

type CursorQuestionDefinition = {
  answerKey: string;
  propertySchema: ElicitationPropertySchema;
  question: {
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  };
  optionsByLabel: Map<string, string>;
};

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

function withCursorSetupHint(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const message = error.message;
  if (/ENOENT|spawn cursor-agent/i.test(message)) {
    return new Error([
      message,
      "",
      "Cursor Agent CLI could not be started for the runtime user.",
      "Verify `cursor-agent --version` works in the same shell/user that runs the runtime.",
      "If the binary is installed outside PATH, set `CURSOR_AGENT_BINARY_PATH`.",
    ].join("\n"));
  }

  if (/auth_required|authentication|cursor login|logged in/i.test(message)) {
    return new Error([
      message,
      "",
      "Cursor Agent CLI is not authenticated for the runtime user.",
      "Run `cursor-agent status` to confirm login, then `cursor-agent login` if needed.",
    ].join("\n"));
  }

  return error;
}

function normalizeCursorToolCallId(toolCallId: string): string {
  return toolCallId.replace(/\s+/g, "");
}

function stripCursorModelVariant(modelId: string): string {
  return modelId.replace(/\[[^\]]*]$/, "").trim();
}

function resolveCursorRuntimeMode(params: {
  permissionMode: "default" | "plan" | undefined;
  threadPermissionMode: "default" | "full_access" | undefined;
}): CursorAcpMode {
  if (params.permissionMode === "plan") {
    return "plan";
  }

  return "agent";
}

function buildCursorPrompt(params: {
  prompt: string;
  acpMode: CursorAcpMode;
  threadPermissionMode: "default" | "full_access" | undefined;
}): string {
  const cleanPrompt = params.prompt.trim();

  if (params.acpMode === "agent" && params.threadPermissionMode === "full_access") {
    return cleanPrompt;
  }

  const instructions = params.acpMode === "plan"
    ? [
        "CodeSymphony runtime policy:",
        "- You are in plan mode.",
        "- Do not make workspace mutations.",
        "- Produce a concrete execution plan and wait for explicit approval before implementation.",
      ]
    : [
        "CodeSymphony runtime policy:",
        "- This thread uses on-request approvals.",
        "- You may inspect the workspace, answer questions, and continue with implementation when the task requires it.",
        "- Approval-gated edits and command execution should go through the runtime approval flow instead of being refused up front.",
        "- If an approval request is denied, explain the blocker briefly and continue with any safe read-only help you can still provide.",
      ];

  return `${instructions.join("\n")}\n\nUser request:\n${cleanPrompt}`;
}

function buildCursorPlanMarkdown(entries: Array<{ content: string; status: string }>): string | null {
  const normalizedEntries = entries
    .map((entry) => ({
      content: entry.content.trim(),
      status: entry.status,
    }))
    .filter((entry) => entry.content.length > 0);

  if (normalizedEntries.length === 0) {
    return null;
  }

  return normalizedEntries
    .map((entry, index) => {
      const suffix = entry.status === "completed"
        ? " (completed)"
        : entry.status === "in_progress"
          ? " (in progress)"
          : "";
      return `${index + 1}. ${entry.content}${suffix}`;
    })
    .join("\n");
}

function slugifyCursorPlanName(rawName: string): string {
  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "cursor-plan";
}

function buildCursorPlanFallbackPath(planName: string | null): string {
  const slug = slugifyCursorPlanName(planName ?? "cursor-plan");
  return `.cursor/plans/${slug}.plan.md`;
}

function isCursorPlanFilePath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) {
    return false;
  }

  return (
    filePath.includes(".cursor/plans/")
    || filePath.includes(".claude/plans/")
    || filePath.includes("codesymphony-claude-provider/plans/")
  );
}

async function readCursorPlanFile(cwd: string, filePath: string): Promise<string | null> {
  if (!isCursorPlanFilePath(filePath)) {
    return null;
  }

  const readPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);

  try {
    const content = (await readFile(readPath, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function toCursorQuestionText(params: {
  requestMessage: string;
  propertyKey: string;
  propertySchema: ElicitationPropertySchema;
}): string {
  const description = params.propertySchema.description?.trim();
  if (description) {
    return description;
  }

  const title = params.propertySchema.title?.trim();
  if (title) {
    return title;
  }

  const message = params.requestMessage.trim();
  if (message) {
    return message;
  }

  return params.propertyKey;
}

function extractCursorQuestionOptions(propertySchema: ElicitationPropertySchema): Array<{
  label: string;
  description?: string;
  value: string;
}> {
  if (propertySchema.type === "string") {
    if (Array.isArray(propertySchema.oneOf)) {
      return propertySchema.oneOf.map((option: EnumOption) => ({
        label: option.title,
        description: option.const,
        value: option.const,
      }));
    }

    if (Array.isArray(propertySchema.enum)) {
      return propertySchema.enum.map((value) => ({
        label: value,
        value,
      }));
    }

    return [];
  }

  if (propertySchema.type !== "array") {
    return [];
  }

  if ("anyOf" in propertySchema.items && Array.isArray(propertySchema.items.anyOf)) {
    return propertySchema.items.anyOf.map((option: EnumOption) => ({
      label: option.title,
      description: option.const,
      value: option.const,
    }));
  }

  if ("enum" in propertySchema.items && Array.isArray(propertySchema.items.enum)) {
    return propertySchema.items.enum.map((value) => ({
      label: value,
      value,
    }));
  }

  return [];
}

function buildCursorQuestionDefinitions(request: CreateElicitationRequest): CursorQuestionDefinition[] {
  if (request.mode !== "form") {
    return [];
  }

  const properties = request.requestedSchema.properties ?? {};

  return Object.entries(properties).map(([answerKey, propertySchema]) => {
    const options = extractCursorQuestionOptions(propertySchema);
    return {
      answerKey,
      propertySchema,
      question: {
        question: toCursorQuestionText({
          requestMessage: request.message,
          propertyKey: answerKey,
          propertySchema,
        }),
        header: propertySchema.title?.trim() || undefined,
        options: options.length > 0
          ? options.map((option) => ({
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            }))
          : undefined,
        multiSelect: propertySchema.type === "array" ? true : undefined,
      },
      optionsByLabel: new Map(options.map((option) => [option.label, option.value])),
    };
  });
}

function parseCursorQuestionAnswer(params: {
  rawAnswer: string | undefined;
  propertySchema: ElicitationPropertySchema;
  optionsByLabel: Map<string, string>;
}): string | number | boolean | string[] | undefined {
  const rawAnswer = params.rawAnswer?.trim();
  if (!rawAnswer) {
    return undefined;
  }

  if (params.propertySchema.type === "array") {
    const values = rawAnswer
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => params.optionsByLabel.get(part) ?? part);

    return values.length > 0 ? Array.from(new Set(values)) : undefined;
  }

  const normalizedOptionValue = params.optionsByLabel.get(rawAnswer) ?? rawAnswer;

  if (params.propertySchema.type === "boolean") {
    const lowered = normalizedOptionValue.toLowerCase();
    if (["true", "yes", "y", "1"].includes(lowered)) {
      return true;
    }
    if (["false", "no", "n", "0"].includes(lowered)) {
      return false;
    }
    return normalizedOptionValue;
  }

  if (params.propertySchema.type === "integer") {
    return /^-?\d+$/.test(normalizedOptionValue) ? Number.parseInt(normalizedOptionValue, 10) : normalizedOptionValue;
  }

  if (params.propertySchema.type === "number") {
    const parsed = Number(normalizedOptionValue);
    return Number.isFinite(parsed) ? parsed : normalizedOptionValue;
  }

  return normalizedOptionValue;
}

async function normalizeCursorElicitationRequest(params: {
  request: CreateElicitationRequest;
  onQuestionRequest: Parameters<ChatAgentRunner>[0]["onQuestionRequest"];
  abortSignal?: AbortSignal;
}): Promise<CreateElicitationResponse> {
  if (params.abortSignal?.aborted) {
    return { action: "cancel" };
  }

  if (params.request.mode !== "form") {
    return { action: "cancel" };
  }

  const definitions = buildCursorQuestionDefinitions(params.request);
  if (definitions.length === 0) {
    return { action: "cancel" };
  }

  const response = await params.onQuestionRequest({
    requestId: `cursor-elicitation:${randomUUID()}`,
    questions: definitions.map((definition) => definition.question),
  });

  const content = definitions.reduce<Record<string, string | number | boolean | string[]>>((acc, definition) => {
    const parsedAnswer = parseCursorQuestionAnswer({
      rawAnswer: response.answers[definition.question.question],
      propertySchema: definition.propertySchema,
      optionsByLabel: definition.optionsByLabel,
    });

    if (parsedAnswer !== undefined) {
      acc[definition.answerKey] = parsedAnswer;
    }

    return acc;
  }, {});

  return {
    action: "accept",
    content,
  };
}

function parseCursorPlanSavedPath(content: ToolCallContent[]): string | null {
  for (const item of content) {
    if (item.type !== "content" || item.content.type !== "text") {
      continue;
    }

    const match = item.content.text.match(/Plan saved to (file:\/\/\S+)/i);
    if (!match?.[1]) {
      continue;
    }

    try {
      return fileURLToPath(match[1]);
    } catch {
      return match[1];
    }
  }

  return null;
}

function toSlashCommands(commands: AvailableCommand[]): SlashCommand[] {
  const deduped = new Map<string, SlashCommand>();

  for (const command of commands) {
    const name = command.name.trim();
    if (!name) {
      continue;
    }

    deduped.set(name.toLowerCase(), {
      name,
      description: command.description?.trim() ?? "",
      argumentHint: "",
    });
  }

  return Array.from(deduped.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function toolNameFromCursorKind(kind: ToolKind | null, title: string): string {
  switch (kind) {
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "move":
      return "Move";
    case "search":
      return "Search";
    case "execute":
      return "Bash";
    case "fetch":
      return "Fetch";
    case "think":
      return "Think";
    case "switch_mode":
      return "Switch Mode";
    default:
      return title.trim() || "Tool";
  }
}

function extractToolTextContent(content: ToolCallContent[]): string {
  return content
    .flatMap((item) => {
      if (item.type !== "content" || item.content.type !== "text") {
        return [];
      }
      const text = item.content.text.trim();
      return text.length > 0 ? [text] : [];
    })
    .join("\n")
    .trim();
}

function extractToolPath(state: CursorToolState): string | null {
  const diffPath = state.content.find((item) => item.type === "diff")?.path;
  if (typeof diffPath === "string" && diffPath.trim().length > 0) {
    return diffPath.trim();
  }

  const locationPath = state.locations.find((location) => typeof location.path === "string" && location.path.trim().length > 0)?.path;
  if (typeof locationPath === "string" && locationPath.trim().length > 0) {
    return locationPath.trim();
  }

  return null;
}

function coerceObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractCommand(rawInput: unknown): string | null {
  const input = coerceObject(rawInput);
  const candidateKeys = ["command", "cmd", "shellCommand"];
  for (const key of candidateKeys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function buildToolSummary(state: CursorToolState): string {
  const title = state.title.trim() || "Tool";
  const path = extractToolPath(state);
  const failed = state.status === "failed";

  if (failed) {
    return `${title} failed`;
  }

  switch (state.kind) {
    case "read":
      return path ? `Read ${path}` : title;
    case "edit":
      return path ? `Edited ${path}` : title;
    case "delete":
      return path ? `Deleted ${path}` : title;
    case "move":
      return path ? `Moved ${path}` : title;
    case "search":
      return path ? `Searched ${path}` : title;
    case "execute": {
      const command = extractCommand(state.rawInput);
      return command ? `Executed ${command}` : title;
    }
    default:
      return title;
  }
}

function shouldRefreshPlanFromToolState(state: CursorToolState): boolean {
  const toolName = toolNameFromCursorKind(state.kind, state.title).trim().toLowerCase();
  return toolName === "edit" || toolName === "write";
}

function normalizePermissionDecision(params: {
  decision: PermissionDecision;
  request: RequestPermissionRequest;
}): RequestPermissionResponse {
  const preferredKind = params.decision === "allow_always"
    ? "allow_always"
    : params.decision === "allow"
      ? "allow_once"
      : "reject_once";
  const selected = params.request.options.find((option) => option.kind === preferredKind)
    ?? params.request.options.find((option) => option.kind.startsWith(params.decision === "deny" ? "reject" : "allow"))
    ?? params.request.options[0];

  if (!selected) {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

function spawnCursorProcess(cwd: string): {
  child: ChildProcessWithoutNullStreams;
  stderrChunks: string[];
} {
  const child = spawn(CURSOR_BINARY, ["acp"], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(chunk.toString());
  });

  return { child, stderrChunks };
}

async function terminateCursorChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore hard-kill failures during teardown.
      }
      resolve();
    }, CURSOR_SHUTDOWN_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function createCursorConnection(params: {
  cwd: string;
  client: {
    sessionUpdate: (params: { sessionId: string; update: SessionUpdate }) => Promise<void>;
    requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    unstable_createElicitation: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
    extMethod: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  stderrChunks: string[];
}> {
  const { child, stderrChunks } = spawnCursorProcess(params.cwd);
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin as Writable) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = new ClientSideConnection(() => ({
    sessionUpdate: params.client.sessionUpdate,
    requestPermission: params.client.requestPermission,
    unstable_createElicitation: params.client.unstable_createElicitation,
    extMethod: params.client.extMethod,
  }), stream);

  await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      elicitation: {
        form: {},
      },
    },
    clientInfo: {
      name: "codesymphony-runtime",
      version: "0.1.0",
    },
  });

  return {
    child,
    connection,
    stderrChunks,
  };
}

async function listCursorCatalog(cwd: string): Promise<CursorCatalogSnapshot> {
  let availableCommands: AvailableCommand[] = [];
  let resolveCommands: (() => void) | null = null;
  let commandTimer: ReturnType<typeof setTimeout> | null = null;

  const commandsReady = new Promise<void>((resolve) => {
    resolveCommands = resolve;
    commandTimer = setTimeout(resolve, CURSOR_CATALOG_TIMEOUT_MS);
  });

  const { child, connection } = await createCursorConnection({
    cwd,
    client: {
      sessionUpdate: async ({ update }) => {
        if (update.sessionUpdate === "available_commands_update") {
          availableCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
          resolveCommands?.();
        }
      },
      requestPermission: async () => ({
        outcome: {
          outcome: "cancelled",
        },
      }),
      unstable_createElicitation: async () => ({
        action: "cancel",
      }),
      extMethod: async () => ({}),
    },
  });

  try {
    const session = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    await commandsReady;

    return {
      commands: toSlashCommands(availableCommands),
      models: (session.models?.availableModels ?? []).map((model) => ({
        id: model.modelId,
        name: model.name.trim() || stripCursorModelVariant(model.modelId),
      })),
    };
  } catch (error) {
    throw withCursorSetupHint(error);
  } finally {
    if (commandTimer) {
      clearTimeout(commandTimer);
    }
    await terminateCursorChild(child);
  }
}

export async function listCursorSlashCommands(params: {
  cwd: string;
}): Promise<SlashCommand[]> {
  const catalog = await listCursorCatalog(params.cwd);
  return catalog.commands;
}

export async function listCursorModels(params: {
  cwd: string;
}): Promise<Array<{ id: string; name: string }>> {
  const catalog = await listCursorCatalog(params.cwd);
  return catalog.models;
}

export const runCursorWithStreaming: ChatAgentRunner = async ({
  prompt,
  sessionId,
  cwd,
  abortController,
  onSessionId,
  permissionMode,
  threadPermissionMode,
  model,
  providerApiKey,
  providerBaseUrl,
  onProcessSpawned,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
}) => {
  if (providerApiKey?.trim() || providerBaseUrl?.trim()) {
    throw new Error("Cursor uses the authenticated Cursor account over ACP and does not support custom provider base URLs or API keys.");
  }

  const acpMode = resolveCursorRuntimeMode({
    permissionMode,
    threadPermissionMode,
  });
  const resolvedModel = model?.trim() || DEFAULT_CHAT_MODEL_BY_AGENT.cursor;
  const toolStates = new Map<string, CursorToolState>();
  let output = "";
  let planMarkdown: string | null = null;
  let planFilePath: string | null = null;
  let planFallbackPath: string | null = null;
  let planEmitted = false;
  let currentSessionId = sessionId;

  const emitPlanIfReady = async () => {
    if (planEmitted || !planMarkdown) {
      return;
    }

    await onPlanFileDetected({
      filePath: planFilePath ?? planFallbackPath ?? buildCursorPlanFallbackPath(null),
      content: planMarkdown,
    });
    planEmitted = true;
  };

  const handleToolState = async (incoming: ToolCall | ToolCallUpdate): Promise<void> => {
    const toolUseId = normalizeCursorToolCallId(incoming.toolCallId);
    const current = toolStates.get(toolUseId) ?? {
      toolUseId,
      title: "",
      kind: null,
      status: null,
      rawInput: {},
      rawOutput: null,
      locations: [],
      content: [],
      startedAtMs: null,
      startedEmitted: false,
      finishedEmitted: false,
    } satisfies CursorToolState;

    current.title = incoming.title ?? current.title;
    current.kind = incoming.kind ?? current.kind;
    current.status = incoming.status ?? current.status;
    current.rawInput = incoming.rawInput ?? current.rawInput;
    current.rawOutput = incoming.rawOutput ?? current.rawOutput;
    current.locations = incoming.locations ?? current.locations;
    current.content = incoming.content ?? current.content;
    toolStates.set(toolUseId, current);

    const toolName = toolNameFromCursorKind(current.kind, current.title);
    const editTarget = extractToolPath(current);

    if (!current.startedEmitted) {
      current.startedEmitted = true;
      current.startedAtMs = Date.now();
      await onToolStarted({
        toolName,
        toolUseId,
        parentToolUseId: null,
        ...(editTarget ? { editTarget } : {}),
        ...(current.kind === "execute" ? { command: extractCommand(current.rawInput) ?? current.title, shell: "bash" as const, isBash: true as const } : {}),
      });
    }

    if (current.status === "in_progress") {
      await onToolOutput({
        toolName,
        toolUseId,
        parentToolUseId: null,
        elapsedTimeSeconds: Math.max(0, ((Date.now() - (current.startedAtMs ?? Date.now())) / 1000)),
      });
    }

    const savedPlanPath = parseCursorPlanSavedPath(current.content);
    if (savedPlanPath) {
      planFilePath = savedPlanPath;
    }

    const refreshedPlanPath = savedPlanPath
      ?? (shouldRefreshPlanFromToolState(current) ? editTarget : null);

    if (current.status === "completed" && refreshedPlanPath) {
      const refreshedPlanMarkdown = await readCursorPlanFile(cwd, refreshedPlanPath);
      if (refreshedPlanMarkdown) {
        planFilePath = refreshedPlanPath;
        planMarkdown = refreshedPlanMarkdown;
      }
    }

    if ((current.status === "completed" || current.status === "failed") && !current.finishedEmitted) {
      current.finishedEmitted = true;
      await emitPlanIfReady();

      const textOutput = extractToolTextContent(current.content);
      await onToolFinished({
        toolName,
        summary: buildToolSummary(current),
        precedingToolUseIds: [toolUseId],
        ...(editTarget ? { editTarget } : {}),
        ...(coerceObject(current.rawInput) ? { toolInput: coerceObject(current.rawInput)! } : {}),
        ...(current.kind === "execute"
          ? {
              command: extractCommand(current.rawInput) ?? current.title,
              shell: "bash" as const,
              isBash: true as const,
            }
          : {}),
        ...(textOutput ? { output: textOutput } : {}),
        ...(current.status === "failed" ? { error: textOutput || "Tool failed" } : {}),
      });
    }
  };

  let child: ChildProcessWithoutNullStreams | null = null;
  let connection: ClientSideConnection | null = null;
  let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const abortSignal = abortController?.signal;

  const handleAbort = () => {
    if (!abortSignal?.aborted || !connection || !currentSessionId) {
      return;
    }

    void connection.cancel({ sessionId: currentSessionId }).catch(() => {});
    shutdownTimer = setTimeout(() => {
      if (child && child.exitCode === null && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore cancellation teardown failures.
        }
      }
    }, CURSOR_SHUTDOWN_TIMEOUT_MS);
  };

  abortSignal?.addEventListener("abort", handleAbort);

  try {
    const created = await createCursorConnection({
      cwd,
      client: {
        sessionUpdate: async ({ update }) => {
          switch (update.sessionUpdate) {
            case "agent_message_chunk": {
              if (update.content.type !== "text") {
                return;
              }
              output += update.content.text;
              await onText(update.content.text);
              return;
            }
            case "tool_call":
            case "tool_call_update":
              await handleToolState(update);
              return;
            case "plan": {
              planMarkdown = buildCursorPlanMarkdown(update.entries);
              return;
            }
            default:
              return;
          }
        },
        requestPermission: async (request) => {
          const toolUseId = normalizeCursorToolCallId(request.toolCall.toolCallId);
          const toolName = toolNameFromCursorKind(request.toolCall.kind ?? null, request.toolCall.title ?? "Tool");
          const toolInput = coerceObject(request.toolCall.rawInput) ?? {};
          const blockedPath = request.toolCall.locations?.[0]?.path?.trim() || null;
          const syntheticRequestId = `${toolUseId || "cursor-tool"}:${randomUUID()}`;

          const result = await onPermissionRequest({
            requestId: syntheticRequestId,
            toolName,
            toolInput,
            blockedPath,
            decisionReason: null,
            suggestions: null,
            subagentOwnerToolUseId: null,
            launcherToolUseId: null,
          });

          return normalizePermissionDecision({
            decision: result.decision,
            request,
          });
        },
        unstable_createElicitation: async (request) =>
          await normalizeCursorElicitationRequest({
            request,
            onQuestionRequest,
            abortSignal,
          }),
        extMethod: async (method, params) => {
          if (method === "cursor/create_plan") {
            const candidatePlan = typeof params.plan === "string" ? params.plan.trim() : "";
            if (candidatePlan.length > 0) {
              planMarkdown = candidatePlan;
            }

            const candidateName = typeof params.name === "string" ? params.name.trim() : "";
            planFallbackPath = buildCursorPlanFallbackPath(candidateName || null);
            return {};
          }

          return {};
        },
      },
    });
    child = created.child;
    connection = created.connection;
    const childPid = child.pid;
    if (typeof childPid === "number" && childPid > 0) {
      await onProcessSpawned?.(childPid);
    }

    const session = sessionId
      ? await connection.loadSession({
          sessionId,
          cwd,
          mcpServers: [],
        })
      : await connection.newSession({
          cwd,
          mcpServers: [],
        });

    currentSessionId = sessionId ?? ("sessionId" in session && typeof session.sessionId === "string" ? session.sessionId : null);
    if (!currentSessionId) {
      throw new Error("Cursor ACP did not return a session ID.");
    }

    await onSessionId?.(currentSessionId);

    const currentModeId = session.modes?.currentModeId;
    if (currentModeId !== acpMode) {
      await connection.setSessionMode({
        sessionId: currentSessionId,
        modeId: acpMode,
      });
    }

    const availableModelIds = new Set((session.models?.availableModels ?? []).map((entry) => entry.modelId));
    if (availableModelIds.size > 0 && !availableModelIds.has(resolvedModel)) {
      throw new Error(`Cursor model "${resolvedModel}" is not available in the current Cursor account.`);
    }

    if ((session.models?.currentModelId ?? null) !== resolvedModel) {
      await connection.unstable_setSessionModel({
        sessionId: currentSessionId,
        modelId: resolvedModel,
      });
    }

    if (abortSignal?.aborted) {
      throw createAbortError();
    }

    const result = await connection.prompt({
      sessionId: currentSessionId,
      prompt: [
        {
          type: "text",
          text: buildCursorPrompt({
            prompt,
            acpMode,
            threadPermissionMode,
          }),
        },
      ],
    });

    await emitPlanIfReady();

    if (abortSignal?.aborted || result.stopReason === "cancelled") {
      throw createAbortError();
    }

    return {
      output: output.trim(),
      sessionId: currentSessionId,
    } satisfies ChatAgentRunnerResult;
  } catch (error) {
    if (isAbortError(error)) {
      throw createAbortError();
    }
    throw withCursorSetupHint(error);
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    if (child) {
      await terminateCursorChild(child);
    }
  }
};

export const __testing = {
  buildCursorPlanMarkdown,
  buildCursorPrompt,
  cursorAcpSupportsQuestionElicitation: true,
  cursorAcpSupportsSubagentLifecycle: false,
  normalizeCursorToolCallId,
  parseCursorPlanSavedPath,
  resolveCursorRuntimeMode,
  stripCursorModelVariant,
  toolNameFromCursorKind,
};
