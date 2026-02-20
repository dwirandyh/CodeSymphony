import { describe, expect, it } from "vitest";
import { completionSummaryFromMetadata, failureSummaryFromMetadata } from "../../src/claude/toolSummary";
import type { ToolMetadata } from "../../src/claude/toolClassification";

describe("completionSummaryFromMetadata", () => {
    it("returns 'Ran <command>' when command is set", () => {
        const meta: ToolMetadata = { toolName: "Bash", isBash: true, command: "ls -la" };
        expect(completionSummaryFromMetadata(meta)).toBe("Ran ls -la");
    });

    it("returns 'Ran bash command' for bash without command", () => {
        const meta: ToolMetadata = { toolName: "Bash", isBash: true };
        expect(completionSummaryFromMetadata(meta)).toBe("Ran bash command");
    });

    it("returns 'Read <target>' when readTarget is set", () => {
        const meta: ToolMetadata = { toolName: "Read", isBash: false, readTarget: "README.md" };
        expect(completionSummaryFromMetadata(meta)).toBe("Read README.md");
    });

    it("extracts readTarget from toolInput when not in metadata", () => {
        const meta: ToolMetadata = { toolName: "Read", isBash: false };
        expect(completionSummaryFromMetadata(meta, { path: "config.yaml" })).toBe("Read config.yaml");
    });

    it("returns 'Edited <target>' when editTarget is set", () => {
        const meta: ToolMetadata = { toolName: "Edit", isBash: false, editTarget: "src/app.ts" };
        expect(completionSummaryFromMetadata(meta)).toBe("Edited src/app.ts");
    });

    it("falls back to 'Completed <toolName>'", () => {
        const meta: ToolMetadata = { toolName: "CustomTool", isBash: false };
        expect(completionSummaryFromMetadata(meta)).toBe("Completed CustomTool");
    });
});

describe("failureSummaryFromMetadata", () => {
    it("returns 'Failed <command>' when command is provided", () => {
        const meta: ToolMetadata = { toolName: "Bash", isBash: true };
        expect(failureSummaryFromMetadata(meta, {}, "npm test")).toBe("Failed npm test");
    });

    it("returns 'Bash command failed' for bash without command", () => {
        const meta: ToolMetadata = { toolName: "Bash", isBash: true };
        expect(failureSummaryFromMetadata(meta, {})).toBe("Bash command failed");
    });

    it("returns 'Failed to read <target>' for Read failures", () => {
        const meta: ToolMetadata = { toolName: "Read", isBash: false, readTarget: "missing.txt" };
        expect(failureSummaryFromMetadata(meta, {})).toBe("Failed to read missing.txt");
    });

    it("returns 'Failed to edit <target>' for Edit failures", () => {
        const meta: ToolMetadata = { toolName: "Edit", isBash: false, editTarget: "src/app.ts" };
        expect(failureSummaryFromMetadata(meta, {})).toBe("Failed to edit src/app.ts");
    });

    it("falls back to '<toolName> failed'", () => {
        const meta: ToolMetadata = { toolName: "CustomTool", isBash: false };
        expect(failureSummaryFromMetadata(meta, {})).toBe("CustomTool failed");
    });
});
