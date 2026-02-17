type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    data?: unknown;
}

type LogSubscriber = (entries: LogEntry[]) => void;

const MAX_ENTRIES = 500;

let idCounter = 0;

const entries: LogEntry[] = [];
const subscribers = new Set<LogSubscriber>();

function notifySubscribers() {
    const snapshot = [...entries];
    for (const subscriber of subscribers) {
        subscriber(snapshot);
    }
}

export const logService = {
    log(
        level: LogLevel,
        source: string,
        message: string,
        data?: unknown,
    ): void {
        idCounter += 1;
        const entry: LogEntry = {
            id: `local-${idCounter}`,
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

        notifySubscribers();
    },

    addRemoteEntry(entry: LogEntry): void {
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) {
            entries.splice(0, entries.length - MAX_ENTRIES);
        }
        notifySubscribers();
    },

    getEntries(): LogEntry[] {
        return [...entries];
    },

    subscribe(callback: LogSubscriber): () => void {
        subscribers.add(callback);
        return () => {
            subscribers.delete(callback);
        };
    },

    clear(): void {
        entries.length = 0;
        notifySubscribers();
    },
};
