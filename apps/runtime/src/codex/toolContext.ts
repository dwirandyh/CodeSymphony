import type { ClaudeOwnershipReason } from "../types.js";
import { asArray, asNumber, asObject, asString } from "./protocolUtils.js";

export type ToolContext = {
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

export function toOwnership(toolUseId: string | null): NonNullable<ToolContext["ownership"]> {
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

export function buildSummaryFromCommandExecution(item: Record<string, unknown>, toolName: string): string {
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

export function buildSummaryFromFileChange(item: Record<string, unknown>, toolName: string): string {
  const { path: firstPath } = selectPrimaryCodexFileChange(item);

  if (toolName === "Write" && firstPath) {
    return `Created ${firstPath}`;
  }
  if (toolName === "Edit" && firstPath) {
    return `Edited ${firstPath}`;
  }
  return toolName === "Write" ? "Created files" : "Edited files";
}

export function classifyCommandExecution(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext {
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

export function classifyFileChange(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext {
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

export function getToolContext(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext | null {
  return classifyGenericTool(item, ownerToolUseId);
}
