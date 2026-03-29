import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDetectedPlanFile, findLatestPlanFile } from "../../src/claude/planFile";

describe("findLatestPlanFile", () => {
    const plansDir = join(tmpdir(), "codesymphony-claude-provider", "plans");
    const testFile = join(plansDir, "__vitest_plan_test__.md");
    const persistedFile = join(plansDir, "__vitest_persisted_plan_test__.md");

    beforeEach(() => {
        // Ensure plans dir exists
        mkdirSync(plansDir, { recursive: true });
    });

    afterEach(() => {
        // Clean up test files
        if (existsSync(testFile)) {
            rmSync(testFile);
        }
        if (existsSync(persistedFile)) {
            rmSync(persistedFile);
        }
    });

    it("returns null when no plan files exist after timestamp", () => {
        const result = findLatestPlanFile(Date.now() + 100000);
        expect(result).toBeNull();
    });

    it("finds a plan file modified after the given timestamp", () => {
        const beforeTimestamp = Date.now() - 1000;
        writeFileSync(testFile, "# Test Plan\nSome content");

        const result = findLatestPlanFile(beforeTimestamp);
        if (result && result.filePath === testFile) {
            expect(result.content).toContain("# Test Plan");
        }
        // If other plan files exist, that's OK — we just check it's not null
        expect(result).not.toBeNull();
    });

    it("ignores empty plan files", () => {
        const beforeTimestamp = Date.now() - 1000;
        writeFileSync(testFile, "   ");

        // findLatestPlanFile should skip empty files
        // but other plan files may exist, so we can't assert null
        const result = findLatestPlanFile(beforeTimestamp);
        if (result) {
            expect(result.filePath).not.toBe(testFile);
        }
    });

    it("prefers persisted plan files before scanning directories", () => {
        const beforeTimestamp = Date.now() - 1000;
        writeFileSync(testFile, "# Scanned Plan");
        writeFileSync(persistedFile, "# Persisted Plan");

        const result = findDetectedPlanFile([persistedFile], beforeTimestamp);
        expect(result).toEqual({
            filePath: persistedFile,
            content: "# Persisted Plan",
        });
    });

    it("returns null when no persisted or scanned plans exist", () => {
        const result = findDetectedPlanFile([], Date.now() + 100000);
        expect(result).toBeNull();
    });
});
