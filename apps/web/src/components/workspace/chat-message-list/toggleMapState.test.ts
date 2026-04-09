import { describe, expect, it } from "vitest";
import { setBooleanMapEntry } from "./toggleMapState";

describe("setBooleanMapEntry", () => {
  it("returns the same map when setting a missing key to false", () => {
    const current = new Map<string, boolean>();

    const next = setBooleanMapEntry(current, "row-1", false);

    expect(next).toBe(current);
  });

  it("returns the same map when the next value matches the current value", () => {
    const current = new Map<string, boolean>([["row-1", true]]);

    const next = setBooleanMapEntry(current, "row-1", true);

    expect(next).toBe(current);
  });

  it("creates a new map when the value actually changes", () => {
    const current = new Map<string, boolean>([["row-1", false]]);

    const next = setBooleanMapEntry(current, "row-1", true);

    expect(next).not.toBe(current);
    expect(next.get("row-1")).toBe(true);
    expect(current.get("row-1")).toBe(false);
  });
});
