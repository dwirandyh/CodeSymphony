import { describe, expect, it } from "vitest";

// Import from current location via __testing until extraction
// After extraction these will import from src/claude/sanitize
import { truncateForPreview, sanitizeForLog, toIso } from "../../src/claude/sanitize";

describe("truncateForPreview", () => {
    it("returns short strings unchanged", () => {
        expect(truncateForPreview("hello")).toBe("hello");
    });

    it("truncates strings exceeding 500 chars", () => {
        const long = "x".repeat(600);
        const result = truncateForPreview(long);
        expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
        expect(result).toMatch(/\.\.\.$/);
    });

    it("returns exactly 500-char strings unchanged", () => {
        const exact = "a".repeat(500);
        expect(truncateForPreview(exact)).toBe(exact);
    });

    it("handles empty string", () => {
        expect(truncateForPreview("")).toBe("");
    });
});

describe("sanitizeForLog", () => {
    it("passes through null/undefined/numbers/booleans", () => {
        expect(sanitizeForLog(null)).toBeNull();
        expect(sanitizeForLog(undefined)).toBeUndefined();
        expect(sanitizeForLog(42)).toBe(42);
        expect(sanitizeForLog(true)).toBe(true);
    });

    it("redacts sensitive keys", () => {
        const result = sanitizeForLog({
            apiKey: "secret-val",
            token: "my-token",
            password: "p@ss",
            authorization: "Bearer xyz",
            cookie: "session=abc",
        }) as Record<string, unknown>;

        expect(result.apiKey).toBe("[REDACTED]");
        expect(result.token).toBe("[REDACTED]");
        expect(result.password).toBe("[REDACTED]");
        expect(result.authorization).toBe("[REDACTED]");
        expect(result.cookie).toBe("[REDACTED]");
    });

    it("redacts string values with sensitive key hints", () => {
        expect(sanitizeForLog("my-secret", 0, "api_key")).toBe("[REDACTED]");
    });

    it("truncates long strings", () => {
        const long = "a".repeat(600);
        const result = sanitizeForLog(long) as string;
        expect(result.length).toBeLessThanOrEqual(503);
    });

    it("truncates deeply nested objects", () => {
        let obj: Record<string, unknown> = { value: "leaf" };
        for (let i = 0; i < 10; i++) {
            obj = { nested: obj };
        }
        const result = sanitizeForLog(obj) as Record<string, unknown>;
        // Should eventually hit [TruncatedDepth]
        let current: unknown = result;
        let depth = 0;
        while (typeof current === "object" && current !== null && depth < 20) {
            const rec = current as Record<string, unknown>;
            if (rec.nested) {
                current = rec.nested;
                depth++;
            } else if (rec.value) {
                current = rec.value;
                depth++;
            } else {
                break;
            }
        }
        expect(current).toBe("[TruncatedDepth]");
    });

    it("truncates arrays beyond 20 items", () => {
        const arr = Array.from({ length: 30 }, (_, i) => `item-${i}`);
        const result = sanitizeForLog(arr) as unknown[];
        expect(result.length).toBe(21); // 20 items + "+10 more" marker
        expect(result[20]).toBe("[+10 more]");
    });

    it("truncates object keys beyond 30", () => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < 40; i++) {
            obj[`key_${i.toString().padStart(3, "0")}`] = i;
        }
        const result = sanitizeForLog(obj) as Record<string, unknown>;
        expect(result.__truncatedKeys).toBe(10);
    });

    it("handles non-object non-primitive types via String()", () => {
        const sym = Symbol("test");
        expect(sanitizeForLog(sym)).toBe(String(sym));
    });
});

describe("toIso", () => {
    it("converts timestamp to ISO string", () => {
        const ts = 1700000000000;
        expect(toIso(ts)).toBe(new Date(ts).toISOString());
    });
});
