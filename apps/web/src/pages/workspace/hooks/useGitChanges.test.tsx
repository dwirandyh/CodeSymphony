import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitChanges } from "./useGitChanges";

vi.mock("../../../lib/api", () => ({
  api: {
    getGitStatus: vi.fn().mockResolvedValue({ entries: [], branch: "main" }),
    getGitDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
    gitCommit: vi.fn().mockResolvedValue(undefined),
    discardGitChange: vi.fn().mockResolvedValue(undefined),
  },
}));

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useGitChanges>;

function TestComponent({ worktreeId, enabled }: { worktreeId: string | null; enabled: boolean }) {
  hookResult = useGitChanges(worktreeId, enabled);
  return (
    <div>
      entries:{hookResult.entries.length},branch:{hookResult.branch},loading:{String(hookResult.loading)}
    </div>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useGitChanges", () => {
  it("returns empty entries initially", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId="w1" enabled={true} />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toContain("entries:0");
  });

  it("returns empty branch for null worktreeId", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId={null} enabled={false} />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toContain("branch:");
  });

  it("exposes commit and discardChange functions", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId="w1" enabled={true} />
        </QueryClientProvider>
      );
    });
    expect(typeof hookResult.commit).toBe("function");
    expect(typeof hookResult.discardChange).toBe("function");
    expect(typeof hookResult.getDiff).toBe("function");
    expect(typeof hookResult.refresh).toBe("function");
  });
});
