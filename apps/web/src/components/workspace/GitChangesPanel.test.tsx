import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { useGitStatus } from "../../hooks/queries/useGitStatus";
import { useGitChanges } from "../../pages/workspace/hooks/useGitChanges";
import { GitChangesPanel } from "./GitChangesPanel";

vi.mock("../../lib/api", () => ({
  api: {
    openFileDefaultApp: vi.fn(),
    getGitDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
    gitCommit: vi.fn().mockResolvedValue(undefined),
    discardGitChange: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../hooks/queries/useGitStatus", () => ({
  useGitStatus: vi.fn(),
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

function makeEntry(overrides: Partial<GitChangeEntry> = {}): GitChangeEntry {
  return {
    path: "src/index.ts",
    status: "modified",
    insertions: 0,
    deletions: 0,
    ...overrides,
  } as GitChangeEntry;
}

function HookBackedPanel({ worktreeId, enabled }: { worktreeId: string | null; enabled: boolean }) {
  const git = useGitChanges(worktreeId, enabled);

  return (
    <GitChangesPanel
      entries={git.entries}
      branch={git.branch}
      loading={git.loading}
      committing={git.committing}
      error={git.error}
      onCommit={() => {}}
      onReview={() => {}}
      onRefresh={git.refresh}
      onClose={() => {}}
    />
  );
}

describe("GitChangesPanel", () => {
  const baseProps = {
    entries: [] as GitChangeEntry[],
    branch: "main",
    loading: false,
    committing: false,
    error: null,
    onCommit: vi.fn(),
    onReview: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onPrMrAction: vi.fn(),
  };

  it("renders Source Control header", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} />);
    });
    expect(container.textContent).toContain("Source Control");
  });

  it("renders Changes label", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} />);
    });
    expect(container.textContent).toContain("Changes");
  });

  it("shows 'No uncommitted changes' when no entries and not loading", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} />);
    });
    expect(container.textContent).toContain("No uncommitted changes");
  });

  it("shows loading message when loading with no entries", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} loading={true} />);
    });
    expect(container.textContent).toContain("Loading changes...");
  });

  it("renders file entries", () => {
    const entries = [
      makeEntry({ path: "src/app.ts", status: "modified" }),
      makeEntry({ path: "src/new.ts", status: "added" }),
    ];
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={entries} />);
    });
    expect(container.textContent).toContain("app.ts");
    expect(container.textContent).toContain("new.ts");
  });

  it("renders commit input", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={[makeEntry()]} />);
    });
    const input = container.querySelector("input");
    expect(input).toBeTruthy();
  });

  it("renders Commit button", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={[makeEntry()]} />);
    });
    expect(container.textContent).toContain("Commit");
  });

  it("shows error message", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} error="Something went wrong" />);
    });
    expect(container.textContent).toContain("Something went wrong");
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(<GitChangesPanel {...baseProps} onClose={onClose} />);
    });
    const btn = container.querySelector('button[aria-label="Close Source Control"]');
    if (btn) {
      act(() => (btn as HTMLElement).click());
      expect(onClose).toHaveBeenCalled();
    }
  });

  it("calls onRefresh when refresh button clicked", () => {
    const onRefresh = vi.fn();
    act(() => {
      root.render(<GitChangesPanel {...baseProps} onRefresh={onRefresh} />);
    });
    const btn = container.querySelector('button[aria-label="Refresh changes"]');
    if (btn) {
      act(() => (btn as HTMLElement).click());
      expect(onRefresh).toHaveBeenCalled();
    }
  });

  it("calls onReview when review button clicked", () => {
    const onReview = vi.fn();
    const entries = [makeEntry()];
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={entries} onReview={onReview} />);
    });
    const btn = container.querySelector('button[aria-label="Review changes"]');
    if (btn) {
      act(() => (btn as HTMLElement).click());
      expect(onReview).toHaveBeenCalled();
    }
  });

  it("renders create PR action in source control header", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} reviewKind="pr" />);
    });
    expect(container.textContent).toContain("Create PR");
  });

  it("calls onPrMrAction when create PR is clicked", () => {
    const onPrMrAction = vi.fn();
    act(() => {
      root.render(<GitChangesPanel {...baseProps} reviewKind="pr" onPrMrAction={onPrMrAction} />);
    });
    const btn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Create PR"));
    if (btn) {
      act(() => (btn as HTMLElement).click());
      expect(onPrMrAction).toHaveBeenCalled();
    }
  });

  it("renders open review action in source control header", () => {
    act(() => {
      root.render(
        <GitChangesPanel
          {...baseProps}
          reviewKind="mr"
          reviewRef={{ number: 52, display: "!52", url: "https://example.com/mr/52", state: "open" }}
        />
      );
    });
    expect(container.textContent).toContain("Open !52");
  });

  it("shows working label while PR/MR action is busy", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} reviewKind="pr" prMrActionBusy={true} />);
    });
    expect(container.textContent).toContain("Working...");
    expect(container.textContent).not.toContain("Create PR");
  });

  it("renders Discard button for entries", () => {
    const entries = [makeEntry({ path: "src/app.ts" })];
    act(() => {
      root.render(
        <GitChangesPanel {...baseProps} entries={entries} onDiscardChange={vi.fn()} />
      );
    });
    const btn = container.querySelector('button[title="Discard changes"]');
    expect(btn).toBeTruthy();
  });

  it("shows count badge when entries exist", () => {
    const entries = [makeEntry(), makeEntry({ path: "b.ts" })];
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={entries} />);
    });
    expect(container.textContent).toContain("2");
  });

  it("shows insertion/deletion counts", () => {
    const entries = [makeEntry({ insertions: 5, deletions: 3 })];
    act(() => {
      root.render(<GitChangesPanel {...baseProps} entries={entries} />);
    });
    expect(container.textContent).toContain("+5");
    expect(container.textContent).toContain("-3");
  });

  it("shows committing state", () => {
    act(() => {
      root.render(<GitChangesPanel {...baseProps} committing={true} entries={[makeEntry()]} />);
    });
    expect(container.textContent).toContain("Committing");
  });

  it("hides directory-only entries and renders sorted file list from hook data", async () => {
    vi.mocked(useGitStatus).mockReturnValue({
      data: {
        branch: "main",
        entries: [
          makeEntry({ path: "src/new-dir/", status: "untracked" }),
          makeEntry({ path: "src/zeta.ts", status: "modified" }),
          makeEntry({ path: "src/alpha.ts", status: "modified" }),
          makeEntry({ path: "src/new.ts", status: "added" }),
          makeEntry({ path: "src/new-dir/file.ts", status: "untracked" }),
        ],
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGitStatus>);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <HookBackedPanel worktreeId="w1" enabled={true} />
        </QueryClientProvider>
      );
      await Promise.resolve();
    });

    const options = Array.from(container.querySelectorAll('[role="option"]'));

    expect(options).toHaveLength(4);
    expect(options.map((option) => option.textContent ?? "")).toEqual([
      expect.stringContaining("alpha.ts"),
      expect.stringContaining("zeta.ts"),
      expect.stringContaining("new.ts"),
      expect.stringContaining("file.ts"),
    ]);
    expect(container.textContent).toContain("4");
  });
});
