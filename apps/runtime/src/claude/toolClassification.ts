import { truncateForPreview } from "./sanitize";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie)/i;

export type ToolMetadata = {
    toolName: string;
    command?: string;
    readTarget?: string;
    searchParams?: string;
    editTarget?: string;
    isBash: boolean;
};

export function isBashTool(toolName: string): boolean {
    return toolName.trim().toLowerCase() === "bash";
}

export function isSearchTool(toolName: string): boolean {
    return /^(glob|grep|search|find|list|scan|ls)$/i.test(toolName.trim());
}

export function isEditTool(toolName: string): boolean {
    return /^(edit|multiedit|write)$/i.test(toolName.trim());
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
    const keyCandidates = ["file_path", "path", "file", "filepath", "target", "filename"];
    for (const key of keyCandidates) {
        const candidate = stringFromUnknown(record[key]);
        if (candidate) {
            return candidate;
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
