import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SDKMessage, SDKToolUseMessage } from "@cursor/sdk";
import type { AgentTodoItem } from "@codesymphony/shared-types";
import type { ChatAgentRunner } from "../../types.js";

type RunnerArgs = Parameters<ChatAgentRunner>[0];

type ToolState = {
  toolUseId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  startedAtMs: number;
  startedEmitted: boolean;
  finishedEmitted: boolean;
};

type EventBridgeCallbacks = Pick<
  RunnerArgs,
  "onText" | "onToolStarted" | "onToolOutput" | "onToolFinished" | "onThinking" | "onTodoUpdate"
> & {
  onPlanFileDetected?: RunnerArgs["onPlanFileDetected"];
};

const CURSOR_TODO_RESULT_LINE = /^- \*\*(COMPLETED|IN_PROGRESS|PENDING|CANCELLED)\*\*: (.+) \(id: ([^)]+)\)\s*$/gim;

function normalizeToolUseId(toolUseId: string): string {
  return toolUseId.replace(/\s+/g, "");
}

function coerceObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractCommand(input: unknown): string | undefined {
  const object = coerceObject(input);
  const command = object?.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

function extractPathsFromArgs(input: unknown): string[] {
  const object = coerceObject(input);
  if (!object) {
    return [];
  }

  const singlePath = object.path ?? object.file_path ?? object.filePath;
  if (typeof singlePath === "string" && singlePath.length > 0) {
    return [singlePath];
  }

  const paths = object.paths;
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function extractPathFromArgs(input: unknown): string | undefined {
  return extractPathsFromArgs(input)[0];
}

function parseReadLintsResult(result: unknown): { totalDiagnostics: number | null } | null {
  const object = coerceObject(result);
  if (!object) {
    return null;
  }

  const value = coerceObject(object.value) ?? object;
  const totalDiagnostics = value.totalDiagnostics;
  if (typeof totalDiagnostics !== "number") {
    return null;
  }

  return { totalDiagnostics };
}

function buildReadLintsSummary(paths: string[], result: unknown): string {
  const parsed = parseReadLintsResult(result);
  const issueCount = parsed?.totalDiagnostics ?? null;
  const issueLabel = issueCount == null
    ? null
    : `${issueCount} issue${issueCount === 1 ? "" : "s"}`;

  if (paths.length === 1) {
    const basename = paths[0].split("/").pop() ?? paths[0];
    return issueLabel ? `Checked lints ${basename} (${issueLabel})` : `Checked lints ${basename}`;
  }

  if (paths.length > 1) {
    return issueLabel
      ? `Checked lints ${paths.length} files (${issueLabel})`
      : `Checked lints ${paths.length} files`;
  }

  return issueLabel ? `Checked lints (${issueLabel})` : "Checked lints";
}

function buildSearchParamsFromArgs(input: unknown): string | undefined {
  const object = coerceObject(input);
  if (!object) {
    return undefined;
  }

  const parts: string[] = [];
  const pattern = object.pattern;
  const glob = object.glob ?? object.globPattern;
  if (typeof pattern === "string" && pattern.length > 0) {
    parts.push(`pattern=${pattern}`);
  }
  if (typeof glob === "string" && glob.length > 0) {
    parts.push(`glob=${glob}`);
  }

  return parts.length > 0 ? parts.join(", ") : undefined;
}

function isShellLikeTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "shell" || normalized === "bash";
}

function bashPayloadExtras(tool: ToolState): {
  command?: string;
  shell?: "bash";
  isBash?: true;
} {
  const command = extractCommand(tool.args);
  if (!command && !isShellLikeTool(tool.toolName)) {
    return {};
  }

  return {
    ...(command ? { command } : {}),
    shell: "bash",
    isBash: true,
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  const object = coerceObject(result);
  const stdout = object?.stdout;
  if (typeof stdout === "string") {
    return stdout;
  }

  const content = object?.content;
  if (typeof content === "string") {
    return content;
  }

  return result == null ? "" : JSON.stringify(result);
}

function buildToolSummary(tool: ToolState): string {
  const toolName = tool.toolName.trim().toLowerCase();
  const path = extractPathFromArgs(tool.args);
  const command = extractCommand(tool.args);
  const searchParams = buildSearchParamsFromArgs(tool.args);

  if (isCreatePlanTool(tool.toolName)) {
    return "Created plan";
  }

  if (toolName === "read" && path) {
    return `Read ${path}`;
  }

  if ((toolName === "edit" || toolName === "write") && path) {
    return `Edited ${path}`;
  }

  if ((toolName === "grep" || toolName === "glob" || toolName === "search") && searchParams) {
    return `Completed ${toolName} (${searchParams})`;
  }

  if ((toolName === "grep" || toolName === "glob" || toolName === "search")) {
    return `Completed ${toolName}`;
  }

  if (toolName === "readlints") {
    const paths = extractPathsFromArgs(tool.args);
    if (paths.length > 0 || tool.result != null) {
      return buildReadLintsSummary(paths, tool.result);
    }
  }

  if (command) {
    return `Ran ${command}`;
  }

  const output = stringifyResult(tool.result);
  return output.trim() || `${tool.toolName} completed`;
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

function parseSavedPlanPath(result: unknown): string | null {
  const text = typeof result === "string" ? result : stringifyResult(result);
  const match = text.match(/Plan saved to (file:\/\/\S+)/i);
  if (!match?.[1]) {
    return null;
  }

  try {
    return fileURLToPath(match[1]);
  } catch {
    return match[1];
  }
}

function isPlanEditingTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "edit" || normalized === "write";
}

function isCreatePlanTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === "createplan";
}

function extractInlinePlanContent(args: unknown): string | null {
  const object = coerceObject(args);
  const plan = object?.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : null;
}

function extractEditTargetPath(args: unknown): string | undefined {
  const object = coerceObject(args);
  const path = object?.path ?? object?.file_path ?? object?.filePath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
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

async function emitPlanIfDetected(
  tool: ToolState,
  cwd: string | undefined,
  planState: { emitted: boolean },
  callbacks: EventBridgeCallbacks,
): Promise<void> {
  if (planState.emitted || !callbacks.onPlanFileDetected || !cwd) {
    return;
  }

  const inlinePlan = isCreatePlanTool(tool.toolName) ? extractInlinePlanContent(tool.args) : null;
  if (inlinePlan) {
    const filePath = resolve(cwd, ".cursor", "plans", "cursor-plan.md");
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${inlinePlan}\n`, "utf8");
    } catch {
      // Best-effort: still surface the plan even if the file write fails.
    }
    planState.emitted = true;
    await callbacks.onPlanFileDetected({ filePath, content: inlinePlan });
    return;
  }

  const savedPlanPath = parseSavedPlanPath(tool.result);
  const editTarget = isPlanEditingTool(tool.toolName) ? extractEditTargetPath(tool.args) : undefined;
  const candidatePath = savedPlanPath
    ?? (editTarget && isCursorPlanFilePath(editTarget) ? editTarget : null);
  if (!candidatePath) {
    return;
  }

  const content = await readCursorPlanFile(cwd, candidatePath);
  if (!content) {
    return;
  }

  planState.emitted = true;
  const filePath = isAbsolute(candidatePath) ? candidatePath : resolve(cwd, candidatePath);
  await callbacks.onPlanFileDetected({ filePath, content });
}

function isTodoWriteTool(toolName: string): boolean {
  return toolName === "TodoWrite" || toolName.toLowerCase().includes("todo");
}

function parseCursorTodoItemsFromResultText(text: string): AgentTodoItem[] {
  const statusByLabel: Record<string, AgentTodoItem["status"]> = {
    COMPLETED: "completed",
    IN_PROGRESS: "in_progress",
    PENDING: "pending",
    CANCELLED: "cancelled",
  };

  return [...text.matchAll(CURSOR_TODO_RESULT_LINE)].flatMap((match) => {
    const status = statusByLabel[match[1]?.toUpperCase() ?? ""];
    const content = match[2]?.trim();
    const id = match[3]?.trim();
    if (!status || !content) {
      return [];
    }

    return [{ id: id || null, content, status } satisfies AgentTodoItem];
  });
}

async function emitTodoUpdate(
  tool: ToolState,
  callbacks: EventBridgeCallbacks,
): Promise<void> {
  if (!callbacks.onTodoUpdate || !isTodoWriteTool(tool.toolName)) {
    return;
  }

  const items = parseCursorTodoItemsFromResultText(stringifyResult(tool.result));
  if (items.length === 0) {
    return;
  }

  await callbacks.onTodoUpdate({
    agent: "cursor",
    groupId: `cursor-sdk:${tool.toolUseId}`,
    explanation: null,
    anchorToolUseId: tool.toolUseId,
    items,
  });
}

async function handleToolMessage(
  message: SDKToolUseMessage,
  toolStates: Map<string, ToolState>,
  callbacks: EventBridgeCallbacks,
  cwd: string | undefined,
  planState: { emitted: boolean },
): Promise<void> {
  const toolUseId = normalizeToolUseId(message.call_id);
  const current = toolStates.get(toolUseId) ?? {
    toolUseId,
    toolName: message.name,
    args: message.args ?? {},
    result: message.result,
    startedAtMs: Date.now(),
    startedEmitted: false,
    finishedEmitted: false,
  };
  current.toolName = message.name || current.toolName;
  if (message.args !== undefined) {
    current.args = message.args;
  }
  if (message.result !== undefined) {
    current.result = message.result;
  }
  toolStates.set(toolUseId, current);

  const command = extractCommand(current.args);
  const searchParams = buildSearchParamsFromArgs(current.args);
  if (!current.startedEmitted) {
    current.startedEmitted = true;
    await callbacks.onToolStarted({
      toolName: current.toolName,
      toolUseId,
      parentToolUseId: null,
      ...bashPayloadExtras(current),
      ...(searchParams ? { searchParams } : {}),
    });
  }

  if (message.status === "running") {
    await callbacks.onToolOutput({
      toolName: current.toolName,
      toolUseId,
      parentToolUseId: null,
      elapsedTimeSeconds: Math.max(0, (Date.now() - current.startedAtMs) / 1000),
      ...bashPayloadExtras(current),
    });
    return;
  }

  if (!current.finishedEmitted) {
    current.finishedEmitted = true;
    const inlinePlan = isCreatePlanTool(current.toolName) ? extractInlinePlanContent(current.args) : null;
    await callbacks.onToolFinished({
      toolName: current.toolName,
      summary: buildToolSummary(current),
      precedingToolUseIds: [toolUseId],
      ...(coerceObject(current.args) ? { toolInput: coerceObject(current.args)! } : {}),
      ...bashPayloadExtras(current),
      ...(searchParams ? { searchParams } : {}),
      ...(message.status === "error"
        ? { error: stringifyResult(current.result) }
        : { output: inlinePlan ?? stringifyResult(current.result) }),
    });
    await emitTodoUpdate(current, callbacks);
    await emitPlanIfDetected(current, cwd, planState, callbacks);
  }
}

export type CursorSdkRunStreamResult = {
  output: string;
  planEmitted: boolean;
};

export async function bridgeCursorSdkRunStream(params: {
  stream: AsyncIterable<SDKMessage>;
  cwd?: string;
} & EventBridgeCallbacks): Promise<CursorSdkRunStreamResult> {
  const toolStates = new Map<string, ToolState>();
  const planState = { emitted: false };
  let output = "";

  for await (const message of params.stream) {
    switch (message.type) {
      case "assistant":
        for (const block of message.message.content) {
          if (block.type !== "text") {
            continue;
          }
          output += block.text;
          await params.onText(block.text);
        }
        break;
      case "thinking":
        await params.onThinking?.(true);
        break;
      case "tool_call":
        await handleToolMessage(message, toolStates, params, params.cwd, planState);
        break;
    }
  }

  return { output, planEmitted: planState.emitted };
}
