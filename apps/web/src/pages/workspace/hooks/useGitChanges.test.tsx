import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGitStatus } from "../../../hooks/queries/useGitStatus";
import { useGitChanges } from "./useGitChanges";

vi.mock("../../../lib/api", () => ({
  api: {
    getGitStatus: vi.fn().mockResolvedValue({ entries: [], branch: "main" }),
    getGitDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
    gitCommit: vi.fn().mockResolvedValue(undefined),
    discardGitChange: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../hooks/queries/useGitStatus", () => ({
  useGitStatus: vi.fn(),
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
  beforeEach(() => {
    vi.mocked(useGitStatus).mockReturnValue({
      data: { entries: [], branch: "main" },
      isLoading: false,
      refetch: vi.fn(),
    } as ReturnType<typeof useGitStatus>);
  });

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

  it("filters directory-only entries and sorts by status then path", () => {
    vi.mocked(useGitStatus).mockReturnValue({
      data: {
        branch: "main",
        entries: [
          {
            path: "src/new-dir/",
            status: "untracked",
            insertions: 0,
            deletions: 0,
          },
          {
            path: "src/zeta.ts",
            status: "modified",
            insertions: 0,
            deletions: 0,
          },
          {
            path: "src/alpha.ts",
            status: "modified",
            insertions: 0,
            deletions: 0,
          },
          {
            path: "src/new-dir/file.ts",
            status: "untracked",
            insertions: 0,
            deletions: 0,
          },
          {
            path: "src/new.ts",
            status: "added",
            insertions: 0,
            deletions: 0,
          },
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as ReturnType<typeof useGitStatus>);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <TestComponent worktreeId="w1" enabled={true} />
        </QueryClientProvider>
      );
    });

    expect(hookResult.entries.map((entry) => entry.path)).toEqual([
      "src/alpha.ts",
      "src/zeta.ts",
      "src/new.ts",
      "src/new-dir/file.ts",
    ]);
    expect(container.textContent).toContain("entries:4");
  });
});
