import { useEffect, useMemo, useRef, useState } from "react";
import { logService, type LogEntry } from "../../lib/logService";
import { ScrollArea } from "../ui/scroll-area";

const RUNTIME_BASE =
    typeof window === "undefined"
        ? "http://127.0.0.1:4321/api"
        : `${window.location.protocol}//${window.location.hostname}:4321/api`;

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_COLORS: Record<LogLevel, string> = {
    debug: "text-zinc-400",
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
};

const LEVEL_BG: Record<LogLevel, string> = {
    debug: "bg-zinc-500/10 border-zinc-500/20",
    info: "bg-blue-500/10 border-blue-500/20",
    warn: "bg-yellow-500/10 border-yellow-500/20",
    error: "bg-red-500/10 border-red-500/20",
};

function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
    } as Intl.DateTimeFormatOptions);
}

interface DebugConsoleTabProps {
    selectedThreadId: string | null;
}

function extractThreadId(data: unknown): string | null {
    if (
        data != null &&
        typeof data === "object" &&
        "threadId" in data &&
        typeof (data as Record<string, unknown>).threadId === "string" &&
        ((data as Record<string, unknown>).threadId as string).length > 0
    ) {
        return (data as Record<string, unknown>).threadId as string;
    }
    return null;
}

export function DebugConsoleTab({ selectedThreadId }: DebugConsoleTabProps) {
    const [entries, setEntries] = useState<LogEntry[]>(() => logService.getEntries());
    const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(
        () => new Set(["debug", "info", "warn", "error"]),
    );
    const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
    const bottomRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const lastRemoteTimestampRef = useRef<string | null>(null);

    useEffect(() => {
        return logService.subscribe((nextEntries) => {
            setEntries(nextEntries);
        });
    }, []);

    useEffect(() => {
        let eventSource: EventSource | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;

        function rememberRemoteTimestamp(timestamp: string): void {
            const parsed = Date.parse(timestamp);
            if (!Number.isFinite(parsed)) {
                return;
            }

            const current = lastRemoteTimestampRef.current;
            if (!current) {
                lastRemoteTimestampRef.current = new Date(parsed).toISOString();
                return;
            }

            const currentParsed = Date.parse(current);
            if (!Number.isFinite(currentParsed) || parsed > currentParsed) {
                lastRemoteTimestampRef.current = new Date(parsed).toISOString();
            }
        }

        async function fetchLogs(since?: string): Promise<void> {
            const url = new URL(`${RUNTIME_BASE}/logs`);
            if (since) {
                url.searchParams.set("since", since);
            }

            const response = await fetch(url.toString());
            if (!response.ok) {
                throw new Error(`Failed to fetch logs: ${response.status}`);
            }

            const payload = (await response.json()) as { data?: LogEntry[] };
            const remoteEntries = Array.isArray(payload.data) ? payload.data : [];
            if (remoteEntries.length > 0) {
                logService.addRemoteEntries(remoteEntries);
                for (const entry of remoteEntries) {
                    rememberRemoteTimestamp(entry.timestamp);
                }
            }

            logService.log("debug", "debug.console", "Backfilled runtime logs", {
                since: since ?? null,
                count: remoteEntries.length,
            });
        }

        async function connect(isReconnect = false): Promise<void> {
            const since = isReconnect ? lastRemoteTimestampRef.current ?? undefined : undefined;
            try {
                await fetchLogs(since);
            } catch (error) {
                logService.log("warn", "debug.console", "Failed to backfill runtime logs", {
                    since: since ?? null,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            if (disposed) {
                return;
            }

            eventSource = new EventSource(`${RUNTIME_BASE}/logs/stream`);
            logService.log("info", "debug.console", "Connected to runtime log stream", {
                reconnect: isReconnect,
            });

            eventSource.onmessage = (event) => {
                try {
                    const entry = JSON.parse(event.data as string) as LogEntry;
                    logService.addRemoteEntry(entry);
                    rememberRemoteTimestamp(entry.timestamp);
                } catch {
                    logService.log("warn", "debug.console", "Failed to parse log stream entry");
                }
            };

            eventSource.onerror = () => {
                if (disposed) {
                    return;
                }
                eventSource?.close();
                eventSource = null;

                if (reconnectTimer) {
                    return;
                }

                const delayMs = 3000;
                logService.log("warn", "debug.console", "Runtime log stream disconnected; scheduling reconnect", {
                    delayMs,
                });
                reconnectTimer = setTimeout(() => {
                    reconnectTimer = null;
                    void connect(true);
                }, delayMs);
            };
        }

        void connect(false);

        return () => {
            disposed = true;
            eventSource?.close();
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }
        };
    }, []);

    // Auto-scroll to bottom
    useEffect(() => {
        if (autoScroll && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [entries, autoScroll]);

    const filteredEntries = useMemo(() => {
        return entries.filter((entry) => {
            if (!activeFilters.has(entry.level)) return false;
            if (selectedThreadId == null) return true;
            const entryThreadId = extractThreadId(entry.data);
            if (entryThreadId == null) return true;
            return entryThreadId === selectedThreadId;
        });
    }, [entries, activeFilters, selectedThreadId]);

    function toggleFilter(level: LogLevel) {
        setActiveFilters((prev) => {
            const next = new Set(prev);
            if (next.has(level)) {
                if (next.size > 1) {
                    next.delete(level);
                }
            } else {
                next.add(level);
            }
            return next;
        });
    }

    function toggleExpanded(id: string) {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
                <div className="flex items-center gap-1">
                    {(["error", "warn", "info", "debug"] as LogLevel[]).map((level) => (
                        <button
                            key={level}
                            type="button"
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-all ${activeFilters.has(level)
                                    ? `${LEVEL_BG[level]} ${LEVEL_COLORS[level]}`
                                    : "border-border/20 text-muted-foreground/40"
                                }`}
                            onClick={() => toggleFilter(level)}
                        >
                            {level}
                        </button>
                    ))}
                </div>

                <div className="flex-1" />

                <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                        className="h-3 w-3 rounded border-border/40"
                    />
                    Auto-scroll
                </label>

                <span className="text-[10px] text-muted-foreground/60">
                    {filteredEntries.length}/{entries.length}
                </span>

                <button
                    type="button"
                    className="rounded-md border border-border/30 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => logService.clear()}
                >
                    Clear
                </button>
            </div>

            {/* Log entries */}
            <ScrollArea className="min-h-0 flex-1">
                <div className="p-1">
                    {filteredEntries.length === 0 ? (
                        <div className="px-3 py-6 text-center text-xs text-muted-foreground/50">
                            No log entries yet. Logs from the runtime and frontend will appear here.
                        </div>
                    ) : (
                        <div className="space-y-px">
                            {filteredEntries.map((entry) => {
                                const isExpanded = expandedIds.has(entry.id);
                                const hasData = entry.data !== undefined && entry.data !== null;

                                return (
                                    <div
                                        key={entry.id}
                                        className={`group rounded px-2 py-0.5 font-mono text-[11px] leading-relaxed transition-colors hover:bg-secondary/30 ${hasData ? "cursor-pointer" : ""
                                            }`}
                                        onClick={() => hasData && toggleExpanded(entry.id)}
                                    >
                                        <div className="flex items-start gap-2">
                                            <span className="shrink-0 text-muted-foreground/50">
                                                {formatTime(entry.timestamp)}
                                            </span>
                                            <span
                                                className={`shrink-0 w-[38px] text-right uppercase font-semibold ${LEVEL_COLORS[entry.level]}`}
                                            >
                                                {entry.level}
                                            </span>
                                            <span className="shrink-0 text-muted-foreground/60">
                                                [{entry.source}]
                                            </span>
                                            <span className="text-foreground/90">{entry.message}</span>
                                            {hasData && !isExpanded && (
                                                <span className="shrink-0 text-muted-foreground/30 opacity-0 transition-opacity group-hover:opacity-100">
                                                    ▶
                                                </span>
                                            )}
                                        </div>

                                        {hasData && isExpanded && (
                                            <pre className="ml-[100px] mt-1 overflow-x-auto rounded border border-border/20 bg-background/40 p-2 text-[10px] leading-relaxed text-foreground/70">
                                                {JSON.stringify(entry.data, null, 2)}
                                            </pre>
                                        )}
                                    </div>
                                );
                            })}
                            <div ref={bottomRef} />
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
}
