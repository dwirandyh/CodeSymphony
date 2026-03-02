import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { GitChangesPanel } from "./GitChangesPanel";

vi.mock("../../lib/api", () => ({
  api: { openFileDefaultApp: vi.fn() },
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
});
