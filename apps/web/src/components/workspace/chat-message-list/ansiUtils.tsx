import { memo } from "react";
import type { AnsiSegment, AnsiStyleState } from "./ChatMessageList.types";

const ANSI_ESCAPE_REGEX = /\u001b\[([0-9;]*)m/g;

const ANSI_BASIC_FG_COLORS: Record<number, string> = {
  30: "#282c34",
  31: "#e06c75",
  32: "#98c379",
  33: "#e5c07b",
  34: "#61afef",
  35: "#c678dd",
  36: "#56b6c2",
  37: "#dcdfe4",
  90: "#5c6370",
  91: "#f44747",
  92: "#89d185",
  93: "#f2cc60",
  94: "#7aa2f7",
  95: "#d299ff",
  96: "#4fd6be",
  97: "#ffffff",
};

const ANSI_COLOR_LEVELS = [0, 95, 135, 175, 215, 255];

export function ansi256ToColor(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    return null;
  }

  if (code < 16) {
    const mappedCode = code < 8 ? 30 + code : 90 + (code - 8);
    return ANSI_BASIC_FG_COLORS[mappedCode] ?? null;
  }

  if (code <= 231) {
    const cube = code - 16;
    const r = ANSI_COLOR_LEVELS[Math.floor(cube / 36) % 6];
    const g = ANSI_COLOR_LEVELS[Math.floor(cube / 6) % 6];
    const b = ANSI_COLOR_LEVELS[cube % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }

  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

export function applyAnsiCodes(state: AnsiStyleState, rawCodes: number[]): AnsiStyleState {
  const nextState: AnsiStyleState = { ...state };
  const codes = rawCodes.length > 0 ? rawCodes : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!Number.isFinite(code)) {
      continue;
    }

    if (code === 0) {
      nextState.fgColor = null;
      nextState.bold = false;
      nextState.dim = false;
      continue;
    }

    if (code === 1) {
      nextState.bold = true;
      continue;
    }

    if (code === 2) {
      nextState.dim = true;
      continue;
    }

    if (code === 22) {
      nextState.bold = false;
      nextState.dim = false;
      continue;
    }

    if (code === 39) {
      nextState.fgColor = null;
      continue;
    }

    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      nextState.fgColor = ANSI_BASIC_FG_COLORS[code] ?? null;
      continue;
    }

    if (code === 38) {
      const mode = codes[index + 1];
      if (mode === 5) {
        const paletteCode = codes[index + 2];
        const paletteColor = ansi256ToColor(paletteCode);
        if (paletteColor) {
          nextState.fgColor = paletteColor;
        }
        index += 2;
        continue;
      }

      if (mode === 2) {
        const r = codes[index + 2];
        const g = codes[index + 3];
        const b = codes[index + 4];
        if ([r, g, b].every((entry) => Number.isFinite(entry))) {
          nextState.fgColor = `rgb(${r}, ${g}, ${b})`;
        }
        index += 4;
      }
    }
  }

  return nextState;
}

export function toAnsiSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  ANSI_ESCAPE_REGEX.lastIndex = 0;
  let state: AnsiStyleState = {
    fgColor: null,
    bold: false,
    dim: false,
  };
  let cursor = 0;

  while (true) {
    const match = ANSI_ESCAPE_REGEX.exec(input);
    if (!match) {
      break;
    }

    if (match.index > cursor) {
      segments.push({
        text: input.slice(cursor, match.index),
        fgColor: state.fgColor,
        bold: state.bold,
        dim: state.dim,
      });
    }

    const rawCodes = match[1]
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => Number(entry));
    state = applyAnsiCodes(state, rawCodes);
    cursor = ANSI_ESCAPE_REGEX.lastIndex;
  }

  if (cursor < input.length) {
    segments.push({
      text: input.slice(cursor),
      fgColor: state.fgColor,
      bold: state.bold,
      dim: state.dim,
    });
  }

  return segments.length > 0
    ? segments
    : [
      {
        text: input,
        fgColor: null,
        bold: false,
        dim: false,
      },
    ];
}

export const TerminalOutputPre = memo(function TerminalOutputPre({ text, className }: { text: string; className: string }) {
  const segments = toAnsiSegments(text);

  return (
    <pre className={className}>
      {segments.map((segment, index) => (
        <span
          key={`${index}:${segment.text.length}`}
          style={{
            color: segment.fgColor ?? undefined,
            fontWeight: segment.bold ? 600 : undefined,
            opacity: segment.dim ? 0.78 : undefined,
          }}
        >
          {segment.text}
        </span>
      ))}
    </pre>
  );
});
