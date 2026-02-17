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
    const entryIds = new Set<string>();
    const subscribers = new Set<LogSubscriber>();

    function notifySubscribers(entry: LogEntry): void {
        for (const subscriber of subscribers) {
            try {
                subscriber(entry);
            } catch {
                // ignore subscriber errors
            }
        }
    }

    function trimOverflow(): void {
        if (entries.length <= MAX_ENTRIES) {
            return;
        }

        const overflowCount = entries.length - MAX_ENTRIES;
        const removed = entries.splice(0, overflowCount);
        for (const entry of removed) {
            entryIds.delete(entry.id);
        }
    }

    function appendEntry(entry: LogEntry): boolean {
        if (entryIds.has(entry.id)) {
            return false;
        }

        entries.push(entry);
        entryIds.add(entry.id);
        trimOverflow();
        notifySubscribers(entry);
        return true;
    }

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

        appendEntry(entry);
    }

    function ingest(entry: LogEntry): boolean {
        return appendEntry(entry);
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
        entryIds.clear();
    }

    return { log, ingest, getEntries, subscribe, clear };
}
