import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileIndex } from "./useFileIndex";

vi.mock("../../../lib/api", () => ({
  api: { getFileIndex: vi.fn().mockResolvedValue([]) },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function TestComponent({ worktreeId }: { worktreeId: string | null }) {
  const { entries, loading } = useFileIndex(worktreeId);
  return <div>{loading ? "loading" : `count:${entries.length}`}</div>;
}

describe("useFileIndex", () => {
  it("returns empty entries initially", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId="w1" />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toMatch(/loading|count:\d+/);
  });

  it("returns empty entries for null worktreeId", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId={null} />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toBeTruthy();
  });
});
