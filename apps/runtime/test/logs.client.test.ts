import { describe, expect, it } from "vitest";
import { __testing } from "../src/routes/logs";

describe("logs client normalization", () => {
  it("prefixes source and trims message", () => {
    const normalized = __testing.normalizeClientLogEntry(
      {
        id: "entry-1",
        timestamp: "2026-02-17T10:00:00.000Z",
        level: "info",
        source: "chat.sync",
        message: "  mirrored message  ",
      },
      "2026-02-17T12:00:00.000Z",
    );

    expect(normalized.source).toBe("web.chat.sync");
    expect(normalized.message).toBe("mirrored message");
    expect(normalized.timestamp).toBe("2026-02-17T10:00:00.000Z");
  });

  it("falls back to server timestamp for invalid client timestamp", () => {
    const normalized = __testing.normalizeClientLogEntry(
      {
        id: "entry-2",
        timestamp: "invalid",
        level: "warn",
        source: "web.debug.console",
        message: "timestamp failed",
      },
      "2026-02-17T12:00:00.000Z",
    );

    expect(normalized.timestamp).toBe("2026-02-17T12:00:00.000Z");
  });

  it("rejects oversized batch", () => {
    const payload = {
      entries: Array.from({ length: __testing.MAX_CLIENT_LOG_BATCH + 1 }, (_, index) => ({
        id: `entry-${index}`,
        timestamp: "2026-02-17T10:00:00.000Z",
        level: "debug" as const,
        source: "debug.console",
        message: "ok",
      })),
    };

    expect(() => __testing.ClientLogBatchSchema.parse(payload)).toThrowError();
  });

  it("caps long messages", () => {
    const longMessage = "x".repeat(__testing.MAX_CLIENT_MESSAGE_CHARS + 15);
    const normalized = __testing.normalizeClientLogEntry(
      {
        id: "entry-3",
        timestamp: "2026-02-17T10:00:00.000Z",
        level: "debug",
        source: "debug.console",
        message: longMessage,
      },
      "2026-02-17T12:00:00.000Z",
    );

    expect(normalized.message).toHaveLength(__testing.MAX_CLIENT_MESSAGE_CHARS);
  });
});
