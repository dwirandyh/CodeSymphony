import { describe, it, expect } from "vitest";
import {
  splitAtFirstSentenceBoundary,
  splitAtContentBoundary,
  hasSentenceBoundary,
  isSentenceAwareInlineInsertKind,
  shouldDelayFirstInlineInsert,
} from "./textUtils";

describe("splitAtFirstSentenceBoundary", () => {
  it("returns null for empty string", () => {
    expect(splitAtFirstSentenceBoundary("")).toBeNull();
  });

  it("returns null when no sentence boundary found", () => {
    expect(splitAtFirstSentenceBoundary("hello world")).toBeNull();
  });

  it("splits at period followed by space", () => {
    const result = splitAtFirstSentenceBoundary("Hello world. This is a test.");
    expect(result).toEqual({ head: "Hello world. ", tail: "This is a test." });
  });

  it("splits at exclamation mark", () => {
    const result = splitAtFirstSentenceBoundary("Wow! That is great.");
    expect(result).toEqual({ head: "Wow! ", tail: "That is great." });
  });

  it("splits at question mark", () => {
    const result = splitAtFirstSentenceBoundary("Really? Yes indeed.");
    expect(result).toEqual({ head: "Really? ", tail: "Yes indeed." });
  });

  it("splits at period followed by capital letter", () => {
    const result = splitAtFirstSentenceBoundary("Done.Next step");
    expect(result).toEqual({ head: "Done.", tail: "Next step" });
  });

  it("splits at period with closing quote", () => {
    const result = splitAtFirstSentenceBoundary('He said "hello." Then left.');
    expect(result).toEqual({ head: 'He said "hello." ', tail: "Then left." });
  });
});

describe("splitAtContentBoundary", () => {
  it("returns null for empty string", () => {
    expect(splitAtContentBoundary("")).toBeNull();
  });

  it("splits at colon followed by capital letter", () => {
    const result = splitAtContentBoundary("Summary: The project is done.");
    expect(result).toEqual({ head: "Summary: ", tail: "The project is done." });
  });

  it("falls back to sentence boundary when no colon boundary", () => {
    const result = splitAtContentBoundary("Hello world. This is a test.");
    expect(result).toEqual({ head: "Hello world. ", tail: "This is a test." });
  });

  it("returns null when no boundary found", () => {
    expect(splitAtContentBoundary("hello world")).toBeNull();
  });
});

describe("hasSentenceBoundary", () => {
  it("returns false for empty string", () => {
    expect(hasSentenceBoundary("")).toBe(false);
  });

  it("returns true when sentence boundary exists", () => {
    expect(hasSentenceBoundary("Hello. World")).toBe(true);
  });

  it("returns false when no sentence boundary", () => {
    expect(hasSentenceBoundary("hello world")).toBe(false);
  });
});

describe("isSentenceAwareInlineInsertKind", () => {
  it("returns true for explore-activity", () => {
    expect(isSentenceAwareInlineInsertKind("explore-activity")).toBe(true);
  });

  it("returns true for edited", () => {
    expect(isSentenceAwareInlineInsertKind("edited")).toBe(true);
  });

  it("returns true for bash", () => {
    expect(isSentenceAwareInlineInsertKind("bash")).toBe(true);
  });

  it("returns true for subagent-activity", () => {
    expect(isSentenceAwareInlineInsertKind("subagent-activity")).toBe(true);
  });

  it("returns false for other kinds", () => {
    expect(isSentenceAwareInlineInsertKind("unknown")).toBe(false);
    expect(isSentenceAwareInlineInsertKind(null)).toBe(false);
  });
});

describe("shouldDelayFirstInlineInsert", () => {
  it("returns false for non-sentence-aware kind", () => {
    expect(shouldDelayFirstInlineInsert("other", "Hello world", true)).toBe(false);
  });

  it("returns false when no trailing text", () => {
    expect(shouldDelayFirstInlineInsert("bash", "Hello.", false)).toBe(false);
  });

  it("returns false for empty leading content", () => {
    expect(shouldDelayFirstInlineInsert("bash", "", true)).toBe(false);
  });

  it("returns false when leading content has sentence boundary", () => {
    expect(shouldDelayFirstInlineInsert("bash", "Done. ", true)).toBe(false);
  });

  it("returns true when all conditions met and no sentence boundary", () => {
    expect(shouldDelayFirstInlineInsert("bash", "Working on the task", true)).toBe(true);
  });
});
