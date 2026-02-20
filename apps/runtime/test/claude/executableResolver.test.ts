import { describe, expect, it } from "vitest";
import {
    dedupePreserveOrder,
    isSpawnEnoent,
    captureStderrLine,
    withClaudeSetupHint,
} from "../../src/claude/executableResolver";

describe("dedupePreserveOrder", () => {
    it("removes duplicates preserving order", () => {
        expect(dedupePreserveOrder(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
    });

    it("skips empty and whitespace-only strings", () => {
        expect(dedupePreserveOrder(["", "  ", "a", "", "b"])).toEqual(["a", "b"]);
    });

    it("normalizes by trimming", () => {
        expect(dedupePreserveOrder([" a ", "a"])).toEqual(["a"]);
    });

    it("returns empty array for empty input", () => {
        expect(dedupePreserveOrder([])).toEqual([]);
    });
});

describe("isSpawnEnoent", () => {
    it("returns true for spawn ENOENT errors", () => {
        expect(isSpawnEnoent(new Error("spawn /usr/bin/claude ENOENT"))).toBe(true);
    });

    it("returns false for other errors", () => {
        expect(isSpawnEnoent(new Error("Connection refused"))).toBe(false);
    });

    it("returns false for non-Error values", () => {
        expect(isSpawnEnoent("not an error")).toBe(false);
        expect(isSpawnEnoent(null)).toBe(false);
    });
});

describe("captureStderrLine", () => {
    it("appends non-empty lines to buffer", () => {
        const buffer: string[] = [];
        captureStderrLine(buffer, "error message");
        expect(buffer).toEqual(["error message"]);
    });

    it("skips empty/whitespace lines", () => {
        const buffer: string[] = [];
        captureStderrLine(buffer, "");
        captureStderrLine(buffer, "   ");
        expect(buffer).toEqual([]);
    });

    it("trims lines", () => {
        const buffer: string[] = [];
        captureStderrLine(buffer, "  trimmed  ");
        expect(buffer).toEqual(["trimmed"]);
    });

    it("evicts oldest entries when buffer exceeds max", () => {
        const buffer: string[] = [];
        for (let i = 0; i < 15; i++) {
            captureStderrLine(buffer, `line-${i}`);
        }
        expect(buffer.length).toBe(12);
        expect(buffer[0]).toBe("line-3"); // oldest 3 lines evicted
    });
});

describe("withClaudeSetupHint", () => {
    it("adds hint for ENOENT errors", () => {
        const error = new Error("spawn /usr/bin/claude ENOENT");
        const result = withClaudeSetupHint(error, [], "/usr/bin/claude") as Error;
        expect(result.message).toContain("Claude Code executable was not found");
        expect(result.message).toContain("CLAUDE_CODE_EXECUTABLE");
    });

    it("adds hint for exit code 1 errors", () => {
        const error = new Error("Claude Code process exited with code 1");
        const result = withClaudeSetupHint(error, ["some stderr"], "/usr/bin/claude") as Error;
        expect(result.message).toContain("Claude Code failed to start");
        expect(result.message).toContain("some stderr");
    });

    it("includes stderr lines for exit code 1", () => {
        const error = new Error("Claude Code process exited with code 1");
        const result = withClaudeSetupHint(error, ["err1", "err2"], "claude") as Error;
        expect(result.message).toContain("err1");
        expect(result.message).toContain("err2");
    });

    it("returns non-Error values unchanged", () => {
        expect(withClaudeSetupHint("just a string", [], "claude")).toBe("just a string");
    });

    it("returns unrelated errors unchanged", () => {
        const error = new Error("Network timeout");
        expect(withClaudeSetupHint(error, [], "claude")).toBe(error);
    });
});
