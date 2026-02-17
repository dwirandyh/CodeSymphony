import { describe, expect, it } from "vitest";
import { createLogService, type LogEntry } from "../src/services/logService";

describe("runtime logService", () => {
  it("ingests entry while preserving id", () => {
    const service = createLogService();
    const entry: LogEntry = {
      id: "web-entry-1",
      timestamp: "2026-02-17T10:00:00.000Z",
      level: "info",
      source: "web.debug.console",
      message: "hello",
    };

    const accepted = service.ingest(entry);

    expect(accepted).toBe(true);
    expect(service.getEntries()).toEqual([entry]);
  });

  it("dedupes duplicate ids", () => {
    const service = createLogService();
    const entry: LogEntry = {
      id: "duplicate-id",
      timestamp: "2026-02-17T10:00:00.000Z",
      level: "debug",
      source: "web.chat.stream",
      message: "one",
    };

    expect(service.ingest(entry)).toBe(true);
    expect(service.ingest({ ...entry, message: "two" })).toBe(false);
    expect(service.getEntries()).toHaveLength(1);
    expect(service.getEntries()[0]?.message).toBe("one");
  });

  it("keeps max ring size and drops oldest entries", () => {
    const service = createLogService();
    for (let index = 0; index < 1005; index += 1) {
      service.ingest({
        id: `entry-${index}`,
        timestamp: `2026-02-17T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
        level: "debug",
        source: "web.chat.stream",
        message: `message-${index}`,
      });
    }

    const entries = service.getEntries();
    expect(entries).toHaveLength(1000);
    expect(entries[0]?.id).toBe("entry-5");
    expect(entries[999]?.id).toBe("entry-1004");
  });
});
