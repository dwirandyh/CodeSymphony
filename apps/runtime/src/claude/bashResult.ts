const MAX_BASH_OUTPUT_BYTES = 20 * 1024;

export type BashToolResult = {
    output?: string;
    error?: string;
    truncated: boolean;
    outputBytes: number;
};

export function truncateUtf8(input: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return "";
    }

    const bytes = Buffer.byteLength(input, "utf8");
    if (bytes <= maxBytes) {
        return input;
    }

    return Buffer.from(input, "utf8").subarray(0, maxBytes).toString("utf8");
}

export function truncateBashResult(output: string, error: string): BashToolResult {
    const outputBytes = Buffer.byteLength(output, "utf8") + Buffer.byteLength(error, "utf8");

    if (outputBytes <= MAX_BASH_OUTPUT_BYTES) {
        return {
            output: output.length > 0 ? output : undefined,
            error: error.length > 0 ? error : undefined,
            truncated: false,
            outputBytes,
        };
    }

    let remainingBytes = MAX_BASH_OUTPUT_BYTES;
    const truncatedOutput = truncateUtf8(output, remainingBytes);
    remainingBytes -= Buffer.byteLength(truncatedOutput, "utf8");
    const truncatedError = truncateUtf8(error, remainingBytes);

    return {
        output: truncatedOutput.length > 0 ? truncatedOutput : undefined,
        error: truncatedError.length > 0 ? truncatedError : undefined,
        truncated: true,
        outputBytes,
    };
}

export function asString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function firstNonEmptyString(values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== "string") {
            continue;
        }

        const normalized = value.trim();
        if (normalized.length > 0) {
            return value;
        }
    }

    return "";
}

export function contentToString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (!Array.isArray(value)) {
        return "";
    }

    const chunks: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            chunks.push(entry);
            continue;
        }

        if (typeof entry !== "object" || entry == null || Array.isArray(entry)) {
            continue;
        }

        const text = (entry as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) {
            chunks.push(text);
        }
    }

    return chunks.join("\n").trim();
}

export function extractBashToolResult(toolResponse: unknown): BashToolResult | null {
    if (typeof toolResponse === "string") {
        const normalized = toolResponse.trim();
        if (normalized.length === 0) {
            return null;
        }

        const likelyError = normalized.toLowerCase().startsWith("error:");
        return likelyError
            ? truncateBashResult("", normalized)
            : truncateBashResult(toolResponse, "");
    }

    if (typeof toolResponse !== "object" || toolResponse == null || Array.isArray(toolResponse)) {
        return null;
    }

    const response = toolResponse as Record<string, unknown>;
    const nested = typeof response.result === "object" && response.result != null && !Array.isArray(response.result)
        ? (response.result as Record<string, unknown>)
        : null;
    const output = firstNonEmptyString([
        response.output,
        response.stdout,
        nested?.output,
        nested?.stdout,
    ]);
    const error = firstNonEmptyString([
        response.error,
        response.stderr,
        nested?.error,
        nested?.stderr,
    ]);
    if (output.length > 0 || error.length > 0) {
        return truncateBashResult(output, error);
    }

    const content = contentToString(response.content);
    if (content.length > 0) {
        if (response.is_error === true) {
            return truncateBashResult("", content);
        }

        return truncateBashResult(content, "");
    }

    const toolUseResultText = asString(response.toolUseResult);
    if (toolUseResultText.trim().length > 0) {
        const likelyError = toolUseResultText.trim().toLowerCase().startsWith("error:");
        return likelyError
            ? truncateBashResult("", toolUseResultText)
            : truncateBashResult(toolUseResultText, "");
    }

    const rawError = asString(response.message);
    if (rawError.trim().length > 0 && response.is_error === true) {
        return truncateBashResult("", rawError);
    }

    return null;
}
