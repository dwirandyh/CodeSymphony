import { describe, expect, it } from "vitest";
import {
  computeRemoteTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  hasRemoteTerminalGeometry,
  MIN_REMOTE_TERMINAL_FONT_SIZE,
} from "./terminalRemoteViewportFit";

describe("computeRemoteTerminalFontSize", () => {
  it("keeps the base font size when the PTY canvas already fits", () => {
    expect(computeRemoteTerminalFontSize({
      containerWidth: 960,
      containerHeight: 540,
      renderedWidth: 900,
      renderedHeight: 520,
    })).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("scales down proportionally to the tighter container axis", () => {
    expect(computeRemoteTerminalFontSize({
      containerWidth: 390,
      containerHeight: 700,
      renderedWidth: 780,
      renderedHeight: 520,
      baseFontSize: 13,
    })).toBe(6);
  });

  it("never scales below the remote minimum font size", () => {
    expect(computeRemoteTerminalFontSize({
      containerWidth: 120,
      containerHeight: 200,
      renderedWidth: 960,
      renderedHeight: 540,
      baseFontSize: 13,
    })).toBe(MIN_REMOTE_TERMINAL_FONT_SIZE);
  });

  it("returns the base font size for invalid measurements", () => {
    expect(computeRemoteTerminalFontSize({
      containerWidth: 0,
      containerHeight: 540,
      renderedWidth: 900,
      renderedHeight: 520,
    })).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });
});

describe("hasRemoteTerminalGeometry", () => {
  it("accepts valid PTY geometry", () => {
    expect(hasRemoteTerminalGeometry(120, 40)).toBe(true);
  });

  it("rejects missing or undersized geometry", () => {
    expect(hasRemoteTerminalGeometry(null, 40)).toBe(false);
    expect(hasRemoteTerminalGeometry(120, 1)).toBe(false);
  });
});