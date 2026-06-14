import { describe, expect, it } from "vitest";
import {
  armPhantomBackspaceGuard,
  evaluatePhantomBackspace,
  resolveComposedTerminalInput,
  shouldSuppressPostCommitInput,
  summarizeTerminalData,
  TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS,
} from "./terminalDiagnostics.js";

describe("resolveComposedTerminalInput", () => {
  it("prefers textarea value at compositionend over event data", () => {
    expect(resolveComposedTerminalInput("final", "stale", "tracked")).toBe("stale");
    expect(resolveComposedTerminalInput("abcde", "abcdef", "abc")).toBe("abcdef");
  });

  it("uses compositionend event data when textarea was cleared", () => {
    expect(resolveComposedTerminalInput("final", "", "tracked")).toBe("final");
  });

  it("respects shortened IME text left in textarea after backspacing", () => {
    expect(resolveComposedTerminalInput("", "a", "ab")).toBe("a");
    expect(resolveComposedTerminalInput("", "hi", "hello")).toBe("hi");
  });

  it("falls back to last tracked value when textarea was cleared", () => {
    expect(resolveComposedTerminalInput("", "", "gitu")).toBe("gitu");
  });
});

describe("phantom backspace guard", () => {
  it("exposes a positive suppression window", () => {
    expect(TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS).toBeGreaterThan(0);
  });

  it("arms a budget equal to the committed code point length", () => {
    const guard = armPhantomBackspaceGuard(4, 1_000);
    expect(guard.remaining).toBe(4);
    expect(guard.expiresAt).toBe(1_000 + TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS);
  });

  it("does not arm when nothing was committed", () => {
    const guard = armPhantomBackspaceGuard(0, 1_000);
    expect(guard.remaining).toBe(0);
    const result = evaluatePhantomBackspace(guard, 1_010);
    expect(result.suppress).toBe(false);
  });

  it("suppresses phantom backspaces within budget and window", () => {
    let guard = armPhantomBackspaceGuard(4, 1_000);

    const first = evaluatePhantomBackspace(guard, 1_005);
    expect(first.suppress).toBe(true);
    expect(first.guard.remaining).toBe(3);

    const second = evaluatePhantomBackspace(first.guard, 1_010);
    expect(second.suppress).toBe(true);
    expect(second.guard.remaining).toBe(2);
    guard = second.guard;

    expect(guard.remaining).toBe(2);
  });

  it("stops suppressing once the budget is exhausted", () => {
    let result = { suppress: false, guard: armPhantomBackspaceGuard(2, 1_000) };
    result = evaluatePhantomBackspace(result.guard, 1_001);
    result = evaluatePhantomBackspace(result.guard, 1_002);
    expect(result.suppress).toBe(true);

    const beyond = evaluatePhantomBackspace(result.guard, 1_003);
    expect(beyond.suppress).toBe(false);
    expect(beyond.guard.remaining).toBe(0);
  });

  it("stops suppressing after the window expires", () => {
    const guard = armPhantomBackspaceGuard(4, 1_000);
    const expired = evaluatePhantomBackspace(
      guard,
      1_000 + TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS + 1,
    );
    expect(expired.suppress).toBe(false);
    expect(expired.guard.remaining).toBe(0);
  });
});

describe("shouldSuppressPostCommitInput", () => {
  it("does not suppress when the dedup window is inactive", () => {
    expect(shouldSuppressPostCommitInput(false, "make", "make")).toBe(false);
  });

  it("suppresses the exact duplicate echo of the committed text", () => {
    expect(shouldSuppressPostCommitInput(true, "make", "make")).toBe(true);
  });

  it("lets genuinely new input through (the space after a committed word)", () => {
    // Regression: " " arriving ~5ms after committing "make" must NOT be eaten,
    // otherwise "make dev" collapses to "makedev".
    expect(shouldSuppressPostCommitInput(true, "make", " ")).toBe(false);
  });

  it("lets the next word's first character through", () => {
    expect(shouldSuppressPostCommitInput(true, "make", "d")).toBe(false);
  });

  it("does not suppress when there is no committed original", () => {
    expect(shouldSuppressPostCommitInput(true, null, "make")).toBe(false);
    expect(shouldSuppressPostCommitInput(true, "", "make")).toBe(false);
  });

  it("does not suppress empty or absent incoming data", () => {
    expect(shouldSuppressPostCommitInput(true, "make", "")).toBe(false);
    expect(shouldSuppressPostCommitInput(true, "make", null)).toBe(false);
  });
});

describe("terminal diagnostics", () => {
  it("summarizes printable terminal data without storing typed content", () => {
    const summary = summarizeTerminalData("secret-token");

    expect(summary).toMatchObject({
      kind: "printable",
      byteLength: 12,
      utf16Length: 12,
      codePointLength: 12,
      controlCount: 0,
      escapeCount: 0,
      printableAsciiCount: 12,
    });
    expect(JSON.stringify(summary)).not.toContain("secret-token");
  });

  it("identifies control and escape input without raw bytes", () => {
    expect(summarizeTerminalData("\u0003")).toMatchObject({
      kind: "control",
      byteLength: 1,
      controlCount: 1,
      firstControl: "ETX",
    });

    expect(summarizeTerminalData("\u001b[A")).toMatchObject({
      kind: "escape-sequence",
      byteLength: 3,
      controlCount: 1,
      escapeCount: 1,
      firstControl: "ESC",
      hasAnsiEscape: true,
      startsWithEscape: true,
    });
  });

  it("summarizes paste-shaped and unicode data by shape only", () => {
    const summary = summarizeTerminalData("a\nβ");

    expect(summary).toMatchObject({
      kind: "paste",
      byteLength: 4,
      utf16Length: 3,
      codePointLength: 3,
      lineBreakCount: 1,
      controlCount: 1,
      unicodePrintableCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("β");
  });
});
