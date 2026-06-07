import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./formatRelativeTime";

const NOW = Date.parse("2026-06-06T00:00:00Z");

function isoAgo(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe("formatRelativeTime", () => {
  it("returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(isoAgo(5), NOW)).toBe("just now");
    expect(formatRelativeTime(isoAgo(59), NOW)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime(isoAgo(60), NOW)).toBe("1m ago");
    expect(formatRelativeTime(isoAgo(59 * 60), NOW)).toBe("59m ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(isoAgo(60 * 60), NOW)).toBe("1h ago");
    expect(formatRelativeTime(isoAgo(23 * 60 * 60), NOW)).toBe("23h ago");
  });

  it("formats days like the design (24d ago) all the way to a month", () => {
    expect(formatRelativeTime(isoAgo(24 * 24 * 60 * 60), NOW)).toBe("24d ago");
    expect(formatRelativeTime(isoAgo(24 * 60 * 60), NOW)).toBe("1d ago");
    expect(formatRelativeTime(isoAgo(7 * 24 * 60 * 60), NOW)).toBe("7d ago");
    expect(formatRelativeTime(isoAgo(29 * 24 * 60 * 60), NOW)).toBe("29d ago");
  });

  it("formats months", () => {
    expect(formatRelativeTime(isoAgo(30 * 24 * 60 * 60), NOW)).toBe("1mo ago");
  });

  it("formats years", () => {
    expect(formatRelativeTime(isoAgo(365 * 24 * 60 * 60), NOW)).toBe("1y ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(formatRelativeTime(isoAgo(-120), NOW)).toBe("just now");
  });

  it("returns empty string for invalid input", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("");
  });
});
