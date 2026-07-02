import { describe, expect, it } from "vitest";
import {
  computeRemoteTerminalFontSize,
  computeRemoteTerminalVerticalSquash,
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

  it("keeps the font size stable when only container height shrinks (keyboard shown)", () => {
    const widthBound = {
      containerWidth: 390,
      renderedWidth: 780,
      renderedHeight: 300,
      baseFontSize: 26,
    };
    const keyboardHidden = computeRemoteTerminalFontSize({
      ...widthBound,
      containerHeight: 700,
    });
    const keyboardShown = computeRemoteTerminalFontSize({
      ...widthBound,
      containerHeight: 120,
    });
    expect(keyboardShown).toBe(keyboardHidden);
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

describe("computeRemoteTerminalVerticalSquash", () => {
  it("returns 1 when the grid already fits the container height", () => {
    expect(computeRemoteTerminalVerticalSquash({
      containerHeight: 600,
      renderedHeight: 360,
    })).toBe(1);
  });

  it("squashes a tall non-scrollable TUI to fit a short container (keyboard shown)", () => {
    // Width-only font keeps full width but leaves the grid 600px tall; the short
    // 280px container can't scroll an alt-screen TUI, so scaleY compresses it.
    expect(computeRemoteTerminalVerticalSquash({
      containerHeight: 280,
      renderedHeight: 600,
    })).toBeCloseTo(280 / 600, 5);
  });

  it("never returns a factor above 1 (no vertical stretch)", () => {
    expect(computeRemoteTerminalVerticalSquash({
      containerHeight: 800,
      renderedHeight: 360,
    })).toBe(1);
  });

  it("returns 1 for invalid measurements", () => {
    expect(computeRemoteTerminalVerticalSquash({
      containerHeight: 0,
      renderedHeight: 360,
    })).toBe(1);
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