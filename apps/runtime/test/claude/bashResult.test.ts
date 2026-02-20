import { describe, expect, it } from "vitest";
import {
    truncateUtf8,
    truncateBashResult,
    extractBashToolResult,
    asString,
    firstNonEmptyString,
    contentToString,
} from "../../src/claude/bashResult";

describe("truncateUtf8", () => {
    it("returns input unchanged when within byte limit", () => {
        expect(truncateUtf8("hello", 100)).toBe("hello");
    });

    it("truncates to max bytes", () => {
        const input = "a".repeat(100);
        const result = truncateUtf8(input, 50);
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(50);
    });

    it("returns empty string for zero maxBytes", () => {
        expect(truncateUtf8("hello", 0)).toBe("");
    });

    it("handles multi-byte characters safely", () => {
        const input = "こんにちは"; // 15 bytes in UTF-8
        const result = truncateUtf8(input, 6);
        expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(6);
    });
});

describe("truncateBashResult", () => {
    it("returns full output when within limits", () => {
        const result = truncateBashResult("hello", "");
        expect(result.output).toBe("hello");
        expect(result.error).toBeUndefined();
        expect(result.truncated).toBe(false);
    });

    it("returns undefined output for empty strings", () => {
        const result = truncateBashResult("", "some error");
        expect(result.output).toBeUndefined();
        expect(result.error).toBe("some error");
    });

    it("truncates oversized output", () => {
        const bigOutput = "x".repeat(25 * 1024);
        const result = truncateBashResult(bigOutput, "");
        expect(result.truncated).toBe(true);
        expect(result.outputBytes).toBe(Buffer.byteLength(bigOutput, "utf8"));
    });
});

describe("asString", () => {
    it("returns string values directly", () => {
        expect(asString("hello")).toBe("hello");
    });

    it("returns empty string for non-string values", () => {
        expect(asString(42)).toBe("");
        expect(asString(null)).toBe("");
        expect(asString(undefined)).toBe("");
    });
});

describe("firstNonEmptyString", () => {
    it("returns first non-empty string", () => {
        expect(firstNonEmptyString(["", "  ", "hello", "world"])).toBe("hello");
    });

    it("returns empty string when no non-empty strings", () => {
        expect(firstNonEmptyString(["", "  ", null, 42])).toBe("");
    });

    it("skips non-string values", () => {
        expect(firstNonEmptyString([null, undefined, 42, "found"])).toBe("found");
    });
});

describe("contentToString", () => {
    it("returns string values directly", () => {
        expect(contentToString("hello")).toBe("hello");
    });

    it("extracts text from content blocks", () => {
        const content = [
            { type: "text", text: "Hello" },
            { type: "text", text: "World" },
        ];
        expect(contentToString(content)).toBe("Hello\nWorld");
    });

    it("handles mixed string and object entries", () => {
        expect(contentToString(["line1", { type: "text", text: "line2" }])).toBe("line1\nline2");
    });

    it("returns empty string for non-string non-array", () => {
        expect(contentToString(42)).toBe("");
        expect(contentToString(null)).toBe("");
    });

    it("skips non-text content blocks", () => {
        const content = [
            { type: "image", url: "test.png" },
            { type: "text", text: "visible" },
        ];
        expect(contentToString(content)).toBe("visible");
    });
});

describe("extractBashToolResult", () => {
    it("extracts stdout/stderr payloads", () => {
        const result = extractBashToolResult({
            stdout: "/tmp/project",
            stderr: "",
            interrupted: false,
        });
        expect(result).not.toBeNull();
        expect(result?.output).toBe("/tmp/project");
        expect(result?.error).toBeUndefined();
        expect(result?.truncated).toBe(false);
    });

    it("treats string tool response as output", () => {
        const result = extractBashToolResult("/tmp/project");
        expect(result?.output).toBe("/tmp/project");
        expect(result?.error).toBeUndefined();
    });

    it("treats error-prefixed string as error output", () => {
        const result = extractBashToolResult("Error: Exit code 1");
        expect(result?.output).toBeUndefined();
        expect(result?.error).toBe("Error: Exit code 1");
    });

    it("extracts text content payloads", () => {
        const result = extractBashToolResult({
            is_error: false,
            content: [{ type: "text", text: "/Users/demo/project" }],
        });
        expect(result?.output).toBe("/Users/demo/project");
        expect(result?.error).toBeUndefined();
    });

    it("treats is_error content as error", () => {
        const result = extractBashToolResult({
            is_error: true,
            content: [{ type: "text", text: "Permission denied" }],
        });
        expect(result?.output).toBeUndefined();
        expect(result?.error).toBe("Permission denied");
    });

    it("returns null for empty string", () => {
        expect(extractBashToolResult("")).toBeNull();
        expect(extractBashToolResult("   ")).toBeNull();
    });

    it("returns null for non-object non-string", () => {
        expect(extractBashToolResult(42)).toBeNull();
        expect(extractBashToolResult(null)).toBeNull();
        expect(extractBashToolResult([1, 2])).toBeNull();
    });

    it("extracts nested result objects", () => {
        const result = extractBashToolResult({
            result: { output: "nested output", stderr: "nested error" },
        });
        expect(result?.output).toBe("nested output");
        expect(result?.error).toBe("nested error");
    });

    it("extracts toolUseResult text", () => {
        const result = extractBashToolResult({ toolUseResult: "command output" });
        expect(result?.output).toBe("command output");
    });

    it("extracts error message when is_error is true", () => {
        const result = extractBashToolResult({
            message: "Something went wrong",
            is_error: true,
        });
        expect(result?.error).toBe("Something went wrong");
    });
});
