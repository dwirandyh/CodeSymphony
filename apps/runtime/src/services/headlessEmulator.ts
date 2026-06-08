/**
 * Server-side headless terminal emulator.
 *
 * Wraps `@xterm/headless` so the runtime keeps an authoritative model of every
 * PTY session's screen state. Two jobs:
 *
 * 1. Answer terminal capability queries (DA1/DSR/etc). xterm generates the
 *    protocol replies via `onData`; the terminal service forwards them straight
 *    back into the PTY. This is the fix for full-screen TUIs (opencode, vim)
 *    that block on a query reply before painting — without a responder they
 *    stall until their internal timeout (the "stuck until refresh" bug).
 * 2. Produce a snapshot (serialized screen + input-affecting modes + cwd) so a
 *    reattaching client restores deterministically instead of sniffing raw
 *    scrollback bytes.
 *
 * Ported from superset's HeadlessEmulator, trimmed to what the runtime needs.
 */

import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

const ESC = "\x1b";
const BEL = "\x07";

const DEFAULT_SCROLLBACK = 5000;

/**
 * Terminal modes that affect input behavior and must be restored on attach.
 * These correspond to DECSET/DECRST (CSI ? Pm h/l) escape sequences.
 */
export interface TerminalModes {
  applicationCursorKeys: boolean;
  bracketedPaste: boolean;
  mouseTrackingX10: boolean;
  mouseTrackingNormal: boolean;
  mouseTrackingHighlight: boolean;
  mouseTrackingButtonEvent: boolean;
  mouseTrackingAnyEvent: boolean;
  focusReporting: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
  alternateScreen: boolean;
  cursorVisible: boolean;
  originMode: boolean;
  autoWrap: boolean;
}

export const DEFAULT_MODES: TerminalModes = {
  applicationCursorKeys: false,
  bracketedPaste: false,
  mouseTrackingX10: false,
  mouseTrackingNormal: false,
  mouseTrackingHighlight: false,
  mouseTrackingButtonEvent: false,
  mouseTrackingAnyEvent: false,
  focusReporting: false,
  mouseUtf8: false,
  mouseSgr: false,
  alternateScreen: false,
  cursorVisible: true,
  originMode: false,
  autoWrap: true,
};

export interface TerminalSnapshot {
  /** Serialized screen state (ANSI sequences to reproduce the screen). */
  snapshotAnsi: string;
  /** Control sequences to restore input-affecting modes. */
  rehydrateSequences: string;
  /** Current working directory (from OSC-7, may be null). */
  cwd: string | null;
  /** Current terminal modes. */
  modes: TerminalModes;
  cols: number;
  rows: number;
}

/** DECSET/DECRST mode numbers we track → TerminalModes keys. */
const MODE_MAP: Record<number, keyof TerminalModes> = {
  1: "applicationCursorKeys",
  6: "originMode",
  7: "autoWrap",
  9: "mouseTrackingX10",
  25: "cursorVisible",
  47: "alternateScreen", // Legacy alternate screen
  1000: "mouseTrackingNormal",
  1001: "mouseTrackingHighlight",
  1002: "mouseTrackingButtonEvent",
  1003: "mouseTrackingAnyEvent",
  1004: "focusReporting",
  1005: "mouseUtf8",
  1006: "mouseSgr",
  1049: "alternateScreen", // Modern alternate screen with save/restore
  2004: "bracketedPaste",
};

export interface HeadlessEmulatorOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  /** Foreground color reported to OSC 10 queries, as "#rrggbb". */
  foreground?: string;
  /** Background color reported to OSC 11 queries, as "#rrggbb". */
  background?: string;
}

// Terminal theme colors used to answer OSC 10/11 color queries. These mirror
// the web client's XTERM_THEME so a TUI that adapts to terminal colors sees a
// consistent dark background.
const DEFAULT_FOREGROUND = "#d4d8e0";
const DEFAULT_BACKGROUND = "#0f1218";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Convert "#rrggbb" to the xterm OSC color reply form "rgb:rrrr/gggg/bbbb"
// (16-bit channels, each byte duplicated, matching real terminal replies).
function toOscColorSpec(hex: string): string {
  const normalized = hex.replace(/^#/, "");
  const r = normalized.slice(0, 2) || "00";
  const g = normalized.slice(2, 4) || "00";
  const b = normalized.slice(4, 6) || "00";
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

export class HeadlessEmulator {
  private terminal: Terminal;
  private serializeAddon: SerializeAddon;
  private modes: TerminalModes;
  private cwd: string | null = null;
  private disposed = false;
  private onDataCallback?: (data: string) => void;
  private readonly foreground: string;
  private readonly background: string;
  /** Buffer for partial escape sequences that span write boundaries. */
  private escapeSequenceBuffer = "";
  private static readonly MAX_ESCAPE_BUFFER_SIZE = 1024;

  constructor(options: HeadlessEmulatorOptions = {}) {
    const { cols = 80, rows = 24, scrollback = DEFAULT_SCROLLBACK } = options;
    this.foreground = options.foreground ?? DEFAULT_FOREGROUND;
    this.background = options.background ?? DEFAULT_BACKGROUND;

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
      // The runtime advertises TERM_PROGRAM=kitty, so full-screen TUIs (opencode)
      // send the kitty keyboard progressive-enhancement query (CSI ?u) on startup
      // and block until they get a reply. Enabling the kitty keyboard extension
      // makes xterm answer that query (→ CSI ?0u), so the TUI never stalls.
      vtExtensions: { kittyKeyboard: true },
    });

    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);

    this.modes = { ...DEFAULT_MODES };

    // xterm generates query responses (DA1/DSR/etc) via onData. Forward them to
    // whoever wired us up (the terminal service writes them back to the PTY).
    this.terminal.onData((data) => {
      this.onDataCallback?.(data);
    });

    // xterm headless does NOT auto-answer OSC 10/11 (foreground/background color)
    // queries. opencode queries the background color at startup and blocks until
    // it gets a reply, so we answer them ourselves. The handler only fires for a
    // query ("?"); a set command ("rgb:...") is left for xterm to apply.
    this.registerOscColorResponder(10, () => this.foreground);
    this.registerOscColorResponder(11, () => this.background);
  }

  private registerOscColorResponder(code: 10 | 11, getColor: () => string): void {
    this.terminal.parser.registerOscHandler(code, (data) => {
      if (data !== "?") {
        // Not a query (e.g. a set command) — let xterm handle it normally.
        return false;
      }
      const reply = `\x1b]${code};${toOscColorSpec(getColor())}\x07`;
      this.onDataCallback?.(reply);
      return true;
    });
  }

  /** Register the sink for emulator-generated output (query responses). */
  onData(callback: (data: string) => void): void {
    this.onDataCallback = callback;
  }

  /** Write PTY output into the emulator (async/buffered). */
  write(data: string): void {
    if (this.disposed) {
      return;
    }
    this.parseEscapeSequences(data);
    this.terminal.write(data);
  }

  /** Write and resolve once xterm has processed the data. */
  writeSync(data: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.parseEscapeSequences(data);
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => resolve());
    });
  }

  /** Flush all pending writes (call before getSnapshot for consistency). */
  flush(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.terminal.write("", () => resolve());
    });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.terminal.resize(cols, rows);
  }

  getModes(): TerminalModes {
    return { ...this.modes };
  }

  getCwd(): string | null {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  getSnapshot(): TerminalSnapshot {
    const snapshotAnsi = this.disposed
      ? ""
      : this.serializeAddon.serialize({ scrollback: DEFAULT_SCROLLBACK });

    return {
      snapshotAnsi,
      rehydrateSequences: this.generateRehydrateSequences(),
      cwd: this.cwd,
      modes: { ...this.modes },
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.terminal.dispose();
  }

  // ───────────────────────────────────────────────────────────────────────

  /**
   * Parse escape sequences with chunk-safe buffering. PTY output can split a
   * sequence across writes, so we buffer partial DECSET/DECRST and OSC-7
   * sequences (the only ones we track) across boundaries.
   */
  private parseEscapeSequences(data: string): void {
    const fullData = this.escapeSequenceBuffer + data;
    this.escapeSequenceBuffer = "";

    this.parseModeChanges(fullData);
    this.parseOsc7(fullData);

    const incomplete = this.findIncompleteTrackedSequence(fullData);
    if (incomplete && incomplete.length <= HeadlessEmulator.MAX_ESCAPE_BUFFER_SIZE) {
      this.escapeSequenceBuffer = incomplete;
    }
  }

  private parseModeChanges(data: string): void {
    const modeRegex = new RegExp(`${escapeRegex(ESC)}\\[\\?([0-9;]+)([hl])`, "g");
    for (const match of data.matchAll(modeRegex)) {
      const enable = match[2] === "h";
      for (const modeNum of match[1].split(";").map((s) => Number.parseInt(s, 10))) {
        const modeName = MODE_MAP[modeNum];
        if (modeName) {
          this.modes[modeName] = enable;
        }
      }
    }
  }

  private parseOsc7(data: string): void {
    const escEscaped = escapeRegex(ESC);
    const belEscaped = escapeRegex(BEL);
    const osc7Pattern = `${escEscaped}\\]7;file://[^/]*(/.+?)(?:${belEscaped}|${escEscaped}\\\\)`;
    const osc7Regex = new RegExp(osc7Pattern, "g");
    for (const match of data.matchAll(osc7Regex)) {
      if (match[1]) {
        try {
          this.cwd = decodeURIComponent(match[1]);
        } catch {
          this.cwd = match[1];
        }
      }
    }
  }

  /**
   * Find an incomplete DECSET/DECRST or OSC-7 sequence at the end of data.
   * Only sequences we track are buffered — other CSI sequences are ignored to
   * prevent unbounded buffer growth.
   */
  private findIncompleteTrackedSequence(data: string): string | null {
    const escEscaped = escapeRegex(ESC);
    const lastEscIndex = data.lastIndexOf(ESC);
    if (lastEscIndex === -1) {
      return null;
    }

    const afterLastEsc = data.slice(lastEscIndex);

    if (afterLastEsc.startsWith(`${ESC}[?`)) {
      const completePattern = new RegExp(`${escEscaped}\\[\\?[0-9;]+[hl]`);
      if (completePattern.test(afterLastEsc)) {
        return null; // Complete DECSET/DECRST
      }
      return afterLastEsc; // Incomplete — buffer it
    }

    if (afterLastEsc.startsWith(`${ESC}]7;`)) {
      if (afterLastEsc.includes(BEL) || afterLastEsc.includes(`${ESC}\\`)) {
        return null; // Complete OSC-7
      }
      return afterLastEsc;
    }

    // Partial starts that could become tracked sequences with more data.
    if (afterLastEsc === ESC) return afterLastEsc;
    if (afterLastEsc === `${ESC}[`) return afterLastEsc;
    if (afterLastEsc === `${ESC}]`) return afterLastEsc;
    if (afterLastEsc === `${ESC}]7`) return afterLastEsc;
    const incompleteDecset = new RegExp(`^${escEscaped}\\[\\?[0-9;]*$`);
    if (incompleteDecset.test(afterLastEsc)) return afterLastEsc;

    return null;
  }

  /**
   * Emit DECSET/DECRST sequences to restore input-affecting modes that differ
   * from their defaults. Alternate-screen (1049/47) is deliberately excluded —
   * the serialized snapshot already carries the correct screen buffer, and
   * re-entering alt-screen here would corrupt restore.
   */
  private generateRehydrateSequences(): string {
    const sequences: string[] = [];
    const addModeSequence = (modeNum: number, enabled: boolean, defaultEnabled: boolean) => {
      if (enabled !== defaultEnabled) {
        sequences.push(`${ESC}[?${modeNum}${enabled ? "h" : "l"}`);
      }
    };

    addModeSequence(1, this.modes.applicationCursorKeys, false);
    addModeSequence(6, this.modes.originMode, false);
    addModeSequence(7, this.modes.autoWrap, true);
    addModeSequence(25, this.modes.cursorVisible, true);
    addModeSequence(9, this.modes.mouseTrackingX10, false);
    addModeSequence(1000, this.modes.mouseTrackingNormal, false);
    addModeSequence(1001, this.modes.mouseTrackingHighlight, false);
    addModeSequence(1002, this.modes.mouseTrackingButtonEvent, false);
    addModeSequence(1003, this.modes.mouseTrackingAnyEvent, false);
    addModeSequence(1005, this.modes.mouseUtf8, false);
    addModeSequence(1006, this.modes.mouseSgr, false);
    addModeSequence(1004, this.modes.focusReporting, false);
    addModeSequence(2004, this.modes.bracketedPaste, false);

    return sequences.join("");
  }
}
