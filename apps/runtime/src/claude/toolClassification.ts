import type { AgentTodoItem } from "@codesymphony/shared-types";
import { truncateForPreview } from "./sanitize.js";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie)/i;
const WEB_SEARCH_TOOL_NAME_PATTERN = /^(websearch|web_search|web-search|search_web)$/i;
const WEB_SEARCH_TITLE_PATTERN = /\bweb\s*search\b|\bsearch(?:ing)?\s+the\s+web\b/i;
const MCP_TOOL_NAME_PATTERN = /^mcp(?:(?:__|[_:-]).+)?$/i;
const MCP_TITLE_PREFIX_PATTERN = /^\s*mcp(?:\s+tool)?\s*[:\-]\s*/i;
const NESTED_TOOL_INPUT_KEYS = ["action", "args", "arguments", "params", "input", "request", "payload", "state", "tool"];
const GENERIC_MCP_LABELS = new Set([
    "mcp",
    "mcp tool",
    "dynamic tool",
    "tool",
    "other",
]);

export type ToolMetadata = {
    toolName: string;
    toolKind?: "mcp" | "web_search";
    command?: string;
    readTarget?: string;
    searchParams?: string;
    editTarget?: string;
    skillName?: string;
    isBash: boolean;
    output?: string;
    error?: string;
    truncated?: boolean;
    outputBytes?: number;
};

function isTodoStatus(value: unknown): value is AgentTodoItem["status"] {
    return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

export function isBashTool(toolName: string): boolean {
    return toolName.trim().toLowerCase() === "bash";
}

export function isSearchTool(toolName: string): boolean {
    return /^(glob|grep|search|find|list|scan|ls)$/i.test(toolName.trim());
}

export function isEditTool(toolName: string): boolean {
    return /^(edit|multiedit|write)$/i.test(toolName.trim());
}

export function isTodoWriteTool(toolName: string): boolean {
    return toolName.trim().toLowerCase() === "todowrite";
}

export function commandFromToolInput(input: Record<string, unknown>): string | undefined {
    const command = input.command;
    if (typeof command !== "string") {
        return undefined;
    }

    const normalized = command.trim();
    return normalized.length > 0 ? normalized : undefined;
}

export function commandFromUnknownToolInput(input: unknown): string | undefined {
    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    return commandFromToolInput(input as Record<string, unknown>);
}

export function stringFromUnknown(input: unknown): string | undefined {
    if (typeof input !== "string") {
        return undefined;
    }

    const normalized = input.trim();
    if (normalized.length === 0) {
        return undefined;
    }

    return truncateForPreview(normalized);
}

function normalizeLabel(value: string | undefined | null): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function coerceRecord(input: unknown): Record<string, unknown> | undefined {
    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    return input as Record<string, unknown>;
}

function collectFirstTextValue(input: unknown, depth = 0): string | undefined {
    if (depth > 2) {
        return undefined;
    }

    const direct = stringFromUnknown(input);
    if (direct) {
        return direct;
    }

    if (Array.isArray(input)) {
        for (const entry of input) {
            const candidate = collectFirstTextValue(entry, depth + 1);
            if (candidate) {
                return candidate;
            }
        }
        return undefined;
    }

    const record = coerceRecord(input);
    if (!record) {
        return undefined;
    }

    const fallbackKeys = ["name", "title", "id", "text", "query", "tool", "server"];
    for (const key of fallbackKeys) {
        const candidate = collectFirstTextValue(record[key], depth + 1);
        if (candidate) {
            return candidate;
        }
    }

    return undefined;
}

function collectQueryValues(input: unknown, depth = 0): string[] {
    if (depth > 2) {
        return [];
    }

    const direct = formatSearchParamValue(input);
    if (direct) {
        return [direct];
    }

    if (Array.isArray(input)) {
        const collected: string[] = [];
        for (const entry of input) {
            collected.push(...collectQueryValues(entry, depth + 1));
            if (collected.length >= 3) {
                break;
            }
        }
        return collected;
    }

    const record = coerceRecord(input);
    if (!record) {
        return [];
    }

    const queryKeys = ["query", "queries", "q", "searchQuery", "searchTerm", "searchTerms", "term", "terms", "keyword", "keywords"];
    const collected: string[] = [];
    for (const key of queryKeys) {
        if (!(key in record)) {
            continue;
        }
        collected.push(...collectQueryValues(record[key], depth + 1));
        if (collected.length >= 3) {
            break;
        }
    }

    return collected;
}

function firstValueFromKeys(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        if (!(key in record)) {
            continue;
        }
        const candidate = collectFirstTextValue(record[key]);
        if (candidate) {
            return candidate;
        }
    }

    return undefined;
}

function firstQueryFromRecord(record: Record<string, unknown>): string | undefined {
    const directValues = collectQueryValues(record);
    if (directValues.length > 0) {
        return truncateForPreview(Array.from(new Set(directValues)).slice(0, 3).join(" | "));
    }

    for (const key of NESTED_TOOL_INPUT_KEYS) {
        const nestedValues = collectQueryValues(record[key]);
        if (nestedValues.length === 0) {
            continue;
        }
        return truncateForPreview(Array.from(new Set(nestedValues)).slice(0, 3).join(" | "));
    }

    return undefined;
}

function isGenericMcpLabel(value: string): boolean {
    const normalized = normalizeLabel(value).toLowerCase();
    return (
        GENERIC_MCP_LABELS.has(normalized)
        || /^mcp(?:\s+tool)?\s*[:_-]\s*(tool|other)$/i.test(normalized)
    );
}

function normalizeMcpCompoundToolName(value: string): string | undefined {
    const normalized = normalizeLabel(value);
    if (!normalized || normalized.includes(" ")) {
        return undefined;
    }

    if (normalized.toLowerCase().startsWith("mcp__")) {
        const [prefix, server, ...toolParts] = normalized.split("__").filter((part) => part.length > 0);
        if (prefix?.toLowerCase() !== "mcp" || !server || toolParts.length === 0) {
            return normalized;
        }

        const tool = toolParts.join(".");
        if (isGenericMcpLabel(tool)) {
            return normalized;
        }

        return `${server}.${tool}`;
    }

    const match = /^([a-z0-9][a-z0-9-]*)[_.:](.+)$/i.exec(normalized);
    if (!match) {
        return undefined;
    }

    const server = normalizeLabel(match[1]);
    const tool = normalizeLabel(match[2]);
    if (!server || !tool || isGenericMcpLabel(tool)) {
        return undefined;
    }

    return `${server}.${tool}`;
}

function resolveMcpToolName(toolName: string, title: string, input: unknown, kind?: string | null): string | undefined {
    const normalizedToolName = normalizeLabel(toolName);
    if (normalizedToolName && normalizedToolName.toLowerCase().startsWith("mcp__")) {
        return normalizeMcpCompoundToolName(normalizedToolName) ?? normalizedToolName;
    }

    if (
        MCP_TOOL_NAME_PATTERN.test(normalizedToolName)
        && normalizedToolName.length > 0
        && !isGenericMcpLabel(normalizedToolName)
    ) {
        return normalizedToolName;
    }

    const compoundToolName = normalizeMcpCompoundToolName(normalizedToolName);
    if (compoundToolName && kind === "other") {
        return compoundToolName;
    }

    const record = coerceRecord(input);
    if (record) {
        const directServer = firstValueFromKeys(record, ["server", "serverName", "mcpServer", "mcp_server", "namespace"]);
        const directTool = firstValueFromKeys(record, ["tool", "toolName", "mcpTool", "mcp_tool", "name"]);
        if (directServer && directTool) {
            const normalizedServer = normalizeLabel(directServer);
            const normalizedTool = normalizeLabel(directTool);
            if (normalizedTool.toLowerCase().startsWith(`${normalizedServer.toLowerCase()}.`)) {
                return normalizedTool;
            }
            return `${normalizedServer}.${normalizedTool}`;
        }
        if (directTool && /\bmcp\b/i.test(normalizeLabel(title))) {
            return normalizeMcpCompoundToolName(directTool) ?? normalizeLabel(directTool);
        }

        for (const key of NESTED_TOOL_INPUT_KEYS) {
            const nested = coerceRecord(record[key]);
            if (!nested) {
                continue;
            }
            const nestedServer = firstValueFromKeys(nested, ["server", "serverName", "mcpServer", "mcp_server", "namespace"]);
            const nestedTool = firstValueFromKeys(nested, ["tool", "toolName", "mcpTool", "mcp_tool", "name"]);
            if (nestedServer && nestedTool) {
                const normalizedServer = normalizeLabel(nestedServer);
                const normalizedTool = normalizeLabel(nestedTool);
                if (normalizedTool.toLowerCase().startsWith(`${normalizedServer.toLowerCase()}.`)) {
                    return normalizedTool;
                }
                return `${normalizedServer}.${normalizedTool}`;
            }
        }
    }

    const normalizedTitle = normalizeLabel(title);
    if (normalizedTitle && /\bmcp\b/i.test(normalizedTitle)) {
        const strippedTitle = normalizeLabel(normalizedTitle.replace(MCP_TITLE_PREFIX_PATTERN, ""));
        if (strippedTitle && !isGenericMcpLabel(strippedTitle)) {
            return normalizeMcpCompoundToolName(strippedTitle) ?? strippedTitle;
        }

        if (!isGenericMcpLabel(normalizedTitle)) {
            return normalizeMcpCompoundToolName(normalizedTitle) ?? normalizedTitle;
        }

        return "MCP tool";
    }

    return undefined;
}

function isWebSearchTool(params: {
    toolName: string;
    title?: string;
    kind?: string | null;
    input?: unknown;
}): boolean {
    const normalizedToolName = normalizeLabel(params.toolName).toLowerCase();
    const normalizedTitle = normalizeLabel(params.title).toLowerCase();
    if (WEB_SEARCH_TOOL_NAME_PATTERN.test(normalizedToolName)) {
        return true;
    }

    if (WEB_SEARCH_TITLE_PATTERN.test(normalizedTitle)) {
        return true;
    }

    if (params.kind === "search" && (normalizedToolName === "web" || normalizedTitle === "web")) {
        return true;
    }

    const record = coerceRecord(params.input);
    return Boolean(
        record
        && (normalizedToolName.includes("web") || normalizedTitle.includes("web"))
        && firstQueryFromRecord(record),
    );
}

function resolveWebSearchQuery(params: {
    toolName: string;
    title?: string;
    kind?: string | null;
    input?: unknown;
}): string | undefined {
    if (!isWebSearchTool(params)) {
        return undefined;
    }

    const record = coerceRecord(params.input);
    if (!record) {
        return undefined;
    }

    return firstQueryFromRecord(record);
}

export function resolveToolPresentationContext(params: {
    toolName: string;
    input?: unknown;
    title?: string;
    kind?: string | null;
}): {
    toolName: string;
    toolKind?: "mcp" | "web_search";
    searchParams?: string;
} {
    const fallbackToolName = normalizeLabel(params.toolName) || normalizeLabel(params.title) || "Tool";
    const mcpToolName = resolveMcpToolName(fallbackToolName, params.title ?? "", params.input, params.kind);
    if (mcpToolName) {
        return {
            toolName: mcpToolName,
            toolKind: "mcp",
        };
    }

    const webSearchQuery = resolveWebSearchQuery(params);
    if (webSearchQuery || isWebSearchTool(params)) {
        return {
            toolName: "WebSearch",
            toolKind: "web_search",
            ...(webSearchQuery ? { searchParams: webSearchQuery } : {}),
        };
    }

    return {
        toolName: fallbackToolName,
    };
}

export function readTargetFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
    if (toolName.trim().toLowerCase() !== "read") {
        return undefined;
    }

    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    const record = input as Record<string, unknown>;
    const directKeyCandidates = ["path", "file_path", "filepath", "file", "target", "url"];
    for (const key of directKeyCandidates) {
        const candidate = stringFromUnknown(record[key]);
        if (candidate) {
            return candidate;
        }
    }

    const listKeyCandidates = ["paths", "files"];
    for (const key of listKeyCandidates) {
        const value = record[key];
        if (!Array.isArray(value)) {
            continue;
        }
        for (const entry of value) {
            const candidate = stringFromUnknown(entry);
            if (candidate) {
                return candidate;
            }
        }
    }

    return undefined;
}

export function editTargetFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
    if (!isEditTool(toolName)) {
        return undefined;
    }

    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    const record = input as Record<string, unknown>;
    const keyCandidates = ["file_path", "filePath", "path", "file", "filepath", "target", "filename"];
    for (const key of keyCandidates) {
        const candidate = stringFromUnknown(record[key]);
        if (candidate) {
            return candidate;
        }
    }

    return undefined;
}

export function skillNameFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
    if (toolName.trim().toLowerCase() !== "skill") {
        return undefined;
    }

    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    const record = input as Record<string, unknown>;
    const keyCandidates = ["skillName", "skill", "name", "slug"];
    for (const key of keyCandidates) {
        const candidate = stringFromUnknown(record[key]);
        if (!candidate) {
            continue;
        }
        const normalized = candidate.trim().toLowerCase().replace(/\s+/g, "-");
        if (/^[a-z0-9][a-z0-9-]{1,}$/.test(normalized)) {
            return normalized;
        }
    }

    return undefined;
}

export function formatSearchParamValue(value: unknown): string | undefined {
    if (typeof value === "string") {
        return stringFromUnknown(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const values: string[] = [];
    for (const entry of value) {
        const mapped = formatSearchParamValue(entry);
        if (!mapped) {
            continue;
        }
        values.push(mapped);
        if (values.length >= 3) {
            break;
        }
    }
    if (values.length === 0) {
        return undefined;
    }

    return values.join(" | ");
}

export function searchParamsFromUnknownToolInput(toolName: string, input: unknown): string | undefined {
    if (!isSearchTool(toolName)) {
        return undefined;
    }

    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    const record = input as Record<string, unknown>;
    const preferredKeys = [
        "pattern",
        "query",
        "search",
        "regex",
        "glob",
        "grep",
        "path",
        "file",
        "file_path",
        "filename",
        "include",
        "exclude",
        "directory",
        "dir",
    ];
    const queue = [
        ...preferredKeys,
        ...Object.keys(record).filter((key) => !preferredKeys.includes(key)),
    ];

    const parts: string[] = [];
    for (const key of queue) {
        if (parts.length >= 4) {
            break;
        }
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            continue;
        }
        const raw = formatSearchParamValue(record[key]);
        if (!raw) {
            continue;
        }
        parts.push(`${key}=${raw}`);
    }

    if (parts.length === 0) {
        return undefined;
    }

    return truncateForPreview(parts.join(", "));
}

export function todoItemsFromUnknownToolInput(toolName: string, input: unknown): AgentTodoItem[] | undefined {
    if (!isTodoWriteTool(toolName)) {
        return undefined;
    }

    if (typeof input !== "object" || input == null || Array.isArray(input)) {
        return undefined;
    }

    const todos = (input as Record<string, unknown>).todos;
    if (!Array.isArray(todos)) {
        return undefined;
    }

    const items = todos.flatMap((entry, index) => {
        if (typeof entry !== "object" || entry == null || Array.isArray(entry)) {
            return [];
        }

        const record = entry as Record<string, unknown>;
        const content = typeof record.content === "string" ? record.content.trim() : "";
        const status = record.status;
        if (content.length === 0 || !isTodoStatus(status)) {
            return [];
        }

        return [{
            id: `claude-todo:${index}`,
            content,
            status,
        } satisfies AgentTodoItem];
    });

    return items.length > 0 ? items : undefined;
}
