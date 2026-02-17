import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    data?: unknown;
}

type LogSubscriber = (entry: LogEntry) => void;

const MAX_ENTRIES = 1000;

export function createLogService() {
    const entries: LogEntry[] = [];
    const subscribers = new Set<LogSubscriber>();

    function log(
        level: LogLevel,
        source: string,
        message: string,
        data?: unknown,
    ): void {
        const entry: LogEntry = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            level,
            source,
            message,
            data,
        };

        entries.push(entry);
        if (entries.length > MAX_ENTRIES) {
            entries.splice(0, entries.length - MAX_ENTRIES);
        }

        for (const subscriber of subscribers) {
            try {
                subscriber(entry);
            } catch {
                // ignore subscriber errors
            }
        }
    }

    function getEntries(since?: string): LogEntry[] {
        if (!since) {
            return [...entries];
        }

        const sinceTime = new Date(since).getTime();
        return entries.filter(
            (entry) => new Date(entry.timestamp).getTime() > sinceTime,
        );
    }

    function subscribe(callback: LogSubscriber): () => void {
        subscribers.add(callback);
        return () => {
            subscribers.delete(callback);
        };
    }

    function clear(): void {
        entries.length = 0;
    }

    return { log, getEntries, subscribe, clear };
}
