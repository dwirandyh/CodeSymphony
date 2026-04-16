import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { debugLog } from "../../lib/debugLog";
import { resolveRuntimeApiBase } from "../../lib/runtimeUrl";
import "@xterm/xterm/css/xterm.css";

function getWsBase(): string {
  const apiBase = resolveRuntimeApiBase();
  return apiBase.replace(/^http/, "ws");
}

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

interface TerminalTabProps {
    sessionId: string;
    cwd: string | null;
    onSessionExit?: (event: { exitCode: number; signal: number }) => void;
    transformInput?: (data: string) => string;
}

export interface TerminalTabHandle {
    sendInput: (data: string) => void;
    focus: () => void;
}

export const TerminalTab = forwardRef<TerminalTabHandle, TerminalTabProps>(function TerminalTab({
    sessionId,
    cwd,
    onSessionExit,
    transformInput,
}: TerminalTabProps, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const disposedRef = useRef(false);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentSessionRef = useRef(sessionId);
    const transformInputRef = useRef(transformInput);
    const [connected, setConnected] = useState(false);
    const isAndroidRef = useRef(false);
    const suppressedInputRef = useRef<{
        active: boolean;
        originalData: string | null;
    }>({
        active: false,
        originalData: null,
    });

    useEffect(() => {
        transformInputRef.current = transformInput;
    }, [transformInput]);

    useEffect(() => {
        isAndroidRef.current = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
    }, []);

    useImperativeHandle(ref, () => ({
        sendInput: (data: string) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        },
        focus: () => {
            terminalRef.current?.focus();
        },
    }), []);

    // When sessionId changes (worktree switch), tear down and reconnect
    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        // If switching session, close old WS first
        currentSessionRef.current = sessionId;
        disposedRef.current = false;

        const sendTerminalData = (data: string) => {
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        };

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
        const webLinksAddon = new WebLinksAddon();

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(webLinksAddon);
        terminal.open(containerRef.current);

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        setTimeout(() => fitAddon.fit(), 50);

        terminal.onData((data) => {
            const nextData = transformInputRef.current ? transformInputRef.current(data) : data;
            if (isAndroidRef.current && data.length <= 2) {
                debugLog("terminal.input", "onData", {
                    sessionId,
                    raw: data,
                    rawCode: data.length === 1 ? data.charCodeAt(0) : null,
                    next: nextData,
                    nextCode: nextData.length === 1 ? nextData.charCodeAt(0) : null,
                });
            }
            sendTerminalData(nextData);
        });

        const textarea = terminal.textarea;
        const handleBeforeInput = (event: InputEvent) => {
            if (isAndroidRef.current) {
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

            const nextData = transformInputRef.current ? transformInputRef.current(event.data) : event.data;
            if (nextData === event.data) {
                return;
            }

            suppressedInputRef.current = {
                active: true,
                originalData: event.data,
            };
            event.preventDefault();
            if (textarea) {
                textarea.value = "";
            }
            sendTerminalData(nextData);
        };

        const handleInput = (event: Event) => {
            if (!isAndroidRef.current) {
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

            if (suppressedInputRef.current.active) {
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

        const handleCompositionEnd = () => {
            if (!suppressedInputRef.current.active) {
                return;
            }

            if (textarea) {
                textarea.value = "";
            }

            queueMicrotask(() => {
                if (textarea) {
                    textarea.value = "";
                }
                suppressedInputRef.current = {
                    active: false,
                    originalData: null,
                };
            });
        };

        const handleCompositionStart = () => {
            if (!suppressedInputRef.current.active) {
                return;
            }

            if (textarea) {
                textarea.value = "";
            }
        };

        textarea?.addEventListener("beforeinput", handleBeforeInput);
        textarea?.addEventListener("input", handleInput, true);
        textarea?.addEventListener("compositionstart", handleCompositionStart, true);
        textarea?.addEventListener("compositionend", handleCompositionEnd, true);

        function connectWebSocket() {
            if (disposedRef.current) {
                return;
            }

            const params = new URLSearchParams({ sessionId });
            if (cwd) {
                params.set("cwd", cwd);
            }

            const ws = new WebSocket(`${getWsBase()}/terminal/ws?${params.toString()}`);
            wsRef.current = ws;

            ws.onopen = () => {
                if (disposedRef.current) {
                    ws.close();
                    return;
                }
                setConnected(true);
                fitAddon.fit();
                const dims = fitAddon.proposeDimensions();
                if (dims) {
                    ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
                }
            };

            ws.onmessage = (event) => {
                if (!disposedRef.current) {
                    const chunk = event.data as string;
                    try {
                        const parsed = JSON.parse(chunk) as Record<string, unknown>;
                        if (
                            parsed.kind === "cs-terminal-event"
                            && parsed.type === "exit"
                            && typeof parsed.exitCode === "number"
                            && typeof parsed.signal === "number"
                        ) {
                            onSessionExit?.({
                                exitCode: parsed.exitCode,
                                signal: parsed.signal,
                            });
                            return;
                        }
                    } catch {
                        // Not an internal event payload; treat as terminal output.
                    }
                    terminal.write(chunk);
                }
            };

            ws.onclose = (event) => {
                setConnected(false);
                if (!disposedRef.current) {
                    const reason = event.reason?.trim();
                    const detail = reason ? ` code=${event.code} reason=${reason}` : ` code=${event.code}`;
                    terminal.write(`\r\n\x1b[33m[Disconnected — reconnecting...${detail}]\x1b[0m\r\n`);
                    reconnectTimerRef.current = setTimeout(connectWebSocket, 2000);
                }
            };

            ws.onerror = () => {
                ws.close();
            };
        }

        connectWebSocket();

        const resizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                if (disposedRef.current) {
                    return;
                }
                fitAddon.fit();
                const dims = fitAddon.proposeDimensions();
                const ws = wsRef.current;
                if (dims && ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
                }
            });
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            disposedRef.current = true;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            resizeObserver.disconnect();
            if (wsRef.current) {
                wsRef.current.onclose = null;
                wsRef.current.close();
                wsRef.current = null;
            }
            textarea?.removeEventListener("compositionend", handleCompositionEnd, true);
            textarea?.removeEventListener("compositionstart", handleCompositionStart, true);
            textarea?.removeEventListener("input", handleInput, true);
            textarea?.removeEventListener("beforeinput", handleBeforeInput);
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
        };
    }, [sessionId, cwd, onSessionExit]);

    return (
        <div className="relative flex h-full flex-col">
            <div className="absolute right-2 top-1 z-10">
                <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${connected
                            ? "bg-green-500/10 text-green-400"
                            : "bg-yellow-500/10 text-yellow-400"
                        }`}
                >
                    <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-green-400" : "bg-yellow-400 animate-pulse"
                            }`}
                    />
                    {connected ? "Connected" : "Connecting..."}
                </span>
            </div>
            <div ref={containerRef} className="min-h-0 flex-1" />
        </div>
    );
});
