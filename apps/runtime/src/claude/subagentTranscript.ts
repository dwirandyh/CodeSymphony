/**
 * Parsing utilities for subagent transcript JSONL and tool responses.
 */

type SubagentTranscriptResult = {
    description: string;
    lastMessage: string;
};

/**
 * Parses a subagent transcript in JSONL format and extracts the description
 * (first user message) and lastMessage (last assistant text or result entry).
 */
function extractTextContent(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }

    if (!Array.isArray(value)) {
        return "";
    }

    const textParts = value
        .filter((block: unknown): block is { type?: string; text?: string } => typeof block === "object" && block !== null)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text!.trim())
        .filter((part) => part.length > 0);

    return textParts.join("\n").trim();
}

export function parseSubagentTranscript(content: string): SubagentTranscriptResult {
    let description = "";
    let lastMessage = "";

    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as {
                type?: string;
                message?: {
                    role?: string;
                    content?: unknown;
                };
                result?: unknown;
            };

            if (!description && entry.type === "user") {
                description = extractTextContent(entry.message?.content);
            }

            if (entry.message?.role === "assistant") {
                const assistantText = extractTextContent(entry.message?.content);
                if (assistantText.length > 0) {
                    lastMessage = assistantText;
                }
            }

            if (entry.type === "result") {
                const resultText = typeof entry.result === "string"
                    ? entry.result.trim()
                    : "";
                if (resultText.length > 0) {
                    lastMessage = resultText;
                }
            }
        } catch {
            // Skip malformed JSONL lines
        }
    }

    return { description, lastMessage };
}

/**
 * Extracts a subagent's final response from a tool_response payload.
 * The response may be a string, array of content blocks, or an object with text/content/result.
 */
export function extractSubagentResponse(toolResponse: unknown): string {
    if (toolResponse == null) {
        return "";
    }

    if (typeof toolResponse === "string") {
        return toolResponse.trim();
    }

    if (Array.isArray(toolResponse)) {
        const parts = toolResponse
            .map((b: unknown) => {
                if (typeof b === "string") return b;
                if (typeof b === "object" && b !== null) {
                    const rec = b as Record<string, unknown>;
                    if (typeof rec.text === "string") return rec.text;
                    if (typeof rec.content === "string") return rec.content;
                    if (typeof rec.result === "string") return rec.result;
                    if (Array.isArray(rec.content)) return extractSubagentResponse(rec.content);
                }
                return "";
            })
            .filter((s) => s.length > 0);
        return parts.join("\n").trim();
    }

    if (typeof toolResponse === "object") {
        const rec = toolResponse as Record<string, unknown>;
        for (const key of ["text", "content", "result"]) {
            const val = rec[key];
            if (typeof val === "string" && val.trim().length > 0) return val.trim();
            if (Array.isArray(val)) return extractSubagentResponse(val);
        }
    }

    return "";
}
