import { resolveRuntimeApiBase } from "./runtimeUrl";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
const MIRROR_BATCH_SIZE = 20;
const MIRROR_DEBOUNCE_MS = 200;
const MIRROR_INITIAL_RETRY_MS = 500;
const MIRROR_MAX_RETRY_MS = 8000;

const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const entries: LogEntry[] = [];
const entryIds = new Set<string>();
const subscribers = new Set<LogSubscriber>();
const mirrorQueue: LogEntry[] = [];

let idCounter = 0;
let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorFlushInFlight = false;
let mirrorRetryDelayMs = MIRROR_INITIAL_RETRY_MS;

function notifySubscribers() {
    const snapshot = [...entries];
    for (const subscriber of subscribers) {
        subscriber(snapshot);
    }
}

function trimOverflow() {
    if (entries.length <= MAX_ENTRIES) {
        return;
    }

    const overflowCount = entries.length - MAX_ENTRIES;
    const removed = entries.splice(0, overflowCount);
    for (const entry of removed) {
        entryIds.delete(entry.id);
    }
}

function addEntries(newEntries: LogEntry[]): number {
    let inserted = 0;
    for (const entry of newEntries) {
        if (entryIds.has(entry.id)) {
            continue;
        }

        entries.push(entry);
        entryIds.add(entry.id);
        inserted += 1;
    }

    if (inserted > 0) {
        trimOverflow();
        notifySubscribers();
    }

    return inserted;
}

function scheduleMirrorFlush(delayMs: number) {
    if (mirrorTimer) {
        return;
    }

    mirrorTimer = setTimeout(() => {
        mirrorTimer = null;
        void flushMirrorQueue();
    }, delayMs);
}

async function postMirrorBatch(batch: LogEntry[]): Promise<void> {
  if (typeof fetch !== "function") {
    return;
  }

  const response = await fetch(`${resolveRuntimeApiBase()}/logs/client`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
        },
        body: JSON.stringify({ entries: batch }),
    });

    if (!response.ok) {
        throw new Error(`Failed to mirror logs: ${response.status}`);
    }
}

async function flushMirrorQueue(): Promise<void> {
    if (mirrorFlushInFlight || mirrorQueue.length === 0) {
        return;
    }

    mirrorFlushInFlight = true;
    const batch = mirrorQueue.splice(0, MIRROR_BATCH_SIZE);

    try {
        await postMirrorBatch(batch);
        mirrorRetryDelayMs = MIRROR_INITIAL_RETRY_MS;
    } catch {
        mirrorQueue.unshift(...batch);
        scheduleMirrorFlush(mirrorRetryDelayMs);
        mirrorRetryDelayMs = Math.min(mirrorRetryDelayMs * 2, MIRROR_MAX_RETRY_MS);
    } finally {
        mirrorFlushInFlight = false;
    }

    if (mirrorQueue.length > 0 && !mirrorTimer) {
        scheduleMirrorFlush(0);
    }
}

function enqueueMirror(entry: LogEntry): void {
    mirrorQueue.push(entry);
    scheduleMirrorFlush(MIRROR_DEBOUNCE_MS);
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
            id: `web-${SESSION_ID}-${idCounter}`,
            timestamp: new Date().toISOString(),
            level,
            source,
            message,
            data,
        };

        if (addEntries([entry]) > 0) {
            enqueueMirror(entry);
        }
    },

    addRemoteEntry(entry: LogEntry): void {
        addEntries([entry]);
    },

    addRemoteEntries(remoteEntries: LogEntry[]): void {
        addEntries(remoteEntries);
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
        entryIds.clear();
        mirrorQueue.length = 0;
        if (mirrorTimer) {
            clearTimeout(mirrorTimer);
            mirrorTimer = null;
        }
        mirrorRetryDelayMs = MIRROR_INITIAL_RETRY_MS;
        notifySubscribers();
    },
};
