import { describe, it, expect } from "vitest";
import { createQueryClient } from "./queryClient";

describe("createQueryClient", () => {
  it("returns a QueryClient instance", () => {
    const client = createQueryClient();
    expect(client).toBeDefined();
    expect(typeof client.getDefaultOptions).toBe("function");
  });

  it("has expected default query options", () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.retry).toBe(1);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it("creates independent instances", () => {
    const a = createQueryClient();
    const b = createQueryClient();
    expect(a).not.toBe(b);
  });
});
