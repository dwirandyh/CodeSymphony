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

  const widthScale = input.containerWidth / input.renderedWidth;
  const heightScale = input.containerHeight / input.renderedHeight;
  const scale = Math.min(widthScale, heightScale, 1);

  if (scale >= 1) {
    return baseFontSize;
  }

  return Math.max(minFontSize, Math.floor(baseFontSize * scale));
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