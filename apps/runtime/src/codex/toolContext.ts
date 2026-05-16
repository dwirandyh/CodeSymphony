import type { ClaudeOwnershipReason } from "../types.js";
import { asArray, asNumber, asObject, asString } from "./protocolUtils.js";

export type ToolContext = {
  toolName: string;
  toolKind?: "mcp" | "web_search";
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asString(value)?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function firstNonEmptyStringFromArray(value: unknown): string | undefined {
  for (const entry of asArray(value)) {
    const normalized = asString(entry)?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
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

function extractWebSearchParams(item: Record<string, unknown>): string | undefined {
  const action = asObject(item.action);
  const actionType = asString(action?.type)?.trim().toLowerCase();

  if (actionType === "search") {
    return firstNonEmptyString(
      item.query,
      action?.query,
      firstNonEmptyStringFromArray(action?.queries),
    );
  }

  if (actionType === "find_in_page") {
    return firstNonEmptyString(
      action?.pattern,
      item.query,
    );
  }

  if (actionType === "open_page") {
    return firstNonEmptyString(
      action?.url,
      item.query,
    );
  }

  return firstNonEmptyString(
    item.query,
    action?.query,
    firstNonEmptyStringFromArray(action?.queries),
    action?.pattern,
    action?.url,
    item.title,
  );
}

function isGenericToolLabel(value: string | undefined): boolean {
  return (value?.trim().toLowerCase() ?? "") === "tool";
}

function buildMcpToolDisplayName(server: string | undefined, tool: string | undefined): string | undefined {
  if (server && tool) {
    return `${server}.${tool}`;
  }

  return tool ?? server;
}

function extractMcpToolName(item: Record<string, unknown>): string | undefined {
  const invocation = asObject(item.invocation);
  const explicitLabel = firstNonEmptyString(
    item.toolTitle,
    invocation?.toolTitle,
    item.title,
    invocation?.title,
    item.name,
    invocation?.name,
  );

  if (explicitLabel && !isGenericToolLabel(explicitLabel)) {
    return explicitLabel;
  }

  const server = firstNonEmptyString(
    item.server,
    invocation?.server,
  );
  const tool = firstNonEmptyString(
    item.tool,
    invocation?.tool,
    item.toolName,
    invocation?.toolName,
  );

  return buildMcpToolDisplayName(server, tool) ?? explicitLabel;
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

type CodexFileChangeSelection = {
  path?: string;
  kind?: string;
  change?: Record<string, unknown>;
};

function copyKnownFileChangeField(
  target: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  sourceKey: string,
  targetKey = sourceKey,
): void {
  if (!source || target[targetKey] !== undefined) {
    return;
  }

  const value = source[sourceKey];
  if (typeof value === "string" || Array.isArray(value)) {
    target[targetKey] = value;
  }
}

function extractCodexFileChangeToolInput(
  item: Record<string, unknown>,
  selectedChange: Record<string, unknown> | undefined,
  firstPath: string | undefined,
): Record<string, unknown> | undefined {
  const selectedKind = asObject(selectedChange?.kind);
  const toolInput: Record<string, unknown> = {};

  if (firstPath) {
    toolInput.file_path = firstPath;
  }

  const candidateSources = [selectedChange, selectedKind, item];
  for (const source of candidateSources) {
    copyKnownFileChangeField(toolInput, source, "old_string");
    copyKnownFileChangeField(toolInput, source, "new_string");
    copyKnownFileChangeField(toolInput, source, "old_text");
    copyKnownFileChangeField(toolInput, source, "new_text");
    copyKnownFileChangeField(toolInput, source, "old");
    copyKnownFileChangeField(toolInput, source, "new");
    copyKnownFileChangeField(toolInput, source, "content");
    copyKnownFileChangeField(toolInput, source, "new_content");
    copyKnownFileChangeField(toolInput, source, "newContent", "new_content");
    copyKnownFileChangeField(toolInput, source, "edits");
  }

  return Object.keys(toolInput).length > 0 ? toolInput : undefined;
}

export function selectPrimaryCodexFileChange(item: Record<string, unknown>): CodexFileChangeSelection {
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

      return { path, kind, score, change };
    })
    .sort((left, right) => right.score - left.score);

  const selected = rankedChanges[0];
  return selected ? { path: selected.path, kind: selected.kind, change: selected.change } : {};
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
  const { path: firstPath, kind: changeKind, change } = selectPrimaryCodexFileChange(item);
  const toolName = changeKind === "add" || changeKind === "create" ? "Write" : "Edit";

  return {
    toolName,
    editTarget: firstPath,
    toolInput: extractCodexFileChangeToolInput(item, change, firstPath),
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
      toolKind: normalizedType === "websearch" ? "web_search" : undefined,
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
      toolKind: "web_search",
      searchParams: extractWebSearchParams(item),
      ownership: toOwnership(ownerToolUseId),
    };
  }

  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    return {
      toolName: extractMcpToolName(item) ?? "Tool",
      toolKind: "mcp",
      ownership: toOwnership(ownerToolUseId),
    };
  }

  return null;
}

export function getToolContext(item: Record<string, unknown>, ownerToolUseId: string | null): ToolContext | null {
  return classifyGenericTool(item, ownerToolUseId);
}
