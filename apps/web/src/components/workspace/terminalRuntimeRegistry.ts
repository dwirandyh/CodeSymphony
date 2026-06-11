import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { ProgressAddon } from "@xterm/addon-progress";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable, ILink } from "@xterm/xterm";
import {
  resolveComposedTerminalInput,
  summarizeTerminalData,
  TERMINAL_IME_DEDUP_WINDOW_MS,
  type TerminalDataSummary,
} from "@codesymphony/shared-types";
import { debugLog } from "../../lib/debugLog";
import { resolveRuntimeApiBase } from "../../lib/runtimeUrl";
import { parseFileLocation } from "../../lib/worktree";
import { suppressQueryResponses } from "./suppressQueryResponses";

const FIT_RETRY_DELAYS_MS = [0, 48, 120, 240, 400];
const RECONNECT_REDRAW_NUDGE_DELAYS_MS = [120, 360];
const RECONNECT_REDRAW_RESTORE_DELAY_MS = 48;
// Fallback for the live-output gate: if the server's attach snapshot never
// arrives (e.g. the first resize that triggers it never fired), open the gate
// anyway so the terminal renders live output instead of staying blank forever.
const STREAM_GATE_FALLBACK_MS = 250;
const MIN_VALID_TERMINAL_COLS = 2;
const MIN_VALID_TERMINAL_ROWS = 2;
const PARKED_TERMINAL_CONTAINER_ID = "cs-terminal-runtime-parking";
const MAX_TERMINAL_TITLE_LENGTH = 32;
const FULLSCREEN_REDRAW_SEQUENCE_PATTERN = /\x1b\[\?(?:1049[hl]|2026l)/u;
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const MALFORMED_SGR_MOUSE_REPORT_PATTERN = /^\x1b\[<\d+;(?:\d+|NaN);(?:\d+|NaN)[Mm]$/u;
const TERMINAL_TYPING_DEBUG_PREFIX = "[DEBUG-terminal-typing]";
// Entering the alternate screen buffer is how full-screen TUIs (opencode,
// vim, etc.) start. Some TUIs (opentui) defer their first real frame until a
// terminal capability query times out (~seconds). The reconnect path already
// works around stuck rendering with a resize "nudge"; mirror that for live
// alt-screen entry so the first frame paints immediately instead of after the
// TUI's query timeout (the symptom users hit as "stuck until refresh").
const ALT_SCREEN_ENTER_PATTERN = /\x1b\[\?1049h/u;
const ALT_SCREEN_SCAN_TAIL = ALT_SCREEN_ENTER.length - 1;

const XTERM_THEME: Record<string, string> = {
  background: "#0f1218",
  foreground: "#d4d8e0",
  cursor: "#3b9eff",
  cursorAccent: "#0f1218",
  selectionBackground: "rgba(59, 158, 255, 0.25)",
  black: "#1a1e26",
  red: "#e5534b",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#d4d8e0",
  brightBlack: "#636e7b",
  brightRed: "#ff7b72",
  brightGreen: "#7ee787",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f3f6",
};

type TerminalSessionExitEvent = {
  exitCode: number;
  signal: number;
};

type TerminalInputTransform = ((data: string) => string) | undefined;
type TerminalFileOpenHandler = ((path: string) => void | Promise<void>) | null;
type ConnectionListener = (connected: boolean) => void;
type SessionExitListener = (event: TerminalSessionExitEvent) => void;
type TitleListener = (title: string) => void;

type TrimmedTerminalToken = {
  text: string;
  startOffset: number;
  endOffset: number;
};

export type TerminalFileLinkMatch = {
  text: string;
  startIndex: number;
  endIndex: number;
};

export type TerminalRuntime = {
  readonly sessionId: string;
  readonly terminal: Terminal;
  readonly searchAddon: SearchAddon;
  readonly connected: boolean;
  readonly title: string;
  setTransformInput: (transform: TerminalInputTransform) => void;
  setOpenFileHandler: (handler: TerminalFileOpenHandler) => void;
  attach: (container: HTMLDivElement) => void;
  detach: () => void;
  fit: () => boolean;
  scheduleFitBurst: () => void;
  focus: () => void;
  paste: (text: string) => void;
  writeInput: (data: string) => void;
  writeLocalMessage: (message: string, colorAnsiCode?: number) => void;
  clear: () => void;
  scrollToBottom: () => void;
  findNext: (query: string, options?: ISearchOptions) => boolean;
  findPrevious: (query: string, options?: ISearchOptions) => boolean;
  clearSearchDecorations: () => void;
  onConnectionStateChange: (listener: ConnectionListener) => () => void;
  onTitleChange: (listener: TitleListener) => () => void;
  onSessionExit: (listener: SessionExitListener) => () => void;
  reconnectIfNeeded: (cwd: string | null) => void;
  dispose: () => void;
};

type TerminalRuntimeEntry = {
  sessionId: string;
  cwd: string | null;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  optionalAddonsDispose: () => void;
  wrapper: HTMLDivElement;
  webSocket: WebSocket | null;
  reconnectTimerId: number | null;
  suppressQueryResponsesDispose: () => void;
  streamReady: boolean;
  streamGateTimerId: number | null;
  pendingData: string[];
  fitTimerIds: number[];
  fitAnimationFrameIds: number[];
  redrawTimerIds: number[];
  diagFrameCount: number;
  diagByteCount: number;
  inputSeq: number;
  forceRefreshWritesRemaining: number;
  modeScanTail: string;
  onAlternateScreen: boolean;
  lastResize: { cols: number; rows: number } | null;
  connected: boolean;
  title: string;
  defaultTitle: string;
  currentWebSocketUrl: string | null;
  disposed: boolean;
  transformInput: TerminalInputTransform;
  openFileHandler: TerminalFileOpenHandler;
  connectionListeners: Set<ConnectionListener>;
  titleListeners: Set<TitleListener>;
  sessionExitListeners: Set<SessionExitListener>;
  suppressedInput: {
    active: boolean;
    originalData: string | null;
    resetTimerId: number | null;
  };
};

type TerminalInputDiagnostics = {
  stage: string;
  rawSummary?: TerminalDataSummary | null;
  inputSummary?: TerminalDataSummary | null;
  nextSummary?: TerminalDataSummary | null;
  inputType?: string | null;
  defaultPrevented?: boolean;
  transformed?: boolean;
  suppressed?: boolean;
  dropped?: boolean;
  dropReason?: string;
  sendAttempted?: boolean;
  sent?: boolean;
  pendingAndroidBeforeInput?: boolean;
  textareaValueSummary?: TerminalDataSummary | null;
  keyboard?: {
    keyKind: "character" | "named";
    keyName: string | null;
    keySummary: TerminalDataSummary | null;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    isComposing: boolean;
    defaultPrevented: boolean;
  };
  // [DEBUG-pty-typing] Additional diagnostic fields
  clientSendSeq?: number;
  documentHasFocus?: boolean | null;
  composedLength?: number;
  recoveredLength?: number;
  focusStealer?: {
    tag: string | null;
    id: string | null;
    className: string | null;
    role: string | null;
    isTextarea: boolean;
    isInput: boolean;
    dataTestId: string | null;
    noActiveElement?: boolean;
  };
};

const terminalRuntimeRegistry = new Map<string, TerminalRuntime>();

function getWsBase(): string {
  const apiBase = resolveRuntimeApiBase();
  return apiBase.replace(/^http/, "ws");
}

function normalizeCwd(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function getDefaultTerminalTitle(sessionId: string, cwd: string | null): string {
  const normalizedCwd = normalizeCwd(cwd);
  if (normalizedCwd) {
    const segments = normalizedCwd.split(/[\\/]/u).filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (leaf) {
      return leaf;
    }
  }

  const normalizedSessionId = sessionId.trim();
  if (normalizedSessionId.endsWith(":terminal")) {
    return "Terminal";
  }

  return "Terminal";
}

function isWorkspaceTerminalSessionId(sessionId: string): boolean {
  return /(?:^|:)terminal(?:$|:)/u.test(sessionId) || /^default:\d+$/u.test(sessionId);
}

function stripAnsi(text: string): string {
  return text.replace(
    /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/gu,
    "",
  );
}

function sanitizeTitleFromCommand(text: string): string | null {
  const cleaned = stripAnsi(text).trim().slice(0, MAX_TERMINAL_TITLE_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function getVisiblePromptBlockToCursor(terminal: Terminal): string | null {
  const activeBuffer = terminal.buffer.active;
  const lineIndex = activeBuffer.cursorY + activeBuffer.viewportY;
  const currentLine = activeBuffer.getLine(lineIndex);
  if (!currentLine) {
    return null;
  }

  let startIndex = lineIndex;
  while (startIndex > 0) {
    const line = activeBuffer.getLine(startIndex);
    if (!line?.isWrapped) {
      break;
    }
    startIndex -= 1;
  }

  let rendered = "";
  for (let index = startIndex; index <= lineIndex; index += 1) {
    const line = activeBuffer.getLine(index);
    if (!line) {
      return null;
    }

    const text = line.translateToString(true);
    rendered += index === lineIndex ? text.slice(0, activeBuffer.cursorX) : text;
  }

  return rendered;
}

function isCommandEchoed(terminal: Terminal, command: string): boolean {
  const normalizedCommand = stripAnsi(command).trimEnd();
  if (normalizedCommand.length === 0) {
    return false;
  }

  const renderedPromptBlock = getVisiblePromptBlockToCursor(terminal);
  if (!renderedPromptBlock) {
    return false;
  }

  return renderedPromptBlock.trimEnd().endsWith(normalizedCommand);
}

function buildTerminalWebSocketUrl(sessionId: string, cwd: string | null): string {
  const params = new URLSearchParams({ sessionId });
  if (cwd) {
    params.set("cwd", cwd);
  }

  return `${getWsBase()}/terminal/ws?${params.toString()}`;
}

function getParkedTerminalContainer(): HTMLDivElement {
  let container = document.getElementById(PARKED_TERMINAL_CONTAINER_ID);
  if (container instanceof HTMLDivElement) {
    return container;
  }

  container = document.createElement("div");
  container.id = PARKED_TERMINAL_CONTAINER_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "-10000px";
  container.style.width = "1px";
  container.style.height = "1px";
  container.style.overflow = "hidden";
  container.style.pointerEvents = "none";
  document.body.appendChild(container);
  return container as HTMLDivElement;
}

function mountTerminalWrapper(
  wrapper: HTMLDivElement,
  container: HTMLDivElement | null | undefined,
): void {
  if (container) {
    if (wrapper.parentElement !== container) {
      container.replaceChildren(wrapper);
    }
    return;
  }

  const parkedContainer = getParkedTerminalContainer();
  if (wrapper.parentElement !== parkedContainer) {
    parkedContainer.appendChild(wrapper);
  }
}

function notifyConnectionState(entry: TerminalRuntimeEntry): void {
  for (const listener of entry.connectionListeners) {
    listener(entry.connected);
  }
}

function setConnected(entry: TerminalRuntimeEntry, connected: boolean): void {
  if (entry.connected === connected) {
    return;
  }

  entry.connected = connected;
  notifyConnectionState(entry);
}

function notifyTitleChange(entry: TerminalRuntimeEntry): void {
  for (const listener of entry.titleListeners) {
    listener(entry.title);
  }
}

function setTerminalTitle(entry: TerminalRuntimeEntry, nextTitle: string): void {
  const trimmedTitle = nextTitle.trim();
  if (trimmedTitle.length === 0 || entry.title === trimmedTitle) {
    return;
  }

  entry.title = trimmedTitle;
  notifyTitleChange(entry);
}

function shouldRefreshAfterTerminalWrite(chunk: string): boolean {
  return FULLSCREEN_REDRAW_SEQUENCE_PATTERN.test(chunk);
}

function detectSplitAlternateScreenEntry(entry: TerminalRuntimeEntry, chunk: string): boolean {
  const scanWindow = entry.modeScanTail + chunk;
  entry.modeScanTail = scanWindow.slice(-ALT_SCREEN_SCAN_TAIL);
  return ALT_SCREEN_ENTER_PATTERN.test(scanWindow);
}

function isMalformedSgrMouseReport(data: string): boolean {
  return data.includes("NaN") && MALFORMED_SGR_MOUSE_REPORT_PATTERN.test(data);
}

function summarizeMaybeTerminalData(data: string | null | undefined): TerminalDataSummary | null {
  return typeof data === "string" ? summarizeTerminalData(data) : null;
}

function summarizeTextareaValue(textarea: HTMLTextAreaElement | null | undefined): TerminalDataSummary | null {
  return textarea ? summarizeTerminalData(textarea.value) : null;
}

function getSocketReadyState(webSocket: WebSocket | null): number | null {
  return webSocket?.readyState ?? null;
}

function summarizeKeyboardEvent(event: KeyboardEvent): TerminalInputDiagnostics["keyboard"] {
  const isCharacter = event.key.length === 1;
  return {
    keyKind: isCharacter ? "character" : "named",
    keyName: isCharacter ? null : event.key,
    keySummary: isCharacter ? summarizeTerminalData(event.key) : null,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
    isComposing: event.isComposing,
    defaultPrevented: event.defaultPrevented,
  };
}

function logTerminalInputDiagnostics(
  entry: TerminalRuntimeEntry,
  message: string,
  diagnostics: TerminalInputDiagnostics,
): void {
  const textarea = entry.terminal.textarea;
  const activeElement = typeof document === "undefined" ? null : document.activeElement;
  // [DEBUG-pty-typing] Always force-send to bypass source filters
  debugLog("terminal.typing", `${TERMINAL_TYPING_DEBUG_PREFIX} ${message}`, {
    sessionId: entry.sessionId,
    inputSeq: ++entry.inputSeq,
    socketReadyState: getSocketReadyState(entry.webSocket),
    connected: entry.connected,
    streamReady: entry.streamReady,
    pendingOutputChunks: entry.pendingData.length,
    pendingAndroidBeforeInput: false,
    textareaPresent: textarea !== null,
    textareaFocused: textarea !== null && activeElement === textarea,
    activeElementTag: activeElement instanceof HTMLElement ? activeElement.tagName.toLowerCase() : null,
    documentHasFocus: typeof document === "undefined" ? null : document.hasFocus(),
    textareaValueSummary: summarizeTextareaValue(textarea),
    ...diagnostics,
  }, { force: true });
}

function writeTerminalOutput(entry: TerminalRuntimeEntry, chunk: string): void {
  // [DEBUG-pty-typing] Log every output during active typing (inputSeq > 0)
  if (entry.inputSeq > 0 && entry.diagFrameCount <= 10) {
    debugLog("terminal.output", "[DEBUG-pty-typing] writeOutput.duringTyping", {
      sessionId: entry.sessionId,
      inputSeq: entry.inputSeq,
      outputFrame: entry.diagFrameCount,
      chunkBytes: chunk.length,
      outputSummary: summarizeTerminalData(chunk),
      streamReady: entry.streamReady,
    }, { force: true });
  }
  const entersAlternateScreen = detectSplitAlternateScreenEntry(entry, chunk);
  if (entersAlternateScreen) {
    entry.forceRefreshWritesRemaining = Math.max(entry.forceRefreshWritesRemaining, 8);
  }
  const forceRefreshAfterWrite = entry.forceRefreshWritesRemaining > 0;
  if (forceRefreshAfterWrite) {
    entry.forceRefreshWritesRemaining -= 1;
  }
  // Alternate-screen entry is handled by terminal.buffer.onBufferChange (set up
  // in createTerminalRuntime), which is immune to WebSocket frame splitting.
  // Raw chunks still matter on replay/reattach: xterm may already be on the
  // alternate buffer, so no buffer-change event fires. In that case the raw
  // alt-enter byte is the only signal that a fullscreen TUI needs a resize
  // redraw nudge.
  if (!entersAlternateScreen && !shouldRefreshAfterTerminalWrite(chunk) && !forceRefreshAfterWrite) {
    entry.terminal.write(chunk);
    return;
  }

  entry.terminal.write(chunk, () => {
    if (entry.disposed) {
      return;
    }

    entry.terminal.scrollToBottom();
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
    if (entersAlternateScreen) {
      scheduleReconnectRedrawNudge(entry);
    }
  });
}

function sendResize(entry: TerminalRuntimeEntry, cols: number, rows: number): boolean {
  if (cols < MIN_VALID_TERMINAL_COLS || rows < MIN_VALID_TERMINAL_ROWS) {
    return false;
  }

  const webSocket = entry.webSocket;
  if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  if (entry.lastResize?.cols === cols && entry.lastResize?.rows === rows) {
    return true;
  }

  entry.lastResize = { cols, rows };
  webSocket.send(JSON.stringify({ type: "resize", cols, rows }));
  return true;
}

function fitTerminalRuntime(entry: TerminalRuntimeEntry): boolean {
  if (entry.disposed) {
    return false;
  }

  const container = entry.wrapper.parentElement;
  if (!(container instanceof HTMLElement) || container.clientWidth < 2 || container.clientHeight < 2) {
    return false;
  }

  entry.fitAddon.fit();
  const dimensions = entry.fitAddon.proposeDimensions();
  if (!dimensions) {
    return false;
  }

  if (dimensions.cols < MIN_VALID_TERMINAL_COLS || dimensions.rows < MIN_VALID_TERMINAL_ROWS) {
    return false;
  }

  return sendResize(entry, dimensions.cols, dimensions.rows);
}

function clearScheduledFitBurst(entry: TerminalRuntimeEntry): void {
  for (const timerId of entry.fitTimerIds) {
    window.clearTimeout(timerId);
  }
  entry.fitTimerIds = [];

  for (const frameId of entry.fitAnimationFrameIds) {
    window.cancelAnimationFrame(frameId);
  }
  entry.fitAnimationFrameIds = [];
}

function clearReconnectRedrawNudges(entry: TerminalRuntimeEntry): void {
  for (const timerId of entry.redrawTimerIds) {
    window.clearTimeout(timerId);
  }
  entry.redrawTimerIds = [];
}

type TerminalAttachFrame = {
  snapshotAnsi: string;
  rehydrateSequences: string;
  modes: { alternateScreen?: boolean } & Record<string, unknown>;
  cwd: string | null;
  cols: number;
  rows: number;
};

const ALT_SCREEN_ENTER_LEGACY = "\x1b[?47h";

// Apply the server's structured attach snapshot. The headless emulator on the
// runtime holds the authoritative screen state; the client restores
// deterministically from it instead of replaying raw scrollback and guessing
// the alt-screen state.
//
// The serialized snapshot (`snapshotAnsi`) already carries everything needed to
// reproduce the screen — including the `\x1b[?1049h` alternate-screen enter and
// the painted contents for a full-screen TUI. We therefore write the
// input-mode rehydrate sequences first (cursor keys, bracketed paste, etc.,
// which `generateRehydrateSequences` emits without the alt-screen enter), then
// the snapshot body. Writing the snapshot is what actually repaints the pane —
// skipping it (an earlier port) left reattached TUIs blank until a manual
// refresh.
function applyAttachSnapshot(entry: TerminalRuntimeEntry, frame: TerminalAttachFrame): void {
  if (entry.disposed) {
    return;
  }

  const { terminal } = entry;
  const onAlternateScreen = frame.modes?.alternateScreen === true;
  entry.onAlternateScreen = onAlternateScreen;

  // [DEBUG-pty-typing] Log inputSeq at snapshot time to detect snapshot-overwrite-during-typing
  debugLog("terminal.render", "attach.snapshot", {
    sessionId: entry.sessionId,
    alternateScreen: onAlternateScreen,
    snapshotBytes: frame.snapshotAnsi.length,
    rehydrateBytes: frame.rehydrateSequences.length,
    inputSeqAtSnapshot: entry.inputSeq,
    streamReadyBeforeSnapshot: entry.streamReady,
    pendingOutputAtSnapshot: entry.pendingData.length,
  }, { force: true });

  const finalizeRestore = () => {
    if (entry.disposed) {
      return;
    }
    openStreamGate(entry);
    terminal.scrollToBottom();
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    // Surface the post-restore buffer state so a stuck-launch issue report shows
    // whether the deterministic restore actually landed on the alternate screen
    // (a blank pane after this with alternateScreen mismatch = restore failed).
    debugLog("terminal.render", "attach.restored", {
      sessionId: entry.sessionId,
      expectedAlternateScreen: onAlternateScreen,
      actualBufferType: terminal.buffer.active.type,
      wroteSnapshot: frame.snapshotAnsi.length > 0,
    });
  };

  const writeSnapshot = () => {
    if (frame.snapshotAnsi) {
      terminal.write(frame.snapshotAnsi, finalizeRestore);
    } else {
      finalizeRestore();
    }
  };

  // Strip any alternate-screen enter from the rehydrate sequences as a
  // belt-and-braces guard — the snapshot body owns the alt-screen switch, so we
  // never want to enter it twice.
  const rehydrate = frame.rehydrateSequences
    .split(ALT_SCREEN_ENTER)
    .join("")
    .split(ALT_SCREEN_ENTER_LEGACY)
    .join("");

  if (rehydrate) {
    terminal.write(rehydrate, writeSnapshot);
  } else {
    writeSnapshot();
  }
}

// Open the live-output gate: flush any queued data and let subsequent live
// output render directly. Idempotent — safe to call from the attach-snapshot
// restore path and from the fallback timer, whichever fires first.
function openStreamGate(entry: TerminalRuntimeEntry): void {
  clearStreamGateFallback(entry);
  if (entry.streamReady) {
    return;
  }
  entry.streamReady = true;
  if (entry.pendingData.length === 0) {
    return;
  }
  const queued = entry.pendingData.splice(0, entry.pendingData.length);
  for (const chunk of queued) {
    writeTerminalOutput(entry, chunk);
  }
}

function clearStreamGateFallback(entry: TerminalRuntimeEntry): void {
  if (entry.streamGateTimerId !== null) {
    window.clearTimeout(entry.streamGateTimerId);
    entry.streamGateTimerId = null;
  }
}

// Arm the safety valve that opens the gate even if the server's attach snapshot
// never arrives, so a terminal never stays blank waiting on it.
function armStreamGateFallback(entry: TerminalRuntimeEntry): void {
  clearStreamGateFallback(entry);
  entry.streamGateTimerId = window.setTimeout(() => {
    entry.streamGateTimerId = null;
    if (entry.disposed || entry.streamReady) {
      return;
    }
    debugLog("terminal.render", "streamGate.fallback", {
      sessionId: entry.sessionId,
      pendingChunks: entry.pendingData.length,
    });
    openStreamGate(entry);
  }, STREAM_GATE_FALLBACK_MS);
}

function scheduleFitBurst(entry: TerminalRuntimeEntry): void {
  clearScheduledFitBurst(entry);
  if (entry.disposed) {
    return;
  }

  for (const delayMs of FIT_RETRY_DELAYS_MS) {
    const timerId = window.setTimeout(() => {
      entry.fitTimerIds = entry.fitTimerIds.filter((scheduledTimerId) => scheduledTimerId !== timerId);
      if (entry.disposed) {
        return;
      }

      const frameId = window.requestAnimationFrame(() => {
        entry.fitAnimationFrameIds = entry.fitAnimationFrameIds.filter((scheduledFrameId) => scheduledFrameId !== frameId);
        if (entry.disposed) {
          return;
        }

        fitTerminalRuntime(entry);
      });
      entry.fitAnimationFrameIds.push(frameId);
    }, delayMs);
    entry.fitTimerIds.push(timerId);
  }
}

function resolveResizeNudgeDimensions(
  dimensions: { cols: number; rows: number },
): { cols: number; rows: number } | null {
  if (dimensions.cols > MIN_VALID_TERMINAL_COLS) {
    return {
      cols: dimensions.cols - 1,
      rows: dimensions.rows,
    };
  }

  if (dimensions.rows > MIN_VALID_TERMINAL_ROWS) {
    return {
      cols: dimensions.cols,
      rows: dimensions.rows - 1,
    };
  }

  return null;
}

function scheduleReconnectRedrawNudge(entry: TerminalRuntimeEntry): void {
  clearReconnectRedrawNudges(entry);

  for (const delayMs of RECONNECT_REDRAW_NUDGE_DELAYS_MS) {
    const timerId = window.setTimeout(() => {
      entry.redrawTimerIds = entry.redrawTimerIds.filter((scheduledTimerId) => scheduledTimerId !== timerId);
      if (entry.disposed) {
        return;
      }

      const dimensions = entry.fitAddon.proposeDimensions();
      if (!dimensions) {
        return;
      }

      const nudgeDimensions = resolveResizeNudgeDimensions(dimensions);
      if (!nudgeDimensions) {
        return;
      }

      const nudged = sendResize(entry, nudgeDimensions.cols, nudgeDimensions.rows);
      if (!nudged) {
        return;
      }

      const restoreTimerId = window.setTimeout(() => {
        entry.redrawTimerIds = entry.redrawTimerIds.filter((scheduledTimerId) => scheduledTimerId !== restoreTimerId);
        if (entry.disposed) {
          return;
        }

        sendResize(entry, dimensions.cols, dimensions.rows);
      }, RECONNECT_REDRAW_RESTORE_DELAY_MS);
      entry.redrawTimerIds.push(restoreTimerId);
    }, delayMs);
    entry.redrawTimerIds.push(timerId);
  }
}

function trimTerminalToken(rawToken: string): TrimmedTerminalToken | null {
  let startOffset = 0;
  let endOffset = rawToken.length;

  while (startOffset < endOffset && /^[([{"'`<]$/u.test(rawToken[startOffset] ?? "")) {
    startOffset += 1;
  }

  while (endOffset > startOffset && /^[)\]}",'`>;]$/u.test(rawToken[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  const text = rawToken.slice(startOffset, endOffset).trim();
  if (text.length === 0) {
    return null;
  }

  return {
    text,
    startOffset,
    endOffset,
  };
}

function hasFileLikePathShape(candidate: string): boolean {
  if (/^(?:https?:\/\/|mailto:|tel:)/iu.test(candidate)) {
    return false;
  }

  const location = parseFileLocation(candidate);
  const normalizedPath = location.path.replaceAll("\\", "/");
  if (normalizedPath.length === 0) {
    return false;
  }

  const hasLocationSuffix = location.line !== null || /#L\d+/iu.test(candidate);
  const hasAbsoluteOrRelativePrefix = /^(?:\/|\.{1,2}\/|[A-Za-z]:[\\/])/u.test(location.path);
  const hasSlash = normalizedPath.includes("/");
  const hasFilenameExtension = /(?:^|\/)\.?[A-Za-z0-9_-][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9_-]{0,11}$/u.test(normalizedPath);

  if (hasFilenameExtension) {
    return true;
  }

  if (!hasLocationSuffix) {
    return false;
  }

  return hasAbsoluteOrRelativePrefix || hasSlash || /^[A-Za-z0-9_.-]+$/u.test(normalizedPath);
}

export function collectTerminalFileLinks(line: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  const tokenPattern = /\S+/gu;

  for (const tokenMatch of line.matchAll(tokenPattern)) {
    const rawToken = tokenMatch[0];
    const index = tokenMatch.index ?? -1;
    if (index < 0) {
      continue;
    }

    const trimmedToken = trimTerminalToken(rawToken);
    if (!trimmedToken || !hasFileLikePathShape(trimmedToken.text)) {
      continue;
    }

    matches.push({
      text: trimmedToken.text,
      startIndex: index + trimmedToken.startOffset,
      endIndex: index + trimmedToken.endOffset,
    });
  }

  return matches;
}

function createTerminalFileLinkProvider(entry: TerminalRuntimeEntry): IDisposable {
  return entry.terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      if (!entry.openFileHandler) {
        callback(undefined);
        return;
      }

      const line = entry.terminal.buffer.active.getLine(bufferLineNumber - 1);
      const text = line?.translateToString(true) ?? "";
      if (text.length === 0) {
        callback(undefined);
        return;
      }

      const links = collectTerminalFileLinks(text).map<ILink>((match) => ({
        text: match.text,
        range: {
          start: { x: match.startIndex + 1, y: bufferLineNumber },
          end: { x: match.endIndex, y: bufferLineNumber },
        },
        decorations: {
          underline: true,
          pointerCursor: true,
        },
        activate: (_event, filePath) => {
          void entry.openFileHandler?.(filePath);
        },
      }));

      callback(links.length > 0 ? links : undefined);
    },
  });
}

function connectTerminalRuntime(entry: TerminalRuntimeEntry, nextCwd: string | null): void {
  if (entry.disposed) {
    return;
  }

  entry.cwd = nextCwd;
  const nextDefaultTitle = getDefaultTerminalTitle(entry.sessionId, nextCwd);
  if (entry.title === entry.defaultTitle) {
    entry.defaultTitle = nextDefaultTitle;
    entry.title = nextDefaultTitle;
    notifyTitleChange(entry);
  } else {
    entry.defaultTitle = nextDefaultTitle;
  }
  const nextUrl = buildTerminalWebSocketUrl(entry.sessionId, nextCwd);
  const webSocket = entry.webSocket;
  const isAlreadyConnectedToTarget = entry.currentWebSocketUrl === nextUrl
    && (webSocket?.readyState === WebSocket.OPEN || webSocket?.readyState === WebSocket.CONNECTING);
  if (isAlreadyConnectedToTarget) {
    return;
  }

  if (entry.reconnectTimerId !== null) {
    window.clearTimeout(entry.reconnectTimerId);
    entry.reconnectTimerId = null;
  }

  if (webSocket) {
    webSocket.onclose = null;
    webSocket.close();
  }

  entry.lastResize = null;
  entry.currentWebSocketUrl = nextUrl;
  // Each (re)connection re-gates live output until the server sends its attach
  // snapshot, so live data can't paint ahead of the deterministic restore. A
  // fallback timer opens the gate even if the attach frame never arrives, so the
  // terminal can never stay blank waiting on it.
  entry.streamReady = false;
  entry.pendingData = [];
  armStreamGateFallback(entry);
  const nextWebSocket = new WebSocket(nextUrl);
  entry.webSocket = nextWebSocket;

  nextWebSocket.onopen = () => {
    if (entry.disposed || entry.webSocket !== nextWebSocket) {
      nextWebSocket.close();
      return;
    }

    setConnected(entry, true);
    debugLog("terminal.render", "ws.open", {
      sessionId: entry.sessionId,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      rendererType: suggestedRendererType ?? "webgl",
    });
    fitTerminalRuntime(entry);
    scheduleFitBurst(entry);
    scheduleReconnectRedrawNudge(entry);
  };

  nextWebSocket.onmessage = (event) => {
    if (entry.disposed || entry.webSocket !== nextWebSocket) {
      // The chunk arrived on a superseded socket (the client reconnected and
      // entry.webSocket now points to a newer WS). If it carried the alt-screen
      // enter, that live paint is being dropped here — log it so a stuck-TUI
      // report shows the bytes were lost to socket churn, not a render bug.
      if (typeof event.data === "string" && ALT_SCREEN_ENTER_PATTERN.test(event.data)) {
        debugLog("terminal.render", "client.altEnterDroppedStaleSocket", {
          sessionId: entry.sessionId,
          disposed: entry.disposed,
          hasCurrentSocket: entry.webSocket !== null,
          chunkBytes: event.data.length,
        });
      }
      return;
    }

    const chunk = event.data as string;
    entry.diagFrameCount += 1;
    entry.diagByteCount += chunk.length;
    if (entry.diagFrameCount <= 3 || entry.diagFrameCount % 25 === 0) {
      debugLog("terminal.render", "ws.message", {
        sessionId: entry.sessionId,
        frame: entry.diagFrameCount,
        totalBytes: entry.diagByteCount,
        chunkBytes: chunk.length,
        entersAltScreen: ALT_SCREEN_ENTER_PATTERN.test(chunk),
        rendererType: suggestedRendererType ?? "webgl",
      });
    }
    // Always log when a live chunk carries the alt-screen enter byte (the
    // frame-sampled ws.message above can miss it). Lets a stuck-TUI report show
    // whether the client actually received the alt-enter the server emulator saw.
    if (ALT_SCREEN_ENTER_PATTERN.test(chunk)) {
      debugLog("terminal.render", "client.altEnterChunk", {
        sessionId: entry.sessionId,
        frame: entry.diagFrameCount,
        chunkBytes: chunk.length,
        streamReady: entry.streamReady,
        bufferType: entry.terminal.buffer.active.type,
      });
    }
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
      if (parsed.kind === "cs-terminal-event" && parsed.type === "attach") {
        applyAttachSnapshot(entry, {
          snapshotAnsi: typeof parsed.snapshotAnsi === "string" ? parsed.snapshotAnsi : "",
          rehydrateSequences: typeof parsed.rehydrateSequences === "string" ? parsed.rehydrateSequences : "",
          modes: (parsed.modes ?? {}) as TerminalAttachFrame["modes"],
          cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
          cols: typeof parsed.cols === "number" ? parsed.cols : entry.terminal.cols,
          rows: typeof parsed.rows === "number" ? parsed.rows : entry.terminal.rows,
        });
        return;
      }
      if (
        parsed.kind === "cs-terminal-event"
        && parsed.type === "exit"
        && typeof parsed.exitCode === "number"
        && typeof parsed.signal === "number"
      ) {
        for (const listener of entry.sessionExitListeners) {
          listener({
            exitCode: parsed.exitCode,
            signal: parsed.signal,
          });
        }
        if (isWorkspaceTerminalSessionId(entry.sessionId) && entry.webSocket === nextWebSocket) {
          nextWebSocket.close();
        }
        return;
      }
    } catch {
      // Not an internal event payload; treat as terminal output.
    }

    debugLog("terminal.output", `${TERMINAL_TYPING_DEBUG_PREFIX} client.ws.output`, {
      sessionId: entry.sessionId,
      frame: entry.diagFrameCount,
      socketReadyState: nextWebSocket.readyState,
      streamReady: entry.streamReady,
      pendingOutputChunks: entry.pendingData.length,
      outputSummary: summarizeTerminalData(chunk),
    });

    // Hold live output until the attach snapshot has been applied, then flush
    // in order so the restored screen is never clobbered by mid-restore writes.
    if (!entry.streamReady) {
      entry.pendingData.push(chunk);
      return;
    }

    writeTerminalOutput(entry, chunk);
  };

  nextWebSocket.onclose = (event) => {
    if (entry.webSocket !== nextWebSocket) {
      return;
    }

    entry.webSocket = null;
    entry.lastResize = null;
    setConnected(entry, false);

    if (entry.disposed) {
      return;
    }

    const reason = event.reason?.trim();
    const detail = reason ? ` code=${event.code} reason=${reason}` : ` code=${event.code}`;
    entry.terminal.write(`\r\n\x1b[33m[Disconnected - reconnecting...${detail}]\x1b[0m\r\n`);
    entry.reconnectTimerId = window.setTimeout(() => {
      entry.reconnectTimerId = null;
      connectTerminalRuntime(entry, entry.cwd);
    }, 2000);
  };

  nextWebSocket.onerror = () => {
    nextWebSocket.close();
  };
}

// Once WebGL fails for one terminal, skip it for the rest of the session
// (the VS Code / superset pattern): a GPU context loss usually means the
// environment can't support WebGL at all.
let suggestedRendererType: "webgl" | "dom" | undefined;

// Load the optional, render-quality addons onto an already-opened terminal.
// WebGL is deferred to the next animation frame so it does not race xterm's
// post-open viewport sync, and falls back to the DOM renderer if it throws or
// loses its context. Returns a cleanup function.
function loadOptionalAddons(terminal: Terminal, onWebglContextLoss?: () => void): () => void {
  let disposed = false;
  let webglAddon: WebglAddon | null = null;

  terminal.loadAddon(new ClipboardAddon());

  const unicode11 = new Unicode11Addon();
  terminal.loadAddon(unicode11);
  terminal.unicode.activeVersion = "11";

  terminal.loadAddon(new ImageAddon());
  terminal.loadAddon(new ProgressAddon());

  // Ligatures must load before WebGL so the WebGL texture atlas picks up the
  // font-feature-settings. The beta addon is browser-safe: it uses the Font
  // Access API (with a static fallback ligature set) instead of the old
  // Node-only font-finder, so it no longer crashes in a plain browser.
  terminal.loadAddon(new LigaturesAddon());

  const rafId = window.requestAnimationFrame(() => {
    if (disposed || suggestedRendererType === "dom") {
      return;
    }
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // Disposing the WebGL addon makes xterm fall back to the DOM renderer,
        // but the canvas it leaves behind is blank until something repaints.
        // A plain refresh() is enough for normal scrollback, but full-screen
        // TUIs (opencode/vim) sit in the alternate screen buffer and only
        // redraw on a resize. Hand off to the caller so it can run the same
        // resize "nudge" used on reconnect; otherwise the terminal stays blank
        // until the user manually resizes or refreshes the page.
        suggestedRendererType = "dom";
        debugLog("terminal.render", "webgl.contextLoss", {});
        webglAddon?.dispose();
        webglAddon = null;
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        onWebglContextLoss?.();
      });
      terminal.loadAddon(webglAddon);
      debugLog("terminal.render", "webgl.loaded", {});
    } catch (error) {
      suggestedRendererType = "dom";
      webglAddon = null;
      debugLog("terminal.render", "webgl.loadFailed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return () => {
    disposed = true;
    window.cancelAnimationFrame(rafId);
    try {
      webglAddon?.dispose();
    } catch {
      // already disposed
    }
    webglAddon = null;
  };
}

function createTerminalRuntime(
  sessionId: string,
  cwd: string | null,
  container?: HTMLDivElement | null,
): TerminalRuntime {
  const wrapper = document.createElement("div");
  wrapper.className = "h-full min-h-0 min-w-0 flex-1 bg-[#0f1218]";
  mountTerminalWrapper(wrapper, container);

  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
    // lineHeight must stay at 1.0: any value > 1 inserts vertical gaps between
    // rows, which breaks box-drawing/TUI characters (e.g. opencode's vertical
    // rules render as dashed instead of continuous).
    lineHeight: 1.0,
    theme: XTERM_THEME,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const webLinksAddon = new WebLinksAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(wrapper);
  // Consume the visible xterm's own query responses (CPR/focus/DECRPM) so they
  // are not piped to the PTY as fake keystrokes. The server-side headless
  // emulator is the sole responder to terminal capability queries.
  const suppressQueryResponsesDispose = suppressQueryResponses(terminal);
  // The WebGL context-loss handler runs long after `entry` is created (next
  // animation frame at the earliest), so it is safe to reference it lazily
  // here. On loss we reuse the reconnect redraw nudge so full-screen TUIs
  // repaint into the DOM renderer instead of staying blank.
  const optionalAddonsDispose = loadOptionalAddons(terminal, () => {
    if (!entry.disposed) {
      scheduleReconnectRedrawNudge(entry);
    }
  });
  const defaultTitle = getDefaultTerminalTitle(sessionId, cwd);
  let commandBuffer = "";

  const entry: TerminalRuntimeEntry = {
    sessionId,
    cwd,
    terminal,
    fitAddon,
    searchAddon,
    optionalAddonsDispose,
    wrapper,
    webSocket: null,
    reconnectTimerId: null,
    suppressQueryResponsesDispose,
    streamReady: false,
    streamGateTimerId: null,
    pendingData: [],
    fitTimerIds: [],
    fitAnimationFrameIds: [],
    redrawTimerIds: [],
    diagFrameCount: 0,
    diagByteCount: 0,
    inputSeq: 0,
    forceRefreshWritesRemaining: 0,
    modeScanTail: "",
    onAlternateScreen: false,
    lastResize: null,
    connected: false,
    title: defaultTitle,
    defaultTitle,
    currentWebSocketUrl: null,
    disposed: false,
    transformInput: undefined,
    openFileHandler: null,
    connectionListeners: new Set(),
    titleListeners: new Set(),
    sessionExitListeners: new Set(),
    suppressedInput: {
      active: false,
      originalData: null,
      resetTimerId: null,
    },
  };

  createTerminalFileLinkProvider(entry);

  const clearSuppressedInput = () => {
    if (entry.suppressedInput.resetTimerId !== null) {
      window.clearTimeout(entry.suppressedInput.resetTimerId);
    }
    entry.suppressedInput = {
      active: false,
      originalData: null,
      resetTimerId: null,
    };
  };

  const suppressOriginalInputIfHandled = (data: string): boolean => {
    if (!entry.suppressedInput.active || entry.suppressedInput.originalData !== data) {
      return false;
    }

    clearSuppressedInput();
    return true;
  };

  const scheduleSuppressedInputReset = () => {
    if (entry.suppressedInput.resetTimerId !== null) {
      window.clearTimeout(entry.suppressedInput.resetTimerId);
    }
    entry.suppressedInput.resetTimerId = window.setTimeout(() => {
      clearSuppressedInput();
    }, TERMINAL_IME_DEDUP_WINDOW_MS);
  };

  const trackComposingText = (nextValue: string) => {
    lastComposingText = nextValue;
  };

  const textarea = terminal.textarea;
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  let pendingAndroidBeforeInputData: string | null = null;
  let lastComposingText: string = "";
  let isComposing: boolean = false;

  const resolveAndroidInputData = (data: string): string => {
    if (!isAndroid || !pendingAndroidBeforeInputData) {
      return data;
    }

    const latestData = pendingAndroidBeforeInputData;
    pendingAndroidBeforeInputData = null;
    if (data !== latestData && data.endsWith(latestData)) {
      return latestData;
    }

    return data;
  };

  terminal.onData((data) => {
    if (isComposing) {
      logTerminalInputDiagnostics(entry, "client.onData.suppressedDuringComposition", {
        stage: "onData",
        rawSummary: summarizeTerminalData(data),
        suppressed: true,
        dropReason: "ime-composition-in-progress",
        pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      });
      return;
    }

    if (suppressOriginalInputIfHandled(data)) {
      logTerminalInputDiagnostics(entry, "client.onData.suppressed", {
        stage: "onData",
        rawSummary: summarizeTerminalData(data),
        suppressed: true,
        pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      });
      pendingAndroidBeforeInputData = null;
      return;
    }

    if (isMalformedSgrMouseReport(data)) {
      logTerminalInputDiagnostics(entry, "client.onData.dropMalformedMouse", {
        stage: "onData",
        rawSummary: summarizeTerminalData(data),
        dropped: true,
        dropReason: "malformed-sgr-mouse-report",
        pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      });
      return;
    }

    const inputData = resolveAndroidInputData(data);
    const nextData = entry.transformInput ? entry.transformInput(inputData) : inputData;
    if (nextData.length === 0) {
      logTerminalInputDiagnostics(entry, "client.onData.dropEmpty", {
        stage: "onData",
        rawSummary: summarizeTerminalData(data),
        inputSummary: summarizeTerminalData(inputData),
        nextSummary: summarizeTerminalData(nextData),
        transformed: nextData !== inputData,
        dropped: true,
        dropReason: "empty-transformed-input",
        pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      });
      return;
    }

    const socketReadyState = getSocketReadyState(entry.webSocket);
    const sent = socketReadyState === WebSocket.OPEN;
    // [DEBUG-pty-typing] Track the full input sequence for round-trip matching
    const clientSendSeq = ++entry.diagFrameCount;
    logTerminalInputDiagnostics(entry, "client.onData.send", {
      stage: "onData",
      rawSummary: summarizeTerminalData(data),
      inputSummary: summarizeTerminalData(inputData),
      nextSummary: summarizeTerminalData(nextData),
      transformed: nextData !== inputData,
      sendAttempted: true,
      sent,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      clientSendSeq,
    });

    if (sent) {
      entry.webSocket?.send(nextData);
    }
  });
  const keyDisposable = terminal.onKey(({ domEvent }) => {
    if (domEvent.key === "Enter") {
      if (isCommandEchoed(terminal, commandBuffer)) {
        const nextTitle = sanitizeTitleFromCommand(commandBuffer);
        if (nextTitle) {
          setTerminalTitle(entry, nextTitle);
        }
      }
      commandBuffer = "";
      return;
    }

    if (domEvent.key === "Backspace") {
      commandBuffer = commandBuffer.slice(0, -1);
      return;
    }

    if (domEvent.key === "Escape" || (domEvent.key === "c" && domEvent.ctrlKey)) {
      commandBuffer = "";
      return;
    }

    if (domEvent.key.length === 1 && !domEvent.ctrlKey && !domEvent.metaKey && !domEvent.altKey) {
      commandBuffer += domEvent.key;
    }
  });
  // Detect alternate-screen entry at the parser level instead of regex-matching
  // raw WebSocket chunks: the `\x1b[?1049h` sequence can be split across frames,
  // which made the chunk regex miss it and left full-screen TUIs (opencode/vim)
  // blank until a manual resize. onBufferChange fires once xterm's parser has
  // switched buffers, regardless of how the bytes were framed.
  const bufferChangeDisposable = terminal.buffer.onBufferChange((buffer) => {
    if (entry.disposed) {
      return;
    }
    entry.onAlternateScreen = buffer.type === "alternate";
    if (buffer.type !== "alternate") {
      return;
    }
    debugLog("terminal.render", "altScreen.enter", {
      sessionId: entry.sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
      rendererType: suggestedRendererType ?? "webgl",
      via: "onBufferChange",
    });
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    scheduleReconnectRedrawNudge(entry);
  });

  const titleDisposable = terminal.onTitleChange((title) => {
    setTerminalTitle(entry, title);
  });

  const handleBeforeInput = (event: InputEvent) => {
    logTerminalInputDiagnostics(entry, "client.beforeinput", {
      stage: "beforeinput",
      rawSummary: summarizeMaybeTerminalData(event.data),
      inputType: event.inputType ?? null,
      defaultPrevented: event.defaultPrevented,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });

    if (event.defaultPrevented) {
      return;
    }

    if (
      isComposing
      && event.inputType === "insertReplacementText"
      && typeof event.data === "string"
      && event.data.length > 0
    ) {
      trackComposingText(event.data);
      event.preventDefault();
      return;
    }

    if (typeof event.data !== "string" || event.data.length === 0) {
      return;
    }

    if (isAndroid) {
      pendingAndroidBeforeInputData = event.data;
    }

    const nextData = entry.transformInput ? entry.transformInput(event.data) : event.data;
    if (nextData === event.data || nextData.length === 0) {
      return;
    }

    pendingAndroidBeforeInputData = null;

    entry.suppressedInput = {
      active: true,
      originalData: event.data,
      resetTimerId: entry.suppressedInput.resetTimerId,
    };
    scheduleSuppressedInputReset();
    event.preventDefault();
    if (textarea) {
      textarea.value = "";
    }

    const socketReadyState = getSocketReadyState(entry.webSocket);
    const sent = socketReadyState === WebSocket.OPEN;
    logTerminalInputDiagnostics(entry, "client.beforeinput.send", {
      stage: "beforeinput",
      rawSummary: summarizeTerminalData(event.data),
      nextSummary: summarizeTerminalData(nextData),
      inputType: event.inputType ?? null,
      defaultPrevented: event.defaultPrevented,
      transformed: true,
      sendAttempted: true,
      sent,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });
    if (sent) {
      entry.webSocket?.send(nextData);
    }
  };

  const handleInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    logTerminalInputDiagnostics(entry, "client.input", {
      stage: "input",
      rawSummary: summarizeMaybeTerminalData(inputEvent.data),
      inputType: inputEvent.inputType ?? null,
      defaultPrevented: inputEvent.defaultPrevented,
      suppressed: entry.suppressedInput.active,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });

    if (!isAndroid) {
      // Track composing text on non-Android too, so handleCompositionEnd
      // can recover input when xterm.js clears the textarea first.
      if (isComposing && textarea) {
        trackComposingText(textarea.value);
      }
      return;
    }

    if (entry.suppressedInput.active) {
      inputEvent.preventDefault();
      inputEvent.stopImmediatePropagation();
      if (textarea) {
        textarea.value = "";
      }
      queueMicrotask(() => {
        if (textarea) {
          textarea.value = "";
        }
      });
    }
  };

  const handleCompositionStart = () => {
    isComposing = true;
    lastComposingText = "";
    logTerminalInputDiagnostics(entry, "client.composition.start", {
      stage: "compositionstart",
      suppressed: entry.suppressedInput.active,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });
    if (entry.suppressedInput.active && textarea) {
      textarea.value = "";
    }
  };

  const handleCompositionUpdate = (event: CompositionEvent) => {
    if (typeof event.data === "string" && event.data.length > 0) {
      trackComposingText(event.data);
    } else if (textarea) {
      trackComposingText(textarea.value);
    }
    logTerminalInputDiagnostics(entry, "client.composition.update", {
      stage: "compositionupdate",
      suppressed: entry.suppressedInput.active,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });
  };

  const handleCompositionEnd = (event: CompositionEvent) => {
    isComposing = false;
    logTerminalInputDiagnostics(entry, "client.composition.end", {
      stage: "compositionend",
      suppressed: entry.suppressedInput.active,
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });

    if (entry.suppressedInput.active) {
      lastComposingText = "";
      // Ctrl-transform path: just clear up.
      if (textarea) {
        textarea.value = "";
      }
      queueMicrotask(() => {
        if (textarea) {
          textarea.value = "";
        }
        clearSuppressedInput();
      });
      return;
    }

    // Normal IME composition end. On macOS with CJK input methods, xterm.js
    // may not emit the composed text through its internal onData handler.
    // Read any remaining textarea value (the composed text) and send it
    // directly to the PTY via WebSocket, then clear the textarea.
    // Arm suppressedInput so that if xterm's internal handler ALSO emits the
    // same text via onData, it gets deduplicated.
    if (!textarea) {
      lastComposingText = "";
      return;
    }

    const composed = resolveComposedTerminalInput(
      event.data ?? "",
      textarea.value,
      lastComposingText,
    );
    if (composed !== textarea.value && composed !== (event.data ?? "")) {
      logTerminalInputDiagnostics(entry, "client.composition.end.recovered", {
        stage: "compositionend",
        recoveredLength: composed.length,
      });
    }
    lastComposingText = "";
    if (composed.length > 0) {
      const socketReadyState = getSocketReadyState(entry.webSocket);
      const sent = socketReadyState === WebSocket.OPEN;
      logTerminalInputDiagnostics(entry, "client.composition.end.send", {
        stage: "compositionend",
        composedLength: composed.length,
        sendAttempted: true,
        sent,
      });
      if (sent) {
        entry.webSocket?.send(composed);
      }
      // Arm dedup: if xterm's onData fires with the exact same composed text,
      // suppressOriginalInputIfHandled will match and drop the duplicate.
      entry.suppressedInput = {
        active: true,
        originalData: composed,
        resetTimerId: null,
      };
      scheduleSuppressedInputReset();
      textarea.value = "";
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (isComposing && textarea) {
      trackComposingText(textarea.value);
    }
    logTerminalInputDiagnostics(entry, "client.keydown", {
      stage: "keydown",
      keyboard: summarizeKeyboardEvent(event),
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
    });
  };

  const handleTextareaFocus = () => {
    // [DEBUG-pty-typing] Log full focus context on focus gain
    logTerminalInputDiagnostics(entry, "client.textarea.focus", {
      stage: "focus",
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
    });
  };

  const handleTextareaBlur = () => {
    // [DEBUG-pty-typing] Capture what element stole focus from the xterm textarea
    const activeEl = typeof document !== "undefined" ? document.activeElement : null;
    const stealInfo = activeEl
      ? {
          tag: activeEl instanceof HTMLElement ? activeEl.tagName.toLowerCase() : null,
          id: (activeEl instanceof HTMLElement ? activeEl.id : null) ?? null,
          className: activeEl instanceof HTMLElement ? (activeEl.className?.substring?.(0, 80) ?? null) : null,
          role: (activeEl instanceof HTMLElement ? activeEl.getAttribute("role") : null) ?? null,
          isTextarea: activeEl instanceof HTMLTextAreaElement,
          isInput: activeEl instanceof HTMLInputElement,
          dataTestId: (activeEl instanceof HTMLElement ? activeEl.getAttribute("data-testid") : null) ?? null,
        }
      : { tag: null as string | null, noActiveElement: true, id: null as string | null, className: null as string | null, role: null as string | null, isTextarea: false, isInput: false, dataTestId: null as string | null };
    logTerminalInputDiagnostics(entry, "client.textarea.blur", {
      stage: "blur",
      pendingAndroidBeforeInput: pendingAndroidBeforeInputData !== null,
      focusStealer: stealInfo,
    });
  };

  textarea?.addEventListener("beforeinput", handleBeforeInput);
  textarea?.addEventListener("input", handleInput, true);
  textarea?.addEventListener("compositionstart", handleCompositionStart, true);
  textarea?.addEventListener("compositionupdate", handleCompositionUpdate, true);
  textarea?.addEventListener("compositionend", handleCompositionEnd, true);
  textarea?.addEventListener("keydown", handleKeyDown, true);
  textarea?.addEventListener("focus", handleTextareaFocus);
  textarea?.addEventListener("blur", handleTextareaBlur);

  // [DEBUG-pty-typing] Container-level keydown to detect keystrokes reaching
  // the terminal div but bypassing the xterm textarea (focus not on textarea).
  const handleContainerKeydown = (event: KeyboardEvent) => {
    const isTextareaFocused = textarea && document.activeElement === textarea;
    if (!isTextareaFocused) {
      debugLog("terminal.typing", "[DEBUG-pty-typing] container.keydown.textarea-not-focused", {
        sessionId: entry.sessionId,
        key: event.key,
        code: event.code,
        inputSeq: entry.inputSeq,
        textareaFocused: false,
        activeElementTag: document.activeElement instanceof HTMLElement ? document.activeElement.tagName.toLowerCase() : null,
        activeElementDataTestId: document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-testid") : null,
        connected: entry.connected,
        streamReady: entry.streamReady,
      }, { force: true });
    }
  };
  const wrapperElement = entry.wrapper;
  wrapperElement?.addEventListener("keydown", handleContainerKeydown, true);

  if (container) {
    fitTerminalRuntime(entry);
  }

  connectTerminalRuntime(entry, cwd);

  const runtime: TerminalRuntime = {
    sessionId,
    terminal,
    searchAddon,
    get connected() {
      return entry.connected;
    },
    get title() {
      return entry.title;
    },
    setTransformInput(transform) {
      entry.transformInput = transform;
    },
    setOpenFileHandler(handler) {
      entry.openFileHandler = handler;
    },
    attach(container) {
      mountTerminalWrapper(entry.wrapper, container);
      fitTerminalRuntime(entry);
    },
    detach() {
      mountTerminalWrapper(entry.wrapper, null);
    },
    fit() {
      return fitTerminalRuntime(entry);
    },
    scheduleFitBurst() {
      scheduleFitBurst(entry);
    },
    focus() {
      logTerminalInputDiagnostics(entry, "client.focus.requested", {
        stage: "focus",
      });
      terminal.focus();
    },
    paste(text) {
      terminal.focus();
      terminal.paste(text);
    },
    writeInput(data) {
      const socketReadyState = getSocketReadyState(entry.webSocket);
      const sent = socketReadyState === WebSocket.OPEN;
      logTerminalInputDiagnostics(entry, "client.writeInput.send", {
        stage: "writeInput",
        nextSummary: summarizeTerminalData(data),
        sendAttempted: true,
        sent,
      });
      if (sent) {
        entry.webSocket?.send(data);
      }
    },
    writeLocalMessage(message, colorAnsiCode = 31) {
      terminal.write(`\r\n\x1b[${colorAnsiCode}m[${message}]\x1b[0m\r\n`);
    },
    clear() {
      terminal.clear();
    },
    scrollToBottom() {
      terminal.scrollToBottom();
    },
    findNext(query, options) {
      return searchAddon.findNext(query, options);
    },
    findPrevious(query, options) {
      return searchAddon.findPrevious(query, options);
    },
    clearSearchDecorations() {
      searchAddon.clearDecorations();
    },
    onConnectionStateChange(listener) {
      entry.connectionListeners.add(listener);
      listener(entry.connected);
      return () => {
        entry.connectionListeners.delete(listener);
      };
    },
    onTitleChange(listener) {
      entry.titleListeners.add(listener);
      listener(entry.title);
      return () => {
        entry.titleListeners.delete(listener);
      };
    },
    onSessionExit(listener) {
      entry.sessionExitListeners.add(listener);
      return () => {
        entry.sessionExitListeners.delete(listener);
      };
    },
    reconnectIfNeeded(nextCwd) {
      connectTerminalRuntime(entry, normalizeCwd(nextCwd));
    },
    dispose() {
      if (entry.disposed) {
        return;
      }

      entry.disposed = true;
      entry.connectionListeners.clear();
      entry.titleListeners.clear();
      entry.sessionExitListeners.clear();
      clearScheduledFitBurst(entry);
      clearReconnectRedrawNudges(entry);
      clearStreamGateFallback(entry);
      entry.suppressQueryResponsesDispose();
      if (entry.reconnectTimerId !== null) {
        window.clearTimeout(entry.reconnectTimerId);
        entry.reconnectTimerId = null;
      }
      if (entry.webSocket) {
        entry.webSocket.onclose = null;
        entry.webSocket.close();
        entry.webSocket = null;
      }
      clearSuppressedInput();
      textarea?.removeEventListener("blur", handleTextareaBlur);
      textarea?.removeEventListener("focus", handleTextareaFocus);
      textarea?.removeEventListener("keydown", handleKeyDown, true);
      textarea?.removeEventListener("compositionend", handleCompositionEnd, true);
      textarea?.removeEventListener("compositionupdate", handleCompositionUpdate, true);
      textarea?.removeEventListener("compositionstart", handleCompositionStart, true);
      textarea?.removeEventListener("input", handleInput, true);
      textarea?.removeEventListener("beforeinput", handleBeforeInput);
      keyDisposable.dispose();
      titleDisposable.dispose();
      bufferChangeDisposable.dispose();
      entry.optionalAddonsDispose();
      wrapper.remove();
      terminal.dispose();
      terminalRuntimeRegistry.delete(sessionId);
    },
  };

  return runtime;
}

export function getOrCreateTerminalRuntime(
  sessionId: string,
  cwd: string | null,
  container?: HTMLDivElement | null,
): TerminalRuntime {
  const normalizedCwd = normalizeCwd(cwd);
  const existingRuntime = terminalRuntimeRegistry.get(sessionId);
  if (existingRuntime) {
    existingRuntime.reconnectIfNeeded(normalizedCwd);
    return existingRuntime;
  }

  const runtime = createTerminalRuntime(sessionId, normalizedCwd, container);
  terminalRuntimeRegistry.set(sessionId, runtime);
  return runtime;
}

export function disposeTerminalRuntime(sessionId: string): void {
  terminalRuntimeRegistry.get(sessionId)?.dispose();
}

export function resetTerminalRuntimeRegistryForTests(): void {
  for (const runtime of terminalRuntimeRegistry.values()) {
    runtime.dispose();
  }
  terminalRuntimeRegistry.clear();
  document.getElementById(PARKED_TERMINAL_CONTAINER_ID)?.remove();
}
