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
 * Decide whether a post-commit input event is the duplicate echo of the text
 * we already sent at compositionend — and therefore safe to drop.
 *
 * Background: after an IME composition commit we send the composed word to the
 * PTY ourselves, then arm a short dedup window in case xterm's own onData fires
 * the *same* text again. The Android `input` handler used to blanket-clear the
 * textarea for ANY input while that window was active, which also ate the very
 * next keystroke — the space after the word — collapsing "make dev" into
 * "makedev"/"make dev" depending on timing.
 *
 * Only suppress when the incoming data is the exact committed string. Genuinely
 * new input (a space, the next word's first letter) must pass through.
 */
export function shouldSuppressPostCommitInput(
  dedupActive: boolean,
  originalData: string | null | undefined,
  incomingData: string | null | undefined,
): boolean {
  if (!dedupActive) {
    return false;
  }
  if (!originalData || !incomingData) {
    return false;
  }
  return incomingData === originalData;
}

/**
 * Window after an IME composition commit during which spurious `Backspace`
 * keydowns are treated as phantom and dropped.
 *
 * Android soft keyboards (Gboard) commit a composed word, then — because our
 * compositionend handler sends the text and clears the textarea out from under
 * the IME — emit a short burst of `Backspace`/`deleteContentBackward` events to
 * reconcile their internal model against the now-empty field. Those phantom
 * deletes reach the PTY as `\x7f` and erase the word the user just typed
 * (symptom: "make " becomes "" or loses characters). The window must be long
 * enough to cover the reconciliation burst but short enough that a deliberate
 * backspace a beat later still passes through.
 */
export const TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS = 250;

export type PhantomBackspaceGuard = {
  /** Remaining phantom backspaces that may still be suppressed. */
  remaining: number;
  /** Timestamp (ms, same clock as evaluate) after which the guard is inert. */
  expiresAt: number;
};

export type PhantomBackspaceDecision = {
  suppress: boolean;
  guard: PhantomBackspaceGuard;
};

const INERT_PHANTOM_BACKSPACE_GUARD: PhantomBackspaceGuard = {
  remaining: 0,
  expiresAt: 0,
};

/**
 * Arm the phantom-backspace guard after a composition commit.
 *
 * @param committedCodePointLength number of code points just committed to the
 *   PTY — the maximum number of phantom backspaces the IME can emit to undo it.
 * @param now monotonic-ish timestamp in ms (e.g. `performance.now()`).
 */
export function armPhantomBackspaceGuard(
  committedCodePointLength: number,
  now: number,
): PhantomBackspaceGuard {
  if (committedCodePointLength <= 0) {
    return { ...INERT_PHANTOM_BACKSPACE_GUARD };
  }

  return {
    remaining: committedCodePointLength,
    expiresAt: now + TERMINAL_IME_PHANTOM_BACKSPACE_WINDOW_MS,
  };
}

/**
 * Decide whether a `Backspace` keydown is a phantom IME reconciliation delete.
 *
 * Returns the suppression decision plus the next guard state (decremented when
 * suppressing, cleared once the budget is spent or the window has elapsed).
 * Pure: the caller owns the guard between calls.
 */
export function evaluatePhantomBackspace(
  guard: PhantomBackspaceGuard,
  now: number,
): PhantomBackspaceDecision {
  if (guard.remaining <= 0) {
    return { suppress: false, guard: { ...INERT_PHANTOM_BACKSPACE_GUARD } };
  }

  if (now > guard.expiresAt) {
    return { suppress: false, guard: { ...INERT_PHANTOM_BACKSPACE_GUARD } };
  }

  const remaining = guard.remaining - 1;
  return {
    suppress: true,
    guard: remaining > 0
      ? { remaining, expiresAt: guard.expiresAt }
      : { ...INERT_PHANTOM_BACKSPACE_GUARD },
  };
}

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
