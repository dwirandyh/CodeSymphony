import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
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
  if (!current.startedEmitted) {
    current.startedEmitted = true;
    await callbacks.onToolStarted({
      toolName: current.toolName,
      toolUseId,
      parentToolUseId: null,
      ...(command ? { command, shell: "bash" as const, isBash: true as const } : {}),
    });
  }

  if (message.status === "running") {
    await callbacks.onToolOutput({
      toolName: current.toolName,
      toolUseId,
      parentToolUseId: null,
      elapsedTimeSeconds: Math.max(0, (Date.now() - current.startedAtMs) / 1000),
    });
    return;
  }

  if (!current.finishedEmitted) {
    current.finishedEmitted = true;
    await callbacks.onToolFinished({
      toolName: current.toolName,
      summary: buildToolSummary(current),
      precedingToolUseIds: [toolUseId],
      ...(coerceObject(current.args) ? { toolInput: coerceObject(current.args)! } : {}),
      ...(command ? { command, shell: "bash" as const, isBash: true as const } : {}),
      ...(message.status === "error"
        ? { error: stringifyResult(current.result) }
        : { output: stringifyResult(current.result) }),
    });
    await emitTodoUpdate(current, callbacks);
    await emitPlanIfDetected(current, cwd, planState, callbacks);
  }
}

export async function bridgeCursorSdkRunStream(params: {
  stream: AsyncIterable<SDKMessage>;
  cwd?: string;
} & EventBridgeCallbacks): Promise<string> {
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

  return output;
}
