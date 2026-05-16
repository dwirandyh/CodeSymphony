import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
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
import type { AgentTodoItem, PermissionDecision } from "@codesymphony/shared-types";
import { loadOpencodeAcpMcpServers } from "../acp/mcpServers.js";
import { resolveHeuristicPlanContent } from "../codex/plan.js";
import type { ChatAgentRunner, ChatAgentRunnerResult } from "../types.js";
import { isImageAttachment, readAttachmentBase64 } from "../agentAttachments.js";
import { resolveToolPresentationContext } from "../claude/toolClassification.js";
import { resolveOpencodeBinaryPath } from "./binary.js";

const OPENCODE_PLAN_FILE_PATH = ".opencode/plans/opencode-plan.md";

type OpencodeToolState = {
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

type OpencodeQuestionDefinition = {
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

type OpencodeTodoStatus = AgentTodoItem["status"];
type OpencodeTodoEntry = {
  content: string;
  status: OpencodeTodoStatus;
};

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

function normalizeToolUseId(toolCallId: string): string {
  return toolCallId.replace(/\s+/g, "");
}

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

function buildOpencodePlanMarkdown(entries: Array<{ content: string; status: string }>): string | null {
  const normalizedEntries = normalizeOpencodeTodoEntries(entries);

  if (normalizedEntries.length === 0) {
    return null;
  }

  return normalizedEntries
    .map((entry, index) => {
      const suffix = entry.status === "completed"
        ? " (completed)"
        : entry.status === "in_progress"
          ? " (in progress)"
          : entry.status === "cancelled"
            ? " (cancelled)"
          : "";
      return `${index + 1}. ${entry.content}${suffix}`;
    })
    .join("\n");
}

function isOpencodePlanFilePath(filePath: string): boolean {
  return filePath.endsWith(".md") && filePath.includes(".opencode/plans/");
}

function toQuestionText(params: {
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

function extractQuestionOptions(propertySchema: ElicitationPropertySchema): Array<{
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

function buildQuestionDefinitions(request: CreateElicitationRequest): OpencodeQuestionDefinition[] {
  if (request.mode !== "form") {
    return [];
  }

  const properties = request.requestedSchema.properties ?? {};

  return Object.entries(properties).map(([answerKey, propertySchema]) => {
    const options = extractQuestionOptions(propertySchema);
    return {
      answerKey,
      propertySchema,
      question: {
        question: toQuestionText({
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

function parseQuestionAnswer(params: {
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

async function normalizeElicitationRequest(params: {
  request: CreateElicitationRequest;
  onQuestionRequest: Parameters<ChatAgentRunner>[0]["onQuestionRequest"];
  abortSignal?: AbortSignal;
}): Promise<CreateElicitationResponse> {
  if (params.abortSignal?.aborted || params.request.mode !== "form") {
    return { action: "cancel" };
  }

  const definitions = buildQuestionDefinitions(params.request);
  if (definitions.length === 0) {
    return { action: "cancel" };
  }

  const response = await params.onQuestionRequest({
    requestId: `opencode-elicitation:${randomUUID()}`,
    questions: definitions.map((definition) => definition.question),
  });

  const content = definitions.reduce<Record<string, string | number | boolean | string[]>>((acc, definition) => {
    const parsedAnswer = parseQuestionAnswer({
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

function toolNameFromKind(kind: ToolKind | null, title: string): string {
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

function isGenericToolTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === ""
    || normalized === "tool"
    || normalized === "other"
    || normalized === "mcp"
    || normalized === "mcp: tool";
}

function mergeToolTitle(currentTitle: string, incomingTitle: string | null | undefined): string {
  const normalizedIncomingTitle = incomingTitle?.trim() ?? "";
  if (normalizedIncomingTitle.length === 0) {
    return currentTitle;
  }

  if (
    currentTitle.trim().length > 0
    && isGenericToolTitle(normalizedIncomingTitle)
    && !isGenericToolTitle(currentTitle)
  ) {
    return currentTitle;
  }

  return normalizedIncomingTitle;
}

function resolveOpencodeAcpToolPresentation(params: {
  kind: ToolKind | null;
  title: string;
  rawInput: unknown;
}): {
  toolName: string;
  toolKind?: "mcp" | "web_search";
  searchParams?: string;
} {
  return resolveToolPresentationContext({
    toolName: toolNameFromKind(params.kind, params.title),
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

function extractToolPath(state: OpencodeToolState): string | null {
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

function extractOpencodePlanFile(state: OpencodeToolState): { filePath: string; content: string } | null {
  for (let index = state.content.length - 1; index >= 0; index -= 1) {
    const item = coerceObject(state.content[index]);
    if (item?.type !== "diff") {
      continue;
    }

    const filePath = typeof item.path === "string" ? item.path.trim() : "";
    const content = typeof item.newText === "string" ? item.newText.trim() : "";
    if (!isOpencodePlanFilePath(filePath) || content.length === 0) {
      continue;
    }

    return { filePath, content };
  }

  const input = coerceObject(state.rawInput);
  const filePath = typeof input?.filePath === "string"
    ? input.filePath.trim()
    : typeof input?.path === "string"
      ? input.path.trim()
      : "";
  const content = typeof input?.newString === "string"
    ? input.newString.trim()
    : typeof input?.content === "string"
      ? input.content.trim()
      : "";
  if (!isOpencodePlanFilePath(filePath) || content.length === 0) {
    return null;
  }

  return { filePath, content };
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

function buildToolSummary(state: OpencodeToolState): string {
  const title = state.title.trim() || "Tool";
  const path = extractToolPath(state);
  const failed = state.status === "failed";
  const toolPresentation = resolveOpencodeAcpToolPresentation({
    kind: state.kind,
    title: state.title,
    rawInput: state.rawInput,
  });

  if (failed) {
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
      const command = extractCommand(state.rawInput);
      return command ? `Executed ${command}` : title;
    }
    default:
      return title;
  }
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

function spawnOpencodeProcess(cwd: string): {
  child: ChildProcessWithoutNullStreams;
  stderrChunks: string[];
} {
  const child = spawn(resolveOpencodeBinaryPath(), ["acp"], {
    cwd,
    // OpenCode 1.3.x exposes QuestionTool as a regular tool call that waits on
    // a separate HTTP reply channel. We do not implement that side channel here,
    // so keep QuestionTool disabled and rely on ACP-native elicitation instead.
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

async function terminateOpencodeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
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
    }, 1_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function createOpencodeConnection(params: {
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
  initializeResponse: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  stderrChunks: string[];
}> {
  const { child, stderrChunks } = spawnOpencodeProcess(params.cwd);
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

async function buildOpencodeAcpPromptBlocks(params: {
  prompt: string;
  promptWithAttachments?: string;
  attachments?: Parameters<ChatAgentRunner>[0]["attachments"];
  supportsImages: boolean;
}): Promise<ContentBlock[]> {
  if (!params.supportsImages || !(params.attachments?.some(isImageAttachment))) {
    return [
      {
        type: "text",
        text: params.promptWithAttachments ?? params.prompt,
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
  const textPrompt = params.prompt;
  if (textPrompt.trim().length > 0 || blocks.length === 0) {
    blocks.push({
      type: "text",
      text: textPrompt.trim().length > 0 ? textPrompt : (params.promptWithAttachments ?? params.prompt),
    });
  }
  return blocks;
}

export async function runOpencodePlanModeViaAcp(params: Parameters<ChatAgentRunner>[0]): Promise<ChatAgentRunnerResult> {
  const {
    prompt,
    promptWithAttachments,
    attachments,
    sessionId,
    cwd,
    abortController,
    onSessionId,
    onProcessSpawned,
    model,
    onText,
    onToolStarted,
    onToolOutput,
    onToolFinished,
    onQuestionRequest,
    onPermissionRequest,
    onPlanFileDetected,
    onTodoUpdate,
  } = params;
  const toolStates = new Map<string, OpencodeToolState>();
  let output = "";
  let planMarkdown: string | null = null;
  let explicitPlanFile: { filePath: string; content: string } | null = null;
  let lastPlanFilePath: string | null = null;
  let planEmitted = false;
  let planExitCompleted = false;
  let sawQuestionRequest = false;
  let currentSessionId = sessionId;
  const runnerStartedAtMs = Date.now();
  const todoGroupId = `opencode:${runnerStartedAtMs}`;

  const emitPlanIfReady = async () => {
    if (planEmitted) {
      return;
    }

    if (planExitCompleted) {
      if (explicitPlanFile) {
        await onPlanFileDetected({
          filePath: explicitPlanFile.filePath,
          content: explicitPlanFile.content,
          source: "claude_plan_file",
        });
        planEmitted = true;
        return;
      }

      if (planMarkdown) {
        await onPlanFileDetected({
          filePath: lastPlanFilePath ?? OPENCODE_PLAN_FILE_PATH,
          content: planMarkdown,
          source: lastPlanFilePath ? "claude_plan_file" : "streaming_fallback",
        });
        planEmitted = true;
        return;
      }
    }

    if (sawQuestionRequest) {
      return;
    }

    const heuristicPlan = resolveHeuristicPlanContent({
      agentOutput: output,
    });
    if (!heuristicPlan) {
      return;
    }

    await onPlanFileDetected({
      filePath: explicitPlanFile?.filePath ?? lastPlanFilePath ?? OPENCODE_PLAN_FILE_PATH,
      content: heuristicPlan,
      source: "streaming_fallback",
    });
    planEmitted = true;
  };

  const handleToolState = async (incoming: ToolCall | ToolCallUpdate): Promise<void> => {
    const toolUseId = normalizeToolUseId(incoming.toolCallId);
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
    } satisfies OpencodeToolState;

    current.title = mergeToolTitle(current.title, incoming.title);
    current.kind = incoming.kind ?? current.kind;
    current.status = incoming.status ?? current.status;
    current.rawInput = incoming.rawInput ?? current.rawInput;
    current.rawOutput = incoming.rawOutput ?? current.rawOutput;
    current.locations = incoming.locations ?? current.locations;
    current.content = incoming.content ?? current.content;
    toolStates.set(toolUseId, current);

    const detectedPlanFile = extractOpencodePlanFile(current);
    if (detectedPlanFile && current.status === "completed") {
      explicitPlanFile = detectedPlanFile;
      lastPlanFilePath = detectedPlanFile.filePath;
    } else if (!lastPlanFilePath) {
      const currentPath = extractToolPath(current);
      if (currentPath && isOpencodePlanFilePath(currentPath)) {
        lastPlanFilePath = currentPath;
      }
    }

    if (current.status === "completed" && current.title.trim().toLowerCase() === "plan_exit") {
      planExitCompleted = true;
    }

    const toolPresentation = resolveOpencodeAcpToolPresentation({
      kind: current.kind,
      title: current.title,
      rawInput: current.rawInput,
    });
    const toolName = toolPresentation.toolName;
    const editTarget = extractToolPath(current);

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
        ...(current.kind === "execute" ? { command: extractCommand(current.rawInput) ?? current.title, shell: "bash" as const, isBash: true as const } : {}),
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

    if ((current.status === "completed" || current.status === "failed") && !current.finishedEmitted) {
      current.finishedEmitted = true;

      const textOutput = extractToolTextContent(current.content);
      await onToolFinished({
        toolName,
        ...(toolPresentation.toolKind ? { toolKind: toolPresentation.toolKind } : {}),
        summary: buildToolSummary(current),
        precedingToolUseIds: [toolUseId],
        ...(editTarget ? { editTarget } : {}),
        ...(coerceObject(current.rawInput) ? { toolInput: coerceObject(current.rawInput)! } : {}),
        ...(toolPresentation.searchParams ? { searchParams: toolPresentation.searchParams } : {}),
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
    }, 1_000);
  };

  abortSignal?.addEventListener("abort", handleAbort);

  try {
    const created = await createOpencodeConnection({
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
              const normalizedEntries = normalizeOpencodeTodoEntries(update.entries);
              planMarkdown = buildOpencodePlanMarkdown(normalizedEntries);
              if (normalizedEntries.length > 0) {
                await onTodoUpdate?.({
                  agent: "opencode",
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
          const toolUseId = normalizeToolUseId(request.toolCall.toolCallId);
          const toolInput = coerceObject(request.toolCall.rawInput) ?? {};
          const toolPresentation = resolveOpencodeAcpToolPresentation({
            kind: request.toolCall.kind ?? null,
            title: request.toolCall.title ?? "Tool",
            rawInput: toolInput,
          });
          const blockedPath = request.toolCall.locations?.[0]?.path?.trim() || null;
          const syntheticRequestId = `${toolUseId || "opencode-tool"}:${randomUUID()}`;

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
          {
            sawQuestionRequest = true;
            return await normalizeElicitationRequest({
              request,
              onQuestionRequest,
              abortSignal,
            });
          },
        extMethod: async () => ({}),
      },
    });
    child = created.child;
    connection = created.connection;
    const supportsPromptImages = created.initializeResponse.agentCapabilities?.promptCapabilities?.image === true;
    const childPid = child.pid;
    if (typeof childPid === "number" && childPid > 0) {
      await onProcessSpawned?.(childPid);
    }

    const mcpServers = loadOpencodeAcpMcpServers();
    const session = sessionId
      ? await connection.loadSession({
          sessionId,
          cwd,
          mcpServers,
        })
      : await connection.newSession({
          cwd,
          mcpServers,
        });

    currentSessionId = sessionId ?? ("sessionId" in session && typeof session.sessionId === "string" ? session.sessionId : null);
    if (!currentSessionId) {
      throw new Error("OpenCode ACP did not return a session ID.");
    }

    await onSessionId?.(currentSessionId);

    const currentModeId = session.modes?.currentModeId;
    if (currentModeId !== "plan") {
      await connection.setSessionMode({
        sessionId: currentSessionId,
        modeId: "plan",
      });
    }

    const resolvedModel = model?.trim();
    const availableModelIds = new Set((session.models?.availableModels ?? []).map((entry) => entry.modelId));
    if (resolvedModel && availableModelIds.size > 0 && !availableModelIds.has(resolvedModel)) {
      throw new Error(`OpenCode model "${resolvedModel}" is not available in the current OpenCode config.`);
    }

    if (resolvedModel && (session.models?.currentModelId ?? null) !== resolvedModel) {
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
      prompt: await buildOpencodeAcpPromptBlocks({
        prompt,
        promptWithAttachments,
        attachments,
        supportsImages: supportsPromptImages,
      }),
    });

    await emitPlanIfReady();

    if (abortSignal?.aborted || result.stopReason === "cancelled") {
      throw createAbortError();
    }

    return {
      output: output.trim(),
      sessionId: currentSessionId,
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw createAbortError();
    }
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    if (child) {
      await terminateOpencodeChild(child);
    }
  }
}

export const __testing = {
  buildOpencodePlanMarkdown,
};
