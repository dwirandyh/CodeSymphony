export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_REMOTE_TERMINAL_FONT_SIZE = 6;

export type RemoteTerminalFontSizeInput = {
  containerWidth: number;
  containerHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  baseFontSize?: number;
  minFontSize?: number;
};

export function computeRemoteTerminalFontSize(input: RemoteTerminalFontSizeInput): number {
  const baseFontSize = input.baseFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
  const minFontSize = input.minFontSize ?? MIN_REMOTE_TERMINAL_FONT_SIZE;

  if (
    input.containerWidth < 2
    || input.containerHeight < 2
    || input.renderedWidth < 2
    || input.renderedHeight < 2
  ) {
    return baseFontSize;
  }

  // Width-only fit, always. Font is the single lever for the monospace grid, so
  // sizing it to width keeps the terminal full width in every state. A shorter
  // container (mobile keyboard shown) must NOT shrink the font: that scales the
  // grid uniformly and narrows the width too. Height is handled separately by a
  // CSS scaleY squash (computeRemoteTerminalVerticalSquash) for non-scrollable
  // alt-screen TUIs, and by vertical scroll for normal-buffer output.
  const widthScale = input.containerWidth / input.renderedWidth;
  const scale = Math.min(widthScale, 1);

  if (scale >= 1) {
    return baseFontSize;
  }

  return Math.max(minFontSize, Math.floor(baseFontSize * scale));
}

// Vertical squash for non-scrollable alt-screen TUIs (vim, opencode). The font
// is sized to width (full width always), so a tall fixed grid overflows a short
// container when the keyboard is shown. The grid cannot scroll, so we compress
// it vertically with a CSS transform: scaleY(...) instead of shrinking the font
// (which would narrow the width). Returns a factor in (0, 1]: 1 means the grid
// already fits and no squash is needed.
export function computeRemoteTerminalVerticalSquash(input: {
  containerHeight: number;
  renderedHeight: number;
}): number {
  if (input.containerHeight < 2 || input.renderedHeight < 2) {
    return 1;
  }
  return Math.min(input.containerHeight / input.renderedHeight, 1);
}

export function hasRemoteTerminalGeometry(
  cols: number | null | undefined,
  rows: number | null | undefined,
): cols is number {
  return typeof cols === "number"
    && typeof rows === "number"
    && cols >= 2
    && rows >= 2;
}

export function resolveRemoteTerminalGeometry(
  cols: number | null | undefined,
  rows: number | null | undefined,
): { cols: number; rows: number } | null {
  if (
    typeof cols !== "number"
    || typeof rows !== "number"
    || cols < 2
    || rows < 2
  ) {
    return null;
  }

  return { cols, rows };
}