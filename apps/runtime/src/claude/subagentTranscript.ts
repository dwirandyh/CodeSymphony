/**
 * Parsing utilities for subagent transcript JSONL and tool responses.
 */

export type SubagentTranscriptResult = {
    description: string;
    lastMessage: string;
};

/**
 * Parses a subagent transcript in JSONL format and extracts the description
 * (first user message) and lastMessage (last assistant text or result entry).
 */
export function parseSubagentTranscript(content: string): SubagentTranscriptResult {
    let description = "";
    let lastMessage = "";

    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
        try {
            const entry = JSON.parse(line);

            // First user message content is the prompt/description
            if (!description && entry.type === "user" && entry.message?.content) {
                const msgContent = entry.message.content;
                if (typeof msgContent === "string") {
                    description = msgContent.trim();
                } else if (Array.isArray(msgContent)) {
                    const textParts = msgContent
                        .filter((b: { type: string }) => b.type === "text")
                        .map((b: { text: string }) => b.text);
                    if (textParts.length > 0) {
                        description = textParts.join("\n").trim();
                    }
                }
            }

            // Track last assistant text as response
            if (entry.message?.role === "assistant" && entry.message?.content) {
                const contentArr = Array.isArray(entry.message.content)
                    ? entry.message.content
                    : [];
                const textBlocks = contentArr.filter(
                    (b: { type: string }) => b.type === "text",
                );
                if (textBlocks.length > 0) {
                    lastMessage = textBlocks
                        .map((b: { text: string }) => b.text)
                        .join("\n")
                        .trim();
                }
            }

            // Also check 'result' type entries
            if (entry.type === "result" && typeof entry.result === "string" && entry.result.trim()) {
                lastMessage = entry.result.trim();
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
