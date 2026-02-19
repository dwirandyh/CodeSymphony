import { describe, expect, it } from "vitest";
import {
    isBashTool,
    isSearchTool,
    isEditTool,
    commandFromToolInput,
    commandFromUnknownToolInput,
    stringFromUnknown,
    readTargetFromUnknownToolInput,
    editTargetFromUnknownToolInput,
    searchParamsFromUnknownToolInput,
    formatSearchParamValue,
} from "../../src/claude/toolClassification";

describe("isBashTool", () => {
    it("returns true for 'Bash' (case-insensitive)", () => {
        expect(isBashTool("Bash")).toBe(true);
        expect(isBashTool("bash")).toBe(true);
        expect(isBashTool("BASH")).toBe(true);
        expect(isBashTool(" bash ")).toBe(true);
    });

    it("returns false for non-bash tools", () => {
        expect(isBashTool("Read")).toBe(false);
        expect(isBashTool("Edit")).toBe(false);
        expect(isBashTool("")).toBe(false);
    });
});

describe("isSearchTool", () => {
    it("returns true for search-type tools", () => {
        expect(isSearchTool("Glob")).toBe(true);
        expect(isSearchTool("grep")).toBe(true);
        expect(isSearchTool("Search")).toBe(true);
        expect(isSearchTool("Find")).toBe(true);
        expect(isSearchTool("List")).toBe(true);
        expect(isSearchTool("Scan")).toBe(true);
        expect(isSearchTool("ls")).toBe(true);
    });

    it("returns false for non-search tools", () => {
        expect(isSearchTool("Read")).toBe(false);
        expect(isSearchTool("Edit")).toBe(false);
        expect(isSearchTool("Bash")).toBe(false);
    });
});

describe("isEditTool", () => {
    it("returns true for edit-type tools", () => {
        expect(isEditTool("Edit")).toBe(true);
        expect(isEditTool("MultiEdit")).toBe(true);
        expect(isEditTool("Write")).toBe(true);
    });

    it("returns false for non-edit tools", () => {
        expect(isEditTool("Read")).toBe(false);
        expect(isEditTool("Bash")).toBe(false);
    });
});

describe("commandFromToolInput", () => {
    it("extracts command string from input", () => {
        expect(commandFromToolInput({ command: "ls -la" })).toBe("ls -la");
    });

    it("returns undefined for non-string command", () => {
        expect(commandFromToolInput({ command: 42 })).toBeUndefined();
        expect(commandFromToolInput({})).toBeUndefined();
    });

    it("returns undefined for empty/whitespace command", () => {
        expect(commandFromToolInput({ command: "" })).toBeUndefined();
        expect(commandFromToolInput({ command: "   " })).toBeUndefined();
    });
});

describe("commandFromUnknownToolInput", () => {
    it("extracts command from unknown object input", () => {
        expect(commandFromUnknownToolInput({ command: "pwd" })).toBe("pwd");
    });

    it("returns undefined for non-object inputs", () => {
        expect(commandFromUnknownToolInput("string")).toBeUndefined();
        expect(commandFromUnknownToolInput(null)).toBeUndefined();
        expect(commandFromUnknownToolInput([1, 2])).toBeUndefined();
    });
});

describe("stringFromUnknown", () => {
    it("returns truncated string", () => {
        expect(stringFromUnknown("hello")).toBe("hello");
    });

    it("returns undefined for non-string", () => {
        expect(stringFromUnknown(42)).toBeUndefined();
        expect(stringFromUnknown(null)).toBeUndefined();
    });

    it("returns undefined for empty/whitespace string", () => {
        expect(stringFromUnknown("")).toBeUndefined();
        expect(stringFromUnknown("   ")).toBeUndefined();
    });
});

describe("readTargetFromUnknownToolInput", () => {
    it("extracts path from Read tool input", () => {
        expect(readTargetFromUnknownToolInput("Read", { path: "README.md" })).toBe("README.md");
    });

    it("tries multiple key candidates", () => {
        expect(readTargetFromUnknownToolInput("Read", { file_path: "src/main.ts" })).toBe("src/main.ts");
        expect(readTargetFromUnknownToolInput("Read", { filepath: "a.js" })).toBe("a.js");
        expect(readTargetFromUnknownToolInput("Read", { file: "b.ts" })).toBe("b.ts");
        expect(readTargetFromUnknownToolInput("Read", { target: "c.py" })).toBe("c.py");
        expect(readTargetFromUnknownToolInput("Read", { url: "http://x" })).toBe("http://x");
    });

    it("extracts from paths/files arrays", () => {
        expect(readTargetFromUnknownToolInput("Read", { paths: ["a.ts", "b.ts"] })).toBe("a.ts");
        expect(readTargetFromUnknownToolInput("Read", { files: ["x.js"] })).toBe("x.js");
    });

    it("returns undefined for non-Read tools", () => {
        expect(readTargetFromUnknownToolInput("Edit", { path: "a.ts" })).toBeUndefined();
    });

    it("returns undefined for non-object input", () => {
        expect(readTargetFromUnknownToolInput("Read", "string")).toBeUndefined();
        expect(readTargetFromUnknownToolInput("Read", null)).toBeUndefined();
    });
});

describe("editTargetFromUnknownToolInput", () => {
    it("extracts file_path from Edit tool input", () => {
        expect(editTargetFromUnknownToolInput("Edit", { file_path: "src/main.ts" })).toBe("src/main.ts");
    });

    it("tries multiple key candidates", () => {
        expect(editTargetFromUnknownToolInput("Write", { path: "a.ts" })).toBe("a.ts");
        expect(editTargetFromUnknownToolInput("MultiEdit", { file: "b.ts" })).toBe("b.ts");
    });

    it("returns undefined for non-edit tools", () => {
        expect(editTargetFromUnknownToolInput("Read", { file_path: "a.ts" })).toBeUndefined();
    });
});

describe("formatSearchParamValue", () => {
    it("formats strings", () => {
        expect(formatSearchParamValue("*.ts")).toBe("*.ts");
    });

    it("formats numbers and booleans", () => {
        expect(formatSearchParamValue(42)).toBe("42");
        expect(formatSearchParamValue(true)).toBe("true");
    });

    it("formats arrays (max 3 entries)", () => {
        expect(formatSearchParamValue(["a", "b", "c", "d"])).toBe("a | b | c");
    });

    it("returns undefined for objects and empty arrays", () => {
        expect(formatSearchParamValue({})).toBeUndefined();
        expect(formatSearchParamValue([])).toBeUndefined();
    });
});

describe("searchParamsFromUnknownToolInput", () => {
    it("extracts params for search tools", () => {
        const result = searchParamsFromUnknownToolInput("Glob", {
            pattern: "README.md",
            path: "apps/web/src",
        });
        expect(result).toBe("pattern=README.md, path=apps/web/src");
    });

    it("limits to 4 params", () => {
        const result = searchParamsFromUnknownToolInput("Grep", {
            pattern: "a",
            query: "b",
            path: "c",
            file: "d",
            include: "e",
        });
        expect(result!.split(", ").length).toBeLessThanOrEqual(4);
    });

    it("skips sensitive keys", () => {
        const result = searchParamsFromUnknownToolInput("Grep", {
            pattern: "test",
            api_key: "secret",
        });
        expect(result).toBe("pattern=test");
    });

    it("returns undefined for non-search tools", () => {
        expect(searchParamsFromUnknownToolInput("Read", { pattern: "x" })).toBeUndefined();
    });
});
