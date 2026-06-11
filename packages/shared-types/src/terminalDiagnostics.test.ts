import { describe, expect, it } from "vitest";
import { resolveComposedTerminalInput, summarizeTerminalData } from "./terminalDiagnostics.js";

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
