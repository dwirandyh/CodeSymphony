import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logService, type LogEntry } from "./logService";

async function flushMicrotasks(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe("web logService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { accepted: 1 } }),
      }),
    );
    logService.clear();
  });

  afterEach(() => {
    logService.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("mirrors local logs and dedupes matching remote entries by id", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    logService.log("info", "chat.stream", "Tool lifecycle started");

    const localEntry = logService.getEntries()[0];
    expect(localEntry).toBeDefined();
    expect(localEntry?.id.startsWith("web-")).toBe(true);

    logService.addRemoteEntry(localEntry as LogEntry);
    expect(logService.getEntries()).toHaveLength(1);

    vi.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { entries: LogEntry[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.id).toBe(localEntry?.id);
  });

  it("retries mirror batch after transient failure", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockResolvedValue({}),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ data: { accepted: 1 } }),
      });

    logService.log("warn", "debug.console", "Retry me");

    vi.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adds remote batch in order and keeps max capacity", () => {
    const remoteEntries = Array.from({ length: 505 }, (_, index) => ({
      id: `remote-${index}`,
      timestamp: `2026-02-17T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
      level: "debug" as const,
      source: "runtime.test",
      message: `message-${index}`,
    }));

    logService.addRemoteEntries(remoteEntries);

    const entries = logService.getEntries();
    expect(entries).toHaveLength(500);
    expect(entries[0]?.id).toBe("remote-5");
    expect(entries[499]?.id).toBe("remote-504");
  });
});
