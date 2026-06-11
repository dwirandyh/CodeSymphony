export type TerminalDataKind =
  | "empty"
  | "printable"
  | "control"
  | "escape-sequence"
  | "paste"
  | "mixed";

export type TerminalDataSummary = {
  kind: TerminalDataKind;
  byteLength: number;
  utf16Length: number;
  codePointLength: number;
  lineBreakCount: number;
  controlCount: number;
  escapeCount: number;
  printableAsciiCount: number;
  unicodePrintableCount: number;
  hasAnsiEscape: boolean;
  startsWithEscape: boolean;
  firstControl: string | null;
};

const CONTROL_NAMES = [
  "NUL",
  "SOH",
  "STX",
  "ETX",
  "EOT",
  "ENQ",
  "ACK",
  "BEL",
  "BS",
  "HT",
  "LF",
  "VT",
  "FF",
  "CR",
  "SO",
  "SI",
  "DLE",
  "DC1",
  "DC2",
  "DC3",
  "DC4",
  "NAK",
  "SYN",
  "ETB",
  "CAN",
  "EM",
  "SUB",
  "ESC",
  "FS",
  "GS",
  "RS",
  "US",
] as const;

function getUtf8ByteLength(data: string): number {
  let byteLength = 0;
  for (const char of data) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      byteLength += 1;
    } else if (codePoint <= 0x7ff) {
      byteLength += 2;
    } else if (codePoint <= 0xffff) {
      byteLength += 3;
    } else {
      byteLength += 4;
    }
  }
  return byteLength;
}

function getControlName(codePoint: number): string | null {
  if (codePoint >= 0 && codePoint < CONTROL_NAMES.length) {
    return CONTROL_NAMES[codePoint];
  }
  if (codePoint === 0x7f) {
    return "DEL";
  }
  if (codePoint >= 0x80 && codePoint <= 0x9f) {
    return "C1";
  }
  return null;
}

function countLineBreaks(data: string): number {
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === "\r") {
      count += 1;
      if (data[index + 1] === "\n") {
        index += 1;
      }
    } else if (char === "\n") {
      count += 1;
    }
  }
  return count;
}

function hasAnsiEscapeSequence(data: string): boolean {
  return /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/u.test(data);
}

function resolveTerminalDataKind(summary: Omit<TerminalDataSummary, "kind">): TerminalDataKind {
  if (summary.codePointLength === 0) {
    return "empty";
  }
  if (summary.startsWithEscape && summary.hasAnsiEscape) {
    return "escape-sequence";
  }
  if (summary.lineBreakCount > 0 || summary.codePointLength > 64) {
    return "paste";
  }
  if (summary.controlCount === summary.codePointLength) {
    return "control";
  }
  if (summary.controlCount > 0 || summary.escapeCount > 0) {
    return "mixed";
  }
  return "printable";
}

/** Window after compositionend where duplicate xterm onData is suppressed. */
export const TERMINAL_IME_DEDUP_WINDOW_MS = 50;

/**
 * Resolve final IME text at compositionend.
 *
 * Priority:
 * 1. textarea value when still present (final committed surface)
 * 2. compositionend `event.data`
 * 3. last tracked snapshot (xterm cleared textarea before compositionend)
 */
export function resolveComposedTerminalInput(
  compositionData: string,
  textareaValue: string,
  lastTrackedValue: string,
): string {
  if (textareaValue.length > 0) {
    return textareaValue;
  }

  if (compositionData.length > 0) {
    return compositionData;
  }

  return lastTrackedValue;
}

export function summarizeTerminalData(data: string): TerminalDataSummary {
  let codePointLength = 0;
  let controlCount = 0;
  let escapeCount = 0;
  let printableAsciiCount = 0;
  let unicodePrintableCount = 0;
  let firstControl: string | null = null;

  for (const char of data) {
    codePointLength += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    const controlName = getControlName(codePoint);
    if (controlName) {
      controlCount += 1;
      if (controlName === "ESC") {
        escapeCount += 1;
      }
      firstControl ??= controlName;
      continue;
    }

    if (codePoint >= 0x20 && codePoint <= 0x7e) {
      printableAsciiCount += 1;
    } else {
      unicodePrintableCount += 1;
    }
  }

  const summary = {
    byteLength: getUtf8ByteLength(data),
    utf16Length: data.length,
    codePointLength,
    lineBreakCount: countLineBreaks(data),
    controlCount,
    escapeCount,
    printableAsciiCount,
    unicodePrintableCount,
    hasAnsiEscape: hasAnsiEscapeSequence(data),
    startsWithEscape: data.startsWith("\u001b"),
    firstControl,
  };

  return {
    kind: resolveTerminalDataKind(summary),
    ...summary,
  };
}
