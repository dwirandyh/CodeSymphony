import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const WS_BASE =
    typeof window === "undefined"
        ? "ws://127.0.0.1:4321/api"
        : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.hostname}:4321/api`;

interface TerminalTabProps {
    sessionId: string;
    cwd: string | null;
}

export function TerminalTab({ sessionId, cwd }: TerminalTabProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const disposedRef = useRef(false);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentSessionRef = useRef(sessionId);
    const [connected, setConnected] = useState(false);

    // When sessionId changes (worktree switch), tear down and reconnect
    useEffect(() => {
        if (!containerRef.current) {
            return;
        }

        // If switching session, close old WS first
        currentSessionRef.current = sessionId;
        disposedRef.current = false;

        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
            lineHeight: 1.3,
            theme: {
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
            },
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
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
            }
        });

        function connectWebSocket() {
            if (disposedRef.current) {
                return;
            }

            const params = new URLSearchParams({ sessionId });
            if (cwd) {
                params.set("cwd", cwd);
            }

            const ws = new WebSocket(`${WS_BASE}/terminal/ws?${params.toString()}`);
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
                    terminal.write(event.data as string);
                }
            };

            ws.onclose = () => {
                setConnected(false);
                if (!disposedRef.current) {
                    terminal.write("\r\n\x1b[33m[Disconnected — reconnecting...]\x1b[0m\r\n");
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
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
        };
    }, [sessionId, cwd]);

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
}
