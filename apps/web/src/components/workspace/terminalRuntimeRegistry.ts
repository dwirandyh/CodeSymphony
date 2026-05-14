import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable, ILink } from "@xterm/xterm";
import { debugLog } from "../../lib/debugLog";
import { resolveRuntimeApiBase } from "../../lib/runtimeUrl";
import { parseFileLocation } from "../../lib/worktree";

const FIT_RETRY_DELAYS_MS = [0, 48, 120, 240, 400];
const RECONNECT_REDRAW_NUDGE_DELAYS_MS = [120, 360];
const RECONNECT_REDRAW_RESTORE_DELAY_MS = 48;
const MIN_VALID_TERMINAL_COLS = 2;
const MIN_VALID_TERMINAL_ROWS = 2;
const PARKED_TERMINAL_CONTAINER_ID = "cs-terminal-runtime-parking";
const MAX_TERMINAL_TITLE_LENGTH = 32;

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
  wrapper: HTMLDivElement;
  webSocket: WebSocket | null;
  reconnectTimerId: number | null;
  fitTimerIds: number[];
  fitAnimationFrameIds: number[];
  redrawTimerIds: number[];
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
  const nextWebSocket = new WebSocket(nextUrl);
  entry.webSocket = nextWebSocket;

  nextWebSocket.onopen = () => {
    if (entry.disposed || entry.webSocket !== nextWebSocket) {
      nextWebSocket.close();
      return;
    }

    setConnected(entry, true);
    fitTerminalRuntime(entry);
    scheduleFitBurst(entry);
    scheduleReconnectRedrawNudge(entry);
  };

  nextWebSocket.onmessage = (event) => {
    if (entry.disposed || entry.webSocket !== nextWebSocket) {
      return;
    }

    const chunk = event.data as string;
    try {
      const parsed = JSON.parse(chunk) as Record<string, unknown>;
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
        return;
      }
    } catch {
      // Not an internal event payload; treat as terminal output.
    }

    entry.terminal.write(chunk);
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
    lineHeight: 1.3,
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
  const defaultTitle = getDefaultTerminalTitle(sessionId, cwd);
  let commandBuffer = "";

  const entry: TerminalRuntimeEntry = {
    sessionId,
    cwd,
    terminal,
    fitAddon,
    searchAddon,
    wrapper,
    webSocket: null,
    reconnectTimerId: null,
    fitTimerIds: [],
    fitAnimationFrameIds: [],
    redrawTimerIds: [],
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
    },
  };

  createTerminalFileLinkProvider(entry);

  terminal.onData((data) => {
    const nextData = entry.transformInput ? entry.transformInput(data) : data;
    if (nextData.length === 0) {
      return;
    }

    if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent) && data.length <= 2) {
      debugLog("terminal.input", "onData", {
        sessionId,
        raw: data,
        rawCode: data.length === 1 ? data.charCodeAt(0) : null,
        next: nextData,
        nextCode: nextData.length === 1 ? nextData.charCodeAt(0) : null,
      });
    }

    if (entry.webSocket?.readyState === WebSocket.OPEN) {
      entry.webSocket.send(nextData);
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
  const titleDisposable = terminal.onTitleChange((title) => {
    setTerminalTitle(entry, title);
  });

  const textarea = terminal.textarea;
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

  const handleBeforeInput = (event: InputEvent) => {
    if (isAndroid) {
      debugLog("terminal.input", "beforeinput", {
        sessionId,
        data: event.data ?? null,
        inputType: event.inputType ?? null,
        defaultPrevented: event.defaultPrevented,
      });
    }

    if (event.defaultPrevented || typeof event.data !== "string" || event.data.length === 0) {
      return;
    }

    const nextData = entry.transformInput ? entry.transformInput(event.data) : event.data;
    if (nextData === event.data || nextData.length === 0) {
      return;
    }

    entry.suppressedInput = {
      active: true,
      originalData: event.data,
    };
    event.preventDefault();
    if (textarea) {
      textarea.value = "";
    }

    if (entry.webSocket?.readyState === WebSocket.OPEN) {
      entry.webSocket.send(nextData);
    }
  };

  const handleInput = (event: Event) => {
    if (!isAndroid) {
      return;
    }

    const inputEvent = event as InputEvent;
    debugLog("terminal.input", "input", {
      sessionId,
      data: inputEvent.data ?? null,
      inputType: inputEvent.inputType ?? null,
      value: textarea?.value ?? null,
      defaultPrevented: inputEvent.defaultPrevented,
    });

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
    if (entry.suppressedInput.active && textarea) {
      textarea.value = "";
    }
  };

  const handleCompositionEnd = () => {
    if (!entry.suppressedInput.active) {
      return;
    }

    if (textarea) {
      textarea.value = "";
    }

    queueMicrotask(() => {
      if (textarea) {
        textarea.value = "";
      }
      entry.suppressedInput = {
        active: false,
        originalData: null,
      };
    });
  };

  textarea?.addEventListener("beforeinput", handleBeforeInput);
  textarea?.addEventListener("input", handleInput, true);
  textarea?.addEventListener("compositionstart", handleCompositionStart, true);
  textarea?.addEventListener("compositionend", handleCompositionEnd, true);

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
      terminal.focus();
    },
    paste(text) {
      terminal.focus();
      terminal.paste(text);
    },
    writeInput(data) {
      if (entry.webSocket?.readyState === WebSocket.OPEN) {
        entry.webSocket.send(data);
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
      if (entry.reconnectTimerId !== null) {
        window.clearTimeout(entry.reconnectTimerId);
        entry.reconnectTimerId = null;
      }
      if (entry.webSocket) {
        entry.webSocket.onclose = null;
        entry.webSocket.close();
        entry.webSocket = null;
      }
      textarea?.removeEventListener("compositionend", handleCompositionEnd, true);
      textarea?.removeEventListener("compositionstart", handleCompositionStart, true);
      textarea?.removeEventListener("input", handleInput, true);
      textarea?.removeEventListener("beforeinput", handleBeforeInput);
      keyDisposable.dispose();
      titleDisposable.dispose();
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
