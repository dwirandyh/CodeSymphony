import { randomUUID } from "node:crypto";
import type { RuntimeLogEntry, RuntimeLogFilter } from "../types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = RuntimeLogEntry;

type LogFilter = RuntimeLogFilter;

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

    function matchesFilter(entry: LogEntry, filter?: LogFilter): boolean {
        if (!filter) {
            return true;
        }

        if (filter.worktreeId && entry.worktreeId !== filter.worktreeId) {
            return false;
        }

        if (filter.threadId && entry.threadId !== filter.threadId) {
            return false;
        }

        if (filter.since) {
            const sinceTime = new Date(filter.since).getTime();
            if (new Date(entry.timestamp).getTime() <= sinceTime) {
                return false;
            }
        }

        return true;
    }

    function log(
        level: LogLevel,
        source: string,
        message: string,
        data?: unknown,
        scope?: Pick<LogEntry, "worktreeId" | "threadId">,
    ): void {
        const entry: LogEntry = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            level,
            source,
            message,
            data,
            ...(scope?.worktreeId ? { worktreeId: scope.worktreeId } : {}),
            ...(scope?.threadId ? { threadId: scope.threadId } : {}),
        };

        appendEntry(entry);
    }

    function ingest(entry: LogEntry): boolean {
        return appendEntry(entry);
    }

    function getEntries(filter?: LogFilter): LogEntry[] {
        return entries.filter((entry) => matchesFilter(entry, filter));
    }

    function subscribe(callback: LogSubscriber, filter?: LogFilter): () => void {
        const subscriber: LogSubscriber = (entry) => {
            if (matchesFilter(entry, filter)) {
                callback(entry);
            }
        };
        subscribers.add(subscriber);
        return () => {
            subscribers.delete(subscriber);
        };
    }

    function clear(): void {
        entries.length = 0;
        entryIds.clear();
    }

    return { log, ingest, getEntries, subscribe, clear };
}
