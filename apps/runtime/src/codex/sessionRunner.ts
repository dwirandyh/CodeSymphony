import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import type { PermissionDecision } from "@codesymphony/shared-types";
import { DEFAULT_CHAT_MODEL_BY_AGENT } from "@codesymphony/shared-types";
import type { ChatAgentRunner, ChatAgentRunnerResult, ClaudeOwnershipReason } from "../types.js";

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

type ToolContext = {
  toolName: string;
  command?: string;
  searchParams?: string;
  editTarget?: string;
  toolInput?: Record<string, unknown>;
  isBash?: true;
  shell?: "bash";
  ownership?: {
    parentToolUseId: string | null;
    subagentOwnerToolUseId: string | null;
    launcherToolUseId: string | null;
    ownershipReason?: ClaudeOwnershipReason;
  };
};

const CODEX_BINARY = process.env.CODEX_BINARY_PATH ?? "codex";
const REQUEST_TIMEOUT_MS = 20_000;
const PLAN_FILE_PATH = ".claude/plans/codex-plan.md";
const CODEX_CUSTOM_PROVIDER_ID = "codesymphony_custom";
const CODEX_CUSTOM_PROVIDER_API_KEY_ENV = "CODESYMPHONY_CODEX_API_KEY";
const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PLAN_APPROVAL_BOILERPLATE_PATTERNS = [
  /^reply with approval if you want me to execute it\.?$/gim,
  /^reply with approval to execute(?: the plan)?\.?$/gim,
  /^approve this plan to continue\.?$/gim,
  /^let me know if you want me to proceed\.?$/gim,
];

type CodexPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

type CodexStructuredPlan = {
  explanation: string | null;
  steps: CodexPlanStep[];
};

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in phases, and you should chat your way to a great plan before finalizing it. A great plan is implementation-ready and decision-complete.

Mode rules:
- You are in Plan Mode until a developer message explicitly ends it.
- If the user asks for execution while still in Plan Mode, treat it as a request to plan the execution, not perform it.

Plan Mode constraints:
- You may explore and execute non-mutating actions that improve the plan.
- You must not perform mutating actions or change repo-tracked state.

Allowed exploration:
- Read or search files, configs, manifests, and docs.
- Run non-mutating inspection commands.
- Run tests/builds/checks when they do not edit repo-tracked files.

Not allowed:
- Editing or writing files.
- Running commands whose purpose is to implement the change instead of refining the plan.
- Applying patches, migrations, or codegen that modifies repo-tracked files.

Planning workflow:
- Ground yourself in the actual environment before finalizing the plan.
- Resolve what you can through exploration before asking follow-up questions.
- Briefly summarize what you inspected before the final plan when that helps the user follow the reasoning.

Plan requirements:
- Clarify assumptions only when needed.
- Keep the plan decision-complete.
- Include interfaces, data flow, edge cases, and tests.
- Wrap the final plan in <proposed_plan> tags.
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Execute the user's request directly when possible.

Default mode constraints:
- Prefer making progress over asking follow-up questions.
- Only request user input when the runtime explicitly asks you to.
</collaboration_mode>`;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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

function buildCodexCustomProviderHome(params: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): {
  homePath: string;
  env: NodeJS.ProcessEnv;
} {
  const normalizedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const providerHash = createHash("sha256")
    .update(normalizedBaseUrl)
    .update("\n")
    .update(params.model.trim())
    .digest("hex")
    .slice(0, 16);
  const homePath = join(tmpdir(), "codesymphony-codex-providers", providerHash);
  mkdirSync(homePath, { recursive: true });

  const configLines = [
    `model = ${escapeTomlString(params.model.trim())}`,
    `model_provider = "${CODEX_CUSTOM_PROVIDER_ID}"`,
    "",
    `[model_providers.${CODEX_CUSTOM_PROVIDER_ID}]`,
    `base_url = ${escapeTomlString(normalizedBaseUrl)}`,
    'wire_api = "responses"',
    ...(params.apiKey?.trim()
      ? [`env_key = "${CODEX_CUSTOM_PROVIDER_API_KEY_ENV}"`]
      : []),
  ];

  writeFileSync(join(homePath, "config.toml"), `${configLines.join("\n")}\n`, "utf8");

  return {
    homePath,
    env: {
      CODEX_HOME: homePath,
      ...(params.apiKey?.trim()
        ? { [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: params.apiKey.trim() }
        : {}),
    },
  };
}

function buildCodexRuntimeEnv(params: {
  model: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const normalizedBaseUrl = params.providerBaseUrl?.trim();
  const normalizedApiKey = params.providerApiKey?.trim();

  if (normalizedBaseUrl) {
    const customProvider = buildCodexCustomProviderHome({
      baseUrl: normalizedBaseUrl,
      model: params.model,
      ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    });
    return {
      ...env,
      ...customProvider.env,
    };
  }

  if (normalizedApiKey) {
    env.OPENAI_API_KEY = normalizedApiKey;
  }

  return env;
}

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function stripPlanApprovalBoilerplate(text: string): string {
  let normalized = text;
  for (const pattern of PLAN_APPROVAL_BOILERPLATE_PATTERNS) {
    normalized = normalized.replace(pattern, "");
  }
  return normalized
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizePlanCandidate(text: string | null | undefined): string | null {
  const proposedPlan = extractProposedPlanMarkdown(text ?? undefined);
  const candidate = stripPlanApprovalBoilerplate((proposedPlan ?? text ?? "").trim());
  return candidate.length > 0 ? candidate : null;
}

function hasActionablePlanContent(text: string | null | undefined): boolean {
  const candidate = normalizePlanCandidate(text);
  if (!candidate) {
    return false;
  }

  const lines = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const listLines = lines.filter((line) => /^([-*]|\d+\.)\s+/.test(line));

  if (listLines.length >= 2) {
    return true;
  }

  if (lines.some((line) => /^#{1,6}\s+\S+/.test(line)) && lines.length >= 2) {
    return true;
  }

  return candidate.length >= 120 && lines.length >= 3;
}

export function buildCodexPlanMarkdown(plan: CodexStructuredPlan | null | undefined): string | null {
  if (!plan) {
    return null;
  }

  const lines: string[] = [];
  const explanation = normalizePlanCandidate(plan.explanation);
  if (explanation) {
    lines.push(explanation);
  }

  const formattedSteps = plan.steps
    .map((entry, index) => {
      const step = entry.step.trim();
      if (!step) {
        return null;
      }
      const suffix = entry.status === "completed"
        ? " (completed)"
        : entry.status === "inProgress"
          ? " (in progress)"
          : "";
      return `${index + 1}. ${step}${suffix}`;
    })
    .filter((entry): entry is string => entry !== null);

  if (formattedSteps.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...formattedSteps);
  }

  const content = lines.join("\n").trim();
  return hasActionablePlanContent(content) ? content : null;
}

function findPlanTextInTurn(turn: Record<string, unknown> | undefined): string | null {
  const items = asArray(turn?.items)
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const itemType = asString(item?.type)?.trim().toLowerCase();
    if (itemType !== "plan") {
      continue;
    }

    const text = asString(item?.text)?.trim();
    if (text && text.length > 0) {
      return text;
    }
  }

  return null;
}

export function resolveCodexPlanContent(input: {
  planText?: string | null;
  structuredPlan?: CodexStructuredPlan | null;
  agentOutput?: string | null;
}): string | null {
  const candidates = [
    normalizePlanCandidate(input.planText),
    buildCodexPlanMarkdown(input.structuredPlan),
    normalizePlanCandidate(input.agentOutput),
  ];

  for (const candidate of candidates) {
    if (hasActionablePlanContent(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveCodexRuntimePolicy(params: {
  permissionMode: "default" | "plan" | undefined;
  threadPermissionMode: "default" | "full_access" | undefined;
}): {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "danger-full-access";
} {
  const permissionMode = params.permissionMode ?? "default";
  const threadPermissionMode = params.threadPermissionMode ?? "default";
  const approvalRequired = threadPermissionMode !== "full_access" || permissionMode === "plan";

  return {
    approvalPolicy: approvalRequired ? "on-request" : "never",
    sandbox: threadPermissionMode === "full_access" && permissionMode !== "plan"
      ? "danger-full-access"
      : "read-only",
  };
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

function toOwnership(toolUseId: string | null): NonNullable<ToolContext["ownership"]> {
  if (!toolUseId) {
    return {
      parentToolUseId: null,
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
    };
  }

  return {
    parentToolUseId: toolUseId,
    subagentOwnerToolUseId: toolUseId,
    launcherToolUseId: toolUseId,
    ownershipReason: "resolved_tool_use_id",
  };
}

function buildSearchParams(action: Record<string, unknown>, command: string | undefined): string | undefined {
  const parts: string[] = [];
  const query = asString(action.query)?.trim();
  const path = asString(action.path)?.trim();

  if (query) {
    parts.push(`pattern=${query}`);
  }
  if (path) {
    parts.push(`path=${path}`);
  }
  if (parts.length > 0) {
    return parts.join(" ");
  }

  return command?.trim() || undefined;
}

function buildSummaryFromCommandExecution(item: Record<string, unknown>, toolName: string): string {
  const command = asString(item.command)?.trim();
  const exitCode = asNumber(item.exitCode);
  const actions = asArray(item.commandActions).map(asObject).filter((entry): entry is Record<string, unknown> => entry !== undefined);

  if (toolName === "Read") {
    const paths = actions
      .map((action) => asString(action.path))
      .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
    if (paths.length === 1) {
      return `Read ${paths[0]}`;
    }
    if (paths.length > 1) {
      return `Read ${paths.length} files`;
    }
  }

  if (toolName === "Grep" || toolName === "Glob" || toolName === "Search") {
    return `Completed ${toolName}`;
  }

  if (toolName === "Bash") {
    if (command && command.length > 0) {
      return exitCode != null && exitCode !== 0 ? `Command failed: ${command}` : `Ran ${command}`;
    }
    return exitCode != null && exitCode !== 0 ? "Command failed" : "Ran command";
  }

  return `Completed ${toolName}`;
}

export function selectPrimaryCodexFileChange(item: Record<string, unknown>): { path?: string; kind?: string } {
  const changes = asArray(item.changes).map(asObject).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const rankedChanges = changes
    .map((change) => {
      const path = asString(change.path);
      const kind = asString(asObject(change.kind)?.type);
      let score = 0;

      if (kind === "add" || kind === "create") {
        score += 20;
      } else if (kind === "update") {
        score += 10;
      }

      if (path?.endsWith(".codex-permission-probe")) {
        score -= 100;
      }

      return { path, kind, score };
    })
    .sort((left, right) => right.score - left.score);

  const selected = rankedChanges[0];
  return selected ? { path: selected.path, kind: selected.kind } : {};
}

function buildSummaryFromFileChange(item: Record<string, unknown>, toolName: string): string {
  const { path: firstPath } = selectPrimaryCodexFileChange(item);

  if (toolName === "Write" && firstPath) {
    return `Created ${firstPath}`;
  }
  if (toolName === "Edit" && firstPath) {
    return `Edited ${firstPath}`;
  }
  return toolName === "Write" ? "Created files" : "Edited files";
}

function classifyCommandExecution(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext {
  const command = asString(item.command);
  const actions = asArray(item.commandActions).map(asObject).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const actionTypes = new Set(actions.map((action) => asString(action.type) ?? "unknown"));

  if (actions.length > 0 && actionTypes.size === 1 && actionTypes.has("read")) {
    const firstPath = asString(actions[0]?.path);
    return {
      toolName: "Read",
      command,
      toolInput: firstPath ? { file_path: firstPath } : undefined,
      editTarget: firstPath,
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (actions.length > 0 && actionTypes.size === 1 && actionTypes.has("search")) {
    const loweredCommand = command?.toLowerCase() ?? "";
    const toolName = loweredCommand.includes("rg ") || loweredCommand.includes("grep ") ? "Grep" : loweredCommand.includes("find ") ? "Glob" : "Search";
    return {
      toolName,
      command,
      searchParams: buildSearchParams(actions[0] ?? {}, command),
      ownership: toOwnership(ownerToolUseId),
    };
  }

  return {
    toolName: "Bash",
    command,
    toolInput: command ? { command } : undefined,
    isBash: true,
    shell: "bash",
    ownership: toOwnership(ownerToolUseId),
  };
}

function classifyFileChange(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext {
  const { path: firstPath, kind: changeKind } = selectPrimaryCodexFileChange(item);
  const toolName = changeKind === "add" || changeKind === "create" ? "Write" : "Edit";

  return {
    toolName,
    editTarget: firstPath,
    toolInput: firstPath ? { file_path: firstPath } : undefined,
    ownership: toOwnership(ownerToolUseId),
  };
}

function classifyGenericTool(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext | null {
  const type = asString(item.type);
  if (!type) {
    return null;
  }
  const normalizedType = type.trim().toLowerCase();

  if (type === "commandExecution") {
    return classifyCommandExecution(item, ownerToolUseId);
  }

  if (type === "fileChange") {
    return classifyFileChange(item, ownerToolUseId);
  }

  if (normalizedType === "fileread" || normalizedType === "file_read" || normalizedType === "read") {
    const readPath = asString(item.path) ?? asString(item.filePath) ?? asString(item.file_path);
    return {
      toolName: "Read",
      editTarget: readPath,
      toolInput: readPath ? { file_path: readPath } : undefined,
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (
    normalizedType === "search"
    || normalizedType === "grep"
    || normalizedType === "glob"
    || normalizedType === "websearch"
  ) {
    const toolName = normalizedType === "glob"
      ? "Glob"
      : normalizedType === "grep"
        ? "Grep"
        : normalizedType === "websearch"
          ? "WebSearch"
          : "Search";
    return {
      toolName,
      searchParams: asString(item.query) ?? asString(item.pattern) ?? asString(item.path) ?? asString(item.title),
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (type === "collabAgentToolCall") {
    const description = asString(item.description) ?? asString(item.prompt) ?? asString(item.title) ?? "Delegated task";
    return {
      toolName: "Task",
      command: description,
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (type === "webSearch") {
    return {
      toolName: "WebSearch",
      searchParams: asString(item.query) ?? asString(item.title),
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    return {
      toolName: asString(item.title) ?? asString(item.name) ?? "Tool",
      ownership: toOwnership(ownerToolUseId),
    };
  }

  return null;
}

function getToolContext(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext | null {
  return classifyGenericTool(item, ownerToolUseId);
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

function buildCollaborationMode(model: string, permissionMode: string | undefined) {
  return {
    mode: permissionMode === "plan" ? "plan" as const : "default" as const,
    settings: {
      model,
      reasoning_effort: "medium",
      developer_instructions: permissionMode === "plan"
        ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
        : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function requestedPermissionsIncludeFileWrite(
  requestedPermissions: Record<string, unknown> | undefined,
): boolean {
  const fileSystem = asObject(requestedPermissions?.fileSystem);
  const writeEntries = asArray(fileSystem?.write)
    .map(asString)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return writeEntries.length > 0;
}

export function shouldAutoDeclineCodexPlanApproval(params: {
  permissionMode: "default" | "plan" | undefined;
  requestMethod: string;
  requestedPermissions?: Record<string, unknown> | undefined;
}): boolean {
  if (params.permissionMode !== "plan") {
    return false;
  }

  if (params.requestMethod === "item/fileChange/requestApproval") {
    return true;
  }

  if (params.requestMethod === "item/permissions/requestApproval") {
    return requestedPermissionsIncludeFileWrite(params.requestedPermissions);
  }

  return false;
}

function killChildProcess(child: ChildProcessWithoutNullStreams): void {
  child.kill();
}

export const runCodexWithStreaming: ChatAgentRunner = async ({
  prompt,
  sessionId,
  listSlashCommandsOnly,
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
  const runtimeEnv = buildCodexRuntimeEnv({
    model: resolvedModel,
    providerApiKey,
    providerBaseUrl,
  });
  const child = spawn(CODEX_BINARY, ["app-server"], {
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
  const streamedTextByMessageId = new Map<string, string>();
  const subagentOwnerByThreadId = new Map<string, string>();
  const subagentDescriptionByToolUseId = new Map<string, string>();
  const planTextByItemId = new Map<string, string>();

  let providerThreadId: string | null = null;
  let finalOutput = "";
  let fallbackAgentOutput = "";
  let latestPlanText: string | null = null;
  let latestStructuredPlan: CodexStructuredPlan | null = null;
  let completed = false;
  let finished = false;
  let completionError: Error | null = null;

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
    const rejectWith = (error: Error) => {
      if (completed) {
        return;
      }
      completed = true;
      completionError = error;
      reject(error);
    };

    const resolveComplete = () => {
      if (completed) {
        return;
      }
      completed = true;
      resolve();
    };

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
            const phase = asString(item.phase) ?? "final_answer";
            agentMessagePhaseById.set(itemId, phase);
            const completedText = asString(item.text);
            if (completedText) {
              streamedTextByMessageId.set(itemId, completedText);
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
          const phase = itemId ? agentMessagePhaseById.get(itemId) ?? "final_answer" : "final_answer";
          if (phase !== "final_answer") {
            return;
          }

          const delta = asString(params?.delta);
          if (!delta || delta.length === 0) {
            return;
          }

          if (itemId) {
            streamedTextByMessageId.set(itemId, (streamedTextByMessageId.get(itemId) ?? "") + delta);
          }
          finalOutput += delta;
          await onText(delta);
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
            const phase = agentMessagePhaseById.get(itemId) ?? asString(item.phase) ?? "final_answer";
            const text = asString(item.text) ?? "";
            fallbackAgentOutput = text || fallbackAgentOutput;
            if (phase === "final_answer" && text.length > 0 && !streamedTextByMessageId.has(itemId)) {
              streamedTextByMessageId.set(itemId, text);
              finalOutput += text;
              await onText(text);
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
    writeMessage({ method: "initialized" });

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
    const detectedPlanContent = permissionMode === "plan"
      ? resolveCodexPlanContent({
        planText: latestPlanText,
        structuredPlan: latestStructuredPlan,
        agentOutput: normalizedOutput,
      })
      : null;

    if (permissionMode === "plan" && detectedPlanContent) {
      await onPlanFileDetected({
        filePath: PLAN_FILE_PATH,
        content: detectedPlanContent,
      });
    }

    return {
      output: normalizedOutput,
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
