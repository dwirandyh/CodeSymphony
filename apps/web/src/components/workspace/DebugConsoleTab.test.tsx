import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { logService, type LogEntry } from "../../lib/logService";
import { DebugConsoleTab } from "./DebugConsoleTab";

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 1;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: (() => unknown) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  emit(entry: LogEntry) {
    this.onmessage?.({ data: JSON.stringify(entry) } as MessageEvent<string>);
  }

  emitError() {
    this.onerror?.();
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DebugConsoleTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    logService.clear();

    const initialRemoteEntry: LogEntry = {
      id: "remote-1",
      timestamp: "2026-02-17T10:00:00.000Z",
      level: "info",
      source: "runtime",
      message: "hydrated",
    };
    const reconnectRemoteEntry: LogEntry = {
      id: "remote-2",
      timestamp: "2026-02-17T10:00:05.000Z",
      level: "warn",
      source: "runtime",
      message: "backfilled",
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/logs/client")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { accepted: 1 } }),
        };
      }

      if (url.includes("/logs?since=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [reconnectRemoteEntry] }),
        };
      }

      if (url.endsWith("/logs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [initialRemoteEntry] }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    logService.clear();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("hydrates logs, backfills on reconnect, dedupes ids, and logs debug.console lifecycle events", async () => {
    await act(async () => {
      root.render(<DebugConsoleTab selectedThreadId={null} />);
    });
    await flushEffects();

    expect(logService.getEntries().some((entry) => entry.id === "remote-1")).toBe(true);
    expect(MockEventSource.instances.length).toBe(1);

    const firstStream = MockEventSource.instances[0];
    await act(async () => {
      firstStream?.emit({
        id: "remote-1",
        timestamp: "2026-02-17T10:00:00.000Z",
        level: "info",
        source: "runtime",
        message: "hydrated duplicate",
      });
      await Promise.resolve();
    });
    await flushEffects();

    const entriesAfterDuplicate = logService.getEntries().filter((entry) => entry.id === "remote-1");
    expect(entriesAfterDuplicate).toHaveLength(1);

    await act(async () => {
      firstStream?.emitError();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    await flushEffects();

    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    expect(logService.getEntries().some((entry) => entry.id === "remote-2")).toBe(true);

    const sinceFetchCalled = (fetch as unknown as Mock).mock.calls.some(([input]) =>
      String(input).includes("/logs?since="),
    );
    expect(sinceFetchCalled).toBe(true);

    const debugConsoleEntries = logService.getEntries().filter((entry) => entry.source === "debug.console");
    expect(debugConsoleEntries.some((entry) => entry.message.includes("Backfilled runtime logs"))).toBe(true);
    expect(debugConsoleEntries.some((entry) => entry.message.includes("Connected to runtime log stream"))).toBe(true);
  });

  it("filters log entries by selectedThreadId", async () => {
    // Seed entries: one matching thread, one different thread, one global (no threadId)
    logService.log("info", "runtime", "thread-A log", { threadId: "thread-A" });
    logService.log("info", "runtime", "thread-B log", { threadId: "thread-B" });
    logService.log("info", "runtime", "global log");

    await act(async () => {
      root.render(<DebugConsoleTab selectedThreadId="thread-A" />);
    });
    await flushEffects();

    const rows = container.querySelectorAll(".group");
    const texts = Array.from(rows).map((r) => r.textContent ?? "");

    expect(texts.some((t) => t.includes("thread-A log"))).toBe(true);
    expect(texts.some((t) => t.includes("global log"))).toBe(true);
    expect(texts.some((t) => t.includes("thread-B log"))).toBe(false);
  });
});
