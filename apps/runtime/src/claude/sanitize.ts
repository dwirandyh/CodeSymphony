const MAX_LOG_PREVIEW_STRING_CHARS = 500;
const MAX_LOG_PREVIEW_DEPTH = 4;
const MAX_LOG_PREVIEW_ARRAY_ITEMS = 20;
const MAX_LOG_PREVIEW_OBJECT_KEYS = 30;
const SENSITIVE_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie)/i;

export function truncateForPreview(input: string): string {
    if (input.length <= MAX_LOG_PREVIEW_STRING_CHARS) {
        return input;
    }

    return `${input.slice(0, MAX_LOG_PREVIEW_STRING_CHARS)}...`;
}

export function sanitizeForLog(value: unknown, depth = 0, keyHint?: string): unknown {
    if (depth > MAX_LOG_PREVIEW_DEPTH) {
        return "[TruncatedDepth]";
    }

    if (value == null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        if (keyHint && SENSITIVE_KEY_PATTERN.test(keyHint)) {
            return "[REDACTED]";
        }

        return truncateForPreview(value);
    }

    if (Array.isArray(value)) {
        const sliced = value.slice(0, MAX_LOG_PREVIEW_ARRAY_ITEMS);
        const mapped = sliced.map((entry) => sanitizeForLog(entry, depth + 1));
        if (value.length > MAX_LOG_PREVIEW_ARRAY_ITEMS) {
            mapped.push(`[+${value.length - MAX_LOG_PREVIEW_ARRAY_ITEMS} more]`);
        }
        return mapped;
    }

    if (typeof value !== "object") {
        return String(value);
    }

    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const keys = Object.keys(record).slice(0, MAX_LOG_PREVIEW_OBJECT_KEYS);
    for (const key of keys) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            output[key] = "[REDACTED]";
            continue;
        }
        output[key] = sanitizeForLog(record[key], depth + 1, key);
    }
    if (Object.keys(record).length > MAX_LOG_PREVIEW_OBJECT_KEYS) {
        output.__truncatedKeys = Object.keys(record).length - MAX_LOG_PREVIEW_OBJECT_KEYS;
    }
    return output;
}

export function toIso(timestampMs: number): string {
    return new Date(timestampMs).toISOString();
}
