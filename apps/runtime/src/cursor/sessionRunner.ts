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
  type ContentBlock,
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
import { isImageAttachment, readAttachmentBase64 } from "../agentAttachments.js";
import { appendRuntimeDebugLog } from "../routes/debug.js";
import { resolveToolPresentationContext } from "../claude/toolClassification.js";

const CURSOR_BINARY = process.env.CURSOR_AGENT_BINARY_PATH ?? "cursor-agent";
const CURSOR_CATALOG_TIMEOUT_MS = 2_500;
const CURSOR_SHUTDOWN_TIMEOUT_MS = 1_000;
const CURSOR_CONNECTION_IDLE_TIMEOUT_MS = 2 * 60_000;

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

type CursorClientHandlers = {
  sessionUpdate: (params: { sessionId: string; update: SessionUpdate }) => Promise<void>;
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  unstable_createElicitation: (params: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
  extMethod: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type PooledCursorConnection = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  initializeResponse: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  stderrChunks: string[];
  cwd: string;
  sessionId: string | null;
  currentModeId: string | null;
  currentModelId: string | null;
  availableModelIds: Set<string> | null;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAtMs: number;
  handlers: CursorClientHandlers;
};

const pooledCursorConnectionsBySessionId = new Map<string, PooledCursorConnection>();

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function normalizeCursorPlanEntries(entries: Array<{ content: string; status: string }>): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
}> {
  return entries
    .map((entry) => ({
      content: entry.content.trim(),
      status: entry.status,
    }))
    .filter((entry): entry is {
      content: string;
      status: "pending" | "in_progress" | "completed";
    } => (
      entry.content.length > 0
      && (entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed")
    ));
}

function buildCursorPlanMarkdown(entries: Array<{ content: string; status: string }>): string | null {
  const normalizedEntries = normalizeCursorPlanEntries(entries);

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
  if (title.trim().toLowerCase() === "terminal") {
    return "Bash";
  }

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

function resolveCursorToolPresentation(params: {
  kind: ToolKind | null;
  title: string;
  rawInput: unknown;
}): {
  toolName: string;
  toolKind?: "mcp" | "web_search";
  searchParams?: string;
} {
  return resolveToolPresentationContext({
    toolName: toolNameFromCursorKind(params.kind, params.title),
    title: params.title,
    kind: params.kind,
    input: params.rawInput,
  });
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

function isGenericTerminalTitle(title: string): boolean {
  return title.trim().toLowerCase() === "terminal";
}

function isExecuteLikeTool(params: {
  kind: ToolKind | null;
  title: string;
}): boolean {
  return params.kind === "execute" || isGenericTerminalTitle(params.title);
}

function extractTerminalRawOutput(rawOutput: unknown): {
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
} {
  const output = coerceObject(rawOutput);
  const exitCodeValue = output?.exitCode;

  return {
    stdout: nonEmptyString(output?.stdout),
    stderr: nonEmptyString(output?.stderr),
    exitCode: typeof exitCodeValue === "number" && Number.isFinite(exitCodeValue) ? exitCodeValue : null,
  };
}

function mergeTerminalOutput(stdout: string | null, stderr: string | null): string | null {
  if (!stdout && !stderr) {
    return null;
  }

  if (stdout && stderr) {
    return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
  }

  return stdout ?? stderr;
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
  const baseCommand = nonEmptyString(input?.command);
  const args = Array.isArray(input?.args) && input.args.every((value) => typeof value === "string")
    ? input.args
    : null;
  if (baseCommand) {
    return args && args.length > 0 ? [baseCommand, ...args].join(" ") : baseCommand;
  }

  const argv = Array.isArray(input?.argv) && input.argv.every((value) => typeof value === "string")
    ? input.argv
    : null;
  if (argv && argv.length > 0) {
    return argv.join(" ");
  }

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
  const isExecuteTool = isExecuteLikeTool(state);
  const { exitCode } = extractTerminalRawOutput(state.rawOutput);
  const command = extractCommand(state.rawInput);
  const toolPresentation = resolveCursorToolPresentation({
    kind: state.kind,
    title: state.title,
    rawInput: state.rawInput,
  });

  if (failed) {
    if (isExecuteTool) {
      return exitCode != null ? `Terminal exited with code ${exitCode}` : "Terminal command failed";
    }
    if (toolPresentation.toolKind === "web_search") {
      return "Web search failed";
    }
    if (toolPresentation.toolKind === "mcp") {
      return `Failed ${toolPresentation.toolName}`;
    }
    return `${title} failed`;
  }

  if (toolPresentation.toolKind === "web_search") {
    return toolPresentation.searchParams ? `Searched ${toolPresentation.searchParams}` : "Searched the web";
  }

  if (toolPresentation.toolKind === "mcp") {
    return `Ran ${toolPresentation.toolName}`;
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
      return command ? `Ran ${command}` : "Ran terminal command";
    }
    default:
      if (isExecuteTool) {
        return command ? `Ran ${command}` : "Ran terminal command";
      }
      return title;
  }
}

function extractToolOutput(state: CursorToolState): string | null {
  const textOutput = extractToolTextContent(state.content);
  if (textOutput) {
    return textOutput;
  }

  if (!isExecuteLikeTool(state)) {
    return null;
  }

  const { stdout, stderr } = extractTerminalRawOutput(state.rawOutput);
  return mergeTerminalOutput(stdout, stderr);
}

function extractToolError(state: CursorToolState, toolOutput: string | null): string | null {
  if (state.status !== "failed") {
    return null;
  }

  if (toolOutput) {
    return toolOutput;
  }

  if (isExecuteLikeTool(state)) {
    const { stderr, exitCode } = extractTerminalRawOutput(state.rawOutput);
    if (stderr) {
      return stderr;
    }
    if (exitCode != null) {
      return `Command exited with code ${exitCode}`;
    }
  }

  return "Tool failed";
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
  client: CursorClientHandlers;
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  initializeResponse: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
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

  const initializeResponse = await connection.initialize({
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
    initializeResponse,
    stderrChunks,
  };
}

function clearCursorConnectionIdleTimer(entry: PooledCursorConnection): void {
  if (!entry.idleTimer) {
    return;
  }

  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function unregisterPooledCursorConnection(entry: PooledCursorConnection): void {
  if (!entry.sessionId) {
    return;
  }

  const current = pooledCursorConnectionsBySessionId.get(entry.sessionId);
  if (current === entry) {
    pooledCursorConnectionsBySessionId.delete(entry.sessionId);
  }
}

async function destroyPooledCursorConnection(entry: PooledCursorConnection): Promise<void> {
  clearCursorConnectionIdleTimer(entry);
  unregisterPooledCursorConnection(entry);
  await terminateCursorChild(entry.child);
}

function schedulePooledCursorConnectionIdleClose(entry: PooledCursorConnection): void {
  clearCursorConnectionIdleTimer(entry);
  entry.idleTimer = setTimeout(() => {
    void destroyPooledCursorConnection(entry).catch(() => {});
  }, CURSOR_CONNECTION_IDLE_TIMEOUT_MS);
  entry.idleTimer.unref?.();
}

async function acquirePooledCursorConnection(params: {
  cwd: string;
  sessionId: string | null;
  handlers: CursorClientHandlers;
}): Promise<{
  entry: PooledCursorConnection;
  reused: boolean;
}> {
  const candidate = params.sessionId ? pooledCursorConnectionsBySessionId.get(params.sessionId) ?? null : null;
  if (
    candidate
    && !candidate.busy
    && candidate.cwd === params.cwd
    && candidate.child.exitCode === null
    && !candidate.child.killed
  ) {
    clearCursorConnectionIdleTimer(candidate);
    candidate.busy = true;
    candidate.lastUsedAtMs = Date.now();
    candidate.handlers = params.handlers;
    return {
      entry: candidate,
      reused: true,
    };
  }

  if (candidate) {
    await destroyPooledCursorConnection(candidate);
  }

  const handlerBridge: CursorClientHandlers = {
    sessionUpdate: async (payload) => params.handlers.sessionUpdate(payload),
    requestPermission: async (payload) => params.handlers.requestPermission(payload),
    unstable_createElicitation: async (payload) => params.handlers.unstable_createElicitation(payload),
    extMethod: async (method, payload) => params.handlers.extMethod(method, payload),
  };

  const created = await createCursorConnection({
    cwd: params.cwd,
    client: handlerBridge,
  });

  const entry: PooledCursorConnection = {
    ...created,
    cwd: params.cwd,
    sessionId: params.sessionId,
    currentModeId: null,
    currentModelId: null,
    availableModelIds: null,
    busy: true,
    idleTimer: null,
    lastUsedAtMs: Date.now(),
    handlers: params.handlers,
  };

  handlerBridge.sessionUpdate = async (payload) => entry.handlers.sessionUpdate(payload);
  handlerBridge.requestPermission = async (payload) => entry.handlers.requestPermission(payload);
  handlerBridge.unstable_createElicitation = async (payload) => entry.handlers.unstable_createElicitation(payload);
  handlerBridge.extMethod = async (method, payload) => entry.handlers.extMethod(method, payload);

  return {
    entry,
    reused: false,
  };
}

function rememberPooledCursorConnectionSession(entry: PooledCursorConnection, sessionId: string | null): void {
  if (!sessionId) {
    return;
  }

  if (entry.sessionId === sessionId) {
    pooledCursorConnectionsBySessionId.set(sessionId, entry);
    return;
  }

  unregisterPooledCursorConnection(entry);
  entry.sessionId = sessionId;
  pooledCursorConnectionsBySessionId.set(sessionId, entry);
}

async function releasePooledCursorConnection(params: {
  entry: PooledCursorConnection | null;
  keepAlive: boolean;
  sessionId: string | null;
}): Promise<void> {
  const entry = params.entry;
  if (!entry) {
    return;
  }

  if (!params.keepAlive || !params.sessionId || entry.child.exitCode !== null || entry.child.killed) {
    await destroyPooledCursorConnection(entry);
    return;
  }

  rememberPooledCursorConnectionSession(entry, params.sessionId);
  entry.busy = false;
  entry.lastUsedAtMs = Date.now();
  schedulePooledCursorConnectionIdleClose(entry);
}

async function buildCursorPromptBlocks(params: {
  prompt: string;
  promptWithAttachments?: string;
  attachments?: Parameters<ChatAgentRunner>[0]["attachments"];
  acpMode: CursorAcpMode;
  threadPermissionMode: "default" | "full_access" | undefined;
  supportsImages: boolean;
}): Promise<ContentBlock[]> {
  const textPrompt = buildCursorPrompt({
    prompt: params.prompt,
    acpMode: params.acpMode,
    threadPermissionMode: params.threadPermissionMode,
  });
  const fallbackTextPrompt = buildCursorPrompt({
    prompt: params.promptWithAttachments ?? params.prompt,
    acpMode: params.acpMode,
    threadPermissionMode: params.threadPermissionMode,
  });

  if (!params.supportsImages || !(params.attachments?.some(isImageAttachment))) {
    return [
      {
        type: "text",
        text: fallbackTextPrompt,
      },
    ];
  }

  const imageBlocks = await Promise.all(
    (params.attachments ?? [])
      .filter(isImageAttachment)
      .map(async (attachment) => {
        const data = await readAttachmentBase64(attachment);
        if (!data) {
          return null;
        }

        return {
          type: "image",
          data,
          mimeType: attachment.mimeType,
          uri: attachment.storagePath ?? undefined,
        } satisfies ContentBlock;
      }),
  );

  const blocks: ContentBlock[] = imageBlocks.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  blocks.push({
    type: "text",
    text: textPrompt,
  });
  return blocks;
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
  promptWithAttachments,
  attachments,
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
  onTodoUpdate,
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
  const runnerStartedAtMs = Date.now();
  const todoGroupId = `cursor:${runnerStartedAtMs}`;
  let firstSessionUpdateType: SessionUpdate["sessionUpdate"] | null = null;
  const seenNonTextChunkTypes = new Set<string>();

  const logCursorDebug = (message: string, data?: Record<string, unknown>) => {
    appendRuntimeDebugLog({
      source: "runtime.cursor",
      message,
      data: {
        sessionId: currentSessionId,
        resumedSession: sessionId != null,
        model: resolvedModel,
        elapsedMs: Date.now() - runnerStartedAtMs,
        ...(data ?? {}),
      },
    });
  };

  logCursorDebug("runner.started", {
    permissionMode: acpMode,
  });

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

    const toolPresentation = resolveCursorToolPresentation({
      kind: current.kind,
      title: current.title,
      rawInput: current.rawInput,
    });
    const toolName = toolPresentation.toolName;
    const editTarget = extractToolPath(current);

    const isExecuteTool = isExecuteLikeTool(current);
    const command = extractCommand(current.rawInput);

    if (!current.startedEmitted) {
      current.startedEmitted = true;
      current.startedAtMs = Date.now();
      await onToolStarted({
        toolName,
        ...(toolPresentation.toolKind ? { toolKind: toolPresentation.toolKind } : {}),
        toolUseId,
        parentToolUseId: null,
        ...(editTarget ? { editTarget } : {}),
        ...(toolPresentation.searchParams ? { searchParams: toolPresentation.searchParams } : {}),
        ...(isExecuteTool
          ? {
              ...(command ? { command } : {}),
              shell: "bash" as const,
              isBash: true as const,
            }
          : {}),
      });
    }

    if (current.status === "in_progress") {
      await onToolOutput({
        toolName,
        ...(toolPresentation.toolKind ? { toolKind: toolPresentation.toolKind } : {}),
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

      const toolOutput = extractToolOutput(current);
      const toolError = extractToolError(current, toolOutput);
      await onToolFinished({
        toolName,
        ...(toolPresentation.toolKind ? { toolKind: toolPresentation.toolKind } : {}),
        summary: buildToolSummary(current),
        precedingToolUseIds: [toolUseId],
        ...(editTarget ? { editTarget } : {}),
        ...(coerceObject(current.rawInput) ? { toolInput: coerceObject(current.rawInput)! } : {}),
        ...(toolPresentation.searchParams ? { searchParams: toolPresentation.searchParams } : {}),
        ...(isExecuteTool
          ? {
              ...(command ? { command } : {}),
              shell: "bash" as const,
              isBash: true as const,
            }
          : {}),
        ...(toolOutput ? { output: toolOutput } : {}),
        ...(toolError ? { error: toolError } : {}),
      });
    }
  };

  let child: ChildProcessWithoutNullStreams | null = null;
  let connection: ClientSideConnection | null = null;
  let pooledConnection: PooledCursorConnection | null = null;
  let keepConnectionAlive = false;
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
    const handlers: CursorClientHandlers = {
      sessionUpdate: async ({ update }) => {
        if (!firstSessionUpdateType) {
          firstSessionUpdateType = update.sessionUpdate;
          logCursorDebug("session.firstUpdate", {
            updateType: update.sessionUpdate,
            contentType: "content" in update && update.content && typeof update.content === "object" && "type" in update.content
              ? update.content.type
              : null,
          });
        }

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            if (update.content.type !== "text") {
              if (!seenNonTextChunkTypes.has(update.content.type)) {
                seenNonTextChunkTypes.add(update.content.type);
                logCursorDebug("session.nonTextChunk", {
                  contentType: update.content.type,
                });
              }
              return;
            }
            output += update.content.text;
            await onText(update.content.text);
            return;
          }
          case "available_commands_update":
            logCursorDebug("session.availableCommandsUpdated", {
              commandCount: Array.isArray(update.availableCommands) ? update.availableCommands.length : 0,
            });
            return;
          case "tool_call":
          case "tool_call_update":
            await handleToolState(update);
            return;
          case "plan": {
            const normalizedEntries = normalizeCursorPlanEntries(update.entries);
            planMarkdown = buildCursorPlanMarkdown(normalizedEntries);
            if (normalizedEntries.length > 0) {
              await onTodoUpdate?.({
                agent: "cursor",
                groupId: todoGroupId,
                explanation: null,
                items: normalizedEntries.map((entry, index) => ({
                  id: `${todoGroupId}:${index}`,
                  content: entry.content,
                  status: entry.status,
                })),
              });
            }
            return;
          }
          default:
            return;
        }
      },
      requestPermission: async (request) => {
        const toolUseId = normalizeCursorToolCallId(request.toolCall.toolCallId);
        const toolInput = coerceObject(request.toolCall.rawInput) ?? {};
        const toolPresentation = resolveCursorToolPresentation({
          kind: request.toolCall.kind ?? null,
          title: request.toolCall.title ?? "Tool",
          rawInput: toolInput,
        });
        const blockedPath = request.toolCall.locations?.[0]?.path?.trim() || null;
        const syntheticRequestId = `${toolUseId || "cursor-tool"}:${randomUUID()}`;

        const result = await onPermissionRequest({
          requestId: syntheticRequestId,
          toolName: toolPresentation.toolName,
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
    };

    const acquired = await acquirePooledCursorConnection({
      cwd,
      sessionId,
      handlers,
    });
    pooledConnection = acquired.entry;
    child = pooledConnection.child;
    connection = pooledConnection.connection;
    const supportsPromptImages = pooledConnection.initializeResponse.agentCapabilities?.promptCapabilities?.image === true;
    const childPid = child.pid;
    if (typeof childPid === "number" && childPid > 0) {
      await onProcessSpawned?.(childPid);
    }

    let currentModeId = pooledConnection.currentModeId;
    let currentModelId = pooledConnection.currentModelId;
    let availableModelIds = pooledConnection.availableModelIds;

    if (acquired.reused && sessionId && availableModelIds) {
      currentSessionId = sessionId;
      logCursorDebug("connection.reused", {
        currentModeId,
        currentModelId,
        availableModelCount: availableModelIds.size,
      });
      logCursorDebug("session.load.skipped", {
        reason: "pooled_connection",
      });
    } else {
      logCursorDebug("connection.created", {
        reusedSession: sessionId != null,
      });
      logCursorDebug("session.load.started", {
        hasExistingSessionId: sessionId != null,
        requestedMode: acpMode,
        requestedModel: resolvedModel,
      });
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
      logCursorDebug("session.load.completed", {
        hasExistingSessionId: sessionId != null,
        currentModeId: session.modes?.currentModeId ?? null,
        currentModelId: session.models?.currentModelId ?? null,
        availableModelCount: session.models?.availableModels?.length ?? 0,
      });

      currentSessionId = sessionId ?? ("sessionId" in session && typeof session.sessionId === "string" ? session.sessionId : null);
      currentModeId = session.modes?.currentModeId ?? null;
      currentModelId = session.models?.currentModelId ?? null;
      availableModelIds = new Set((session.models?.availableModels ?? []).map((entry) => entry.modelId));
      pooledConnection.currentModeId = currentModeId;
      pooledConnection.currentModelId = currentModelId;
      pooledConnection.availableModelIds = availableModelIds;
    }

    if (!currentSessionId) {
      throw new Error("Cursor ACP did not return a session ID.");
    }

    await onSessionId?.(currentSessionId);

    if (currentModeId !== acpMode) {
      logCursorDebug("session.mode.started", {
        currentModeId: currentModeId ?? null,
        requestedMode: acpMode,
      });
      await connection.setSessionMode({
        sessionId: currentSessionId,
        modeId: acpMode,
      });
      currentModeId = acpMode;
      pooledConnection.currentModeId = acpMode;
      logCursorDebug("session.mode.completed", {
        currentModeId: acpMode,
      });
    } else {
      logCursorDebug("session.mode.skipped", {
        currentModeId: currentModeId ?? null,
      });
    }

    if (availableModelIds && availableModelIds.size > 0 && !availableModelIds.has(resolvedModel)) {
      throw new Error(`Cursor model "${resolvedModel}" is not available in the current Cursor account.`);
    }

    if (currentModelId !== resolvedModel) {
      logCursorDebug("session.model.started", {
        currentModelId: currentModelId ?? null,
        requestedModel: resolvedModel,
      });
      await connection.unstable_setSessionModel({
        sessionId: currentSessionId,
        modelId: resolvedModel,
      });
      currentModelId = resolvedModel;
      pooledConnection.currentModelId = resolvedModel;
      logCursorDebug("session.model.completed", {
        currentModelId: resolvedModel,
      });
    } else {
      logCursorDebug("session.model.skipped", {
        currentModelId: currentModelId ?? null,
      });
    }

    if (abortSignal?.aborted) {
      throw createAbortError();
    }

    logCursorDebug("prompt.started", {
      supportsPromptImages,
    });
    const result = await connection.prompt({
      sessionId: currentSessionId,
      prompt: await buildCursorPromptBlocks({
        prompt,
        promptWithAttachments,
        attachments,
        acpMode,
        threadPermissionMode,
        supportsImages: supportsPromptImages,
      }),
    });

    await emitPlanIfReady();

    if (abortSignal?.aborted || result.stopReason === "cancelled") {
      throw createAbortError();
    }

    logCursorDebug("prompt.completed", {
      stopReason: result.stopReason,
      outputLength: output.length,
      firstSessionUpdateType,
    });
    keepConnectionAlive = true;

    return {
      output: output.trim(),
      sessionId: currentSessionId,
    } satisfies ChatAgentRunnerResult;
  } catch (error) {
    logCursorDebug("prompt.failed", {
      firstSessionUpdateType,
      error: error instanceof Error ? error.message : String(error),
    });
    if (isAbortError(error)) {
      throw createAbortError();
    }
    throw withCursorSetupHint(error);
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    await releasePooledCursorConnection({
      entry: pooledConnection,
      keepAlive: keepConnectionAlive,
      sessionId: currentSessionId,
    });
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
