import { describe, expect, it } from "vitest";
import {
    parseSubagentTranscript,
    extractSubagentResponse,
} from "../../src/claude/subagentTranscript";

describe("parseSubagentTranscript", () => {
    it("extracts description from first user message (string content)", () => {
        const transcript = [
            JSON.stringify({ type: "user", message: { content: "Analyze this codebase" } }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done analyzing." }] } }),
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.description).toBe("Analyze this codebase");
        expect(result.lastMessage).toBe("Done analyzing.");
    });

    it("extracts description from string user content when message.type is user but content is plain text", () => {
        const transcript = [
            JSON.stringify({ type: "user", message: { role: "user", content: "Inspect repository structure" } }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Found files." }] } }),
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.description).toBe("Inspect repository structure");
        expect(result.lastMessage).toBe("Found files.");
    });

    it("extracts description from content blocks", () => {
        const transcript = [
            JSON.stringify({
                type: "user",
                message: {
                    content: [
                        { type: "text", text: "Part 1" },
                        { type: "text", text: "Part 2" },
                    ],
                },
            }),
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.description).toBe("Part 1\nPart 2");
    });

    it("uses last assistant message as lastMessage", () => {
        const transcript = [
            JSON.stringify({ type: "user", message: { content: "Hello" } }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First response" }] } }),
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Final response" }] } }),
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.lastMessage).toBe("Final response");
    });

    it("extracts lastMessage from result-type entries", () => {
        const transcript = [
            JSON.stringify({ type: "user", message: { content: "Task" } }),
            JSON.stringify({ type: "result", result: "The final result text" }),
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.lastMessage).toBe("The final result text");
    });

    it("handles empty transcript", () => {
        const result = parseSubagentTranscript("");
        expect(result.description).toBe("");
        expect(result.lastMessage).toBe("");
    });

    it("skips malformed JSONL lines", () => {
        const transcript = [
            "not json",
            JSON.stringify({ type: "user", message: { content: "Valid" } }),
            "{broken json",
        ].join("\n");

        const result = parseSubagentTranscript(transcript);
        expect(result.description).toBe("Valid");
    });
});

describe("extractSubagentResponse", () => {
    it("extracts string response", () => {
        expect(extractSubagentResponse("done")).toBe("done");
    });

    it("extracts from array of content blocks", () => {
        const response = [
            { text: "part1" },
            { content: "part2" },
            "part3",
        ];
        expect(extractSubagentResponse(response)).toBe("part1\npart2\npart3");
    });

    it("extracts from object with text property", () => {
        expect(extractSubagentResponse({ text: "result" })).toBe("result");
    });

    it("extracts from object with content property", () => {
        expect(extractSubagentResponse({ content: "result" })).toBe("result");
    });

    it("extracts from object with result property", () => {
        expect(extractSubagentResponse({ result: "result" })).toBe("result");
    });

    it("returns empty string for null/undefined", () => {
        expect(extractSubagentResponse(null)).toBe("");
        expect(extractSubagentResponse(undefined)).toBe("");
    });

    it("returns empty string for empty/whitespace responses", () => {
        expect(extractSubagentResponse("   ")).toBe("");
        expect(extractSubagentResponse("")).toBe("");
    });
});
