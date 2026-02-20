import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitChangesPanel } from "./GitChangesPanel";

const entries: GitChangeEntry[] = [
  { path: "src/components/App.tsx", status: "modified", insertions: 10, deletions: 5 },
  { path: "src/utils/helpers.ts", status: "added", insertions: 20, deletions: 0 },
  { path: "README.md", status: "deleted", insertions: 0, deletions: 15 },
];

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GitChangesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  const defaultProps = {
    entries,
    branch: "feature/redesign",
    loading: false,
    committing: false,
    error: null as string | null,
    selectedFilePath: null as string | null,
    onCommit: vi.fn(),
    onReview: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onSelectFile: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderPanel(overrides: Partial<typeof defaultProps> = {}) {
    act(() => {
      root.render(<GitChangesPanel {...defaultProps} {...overrides} />);
    });
  }

  it("renders header", () => {
    renderPanel();
    expect(container.textContent).toContain("Source Control");
  });

  it("renders change count badge", () => {
    renderPanel();
    expect(container.textContent).toContain("Changes");
    expect(container.textContent).toContain("3");
  });

  it("renders file entries with status badges", () => {
    renderPanel();
    expect(container.textContent).toContain("App.tsx");
    expect(container.textContent).toContain("helpers.ts");
    expect(container.textContent).toContain("README.md");

    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(3);
  });

  it("renders directory paths for nested files", () => {
    renderPanel();
    expect(container.textContent).toContain("src/components/");
    expect(container.textContent).toContain("src/utils/");
  });

  it("renders diff counts", () => {
    renderPanel();
    expect(container.textContent).toContain("+10");
    expect(container.textContent).toContain("-5");
    expect(container.textContent).toContain("+20");
    expect(container.textContent).toContain("-15");
  });

  it("shows status icons with correct titles", () => {
    renderPanel();
    const badges = container.querySelectorAll('[title="modified"], [title="added"], [title="deleted"]');
    expect(badges).toHaveLength(3);
  });

  // ── Commit enabled/disabled states ──

  it("disables commit button when message is empty", () => {
    renderPanel();
    const commitBtn = container.querySelector("button") as HTMLButtonElement;
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Commit"));
    expect(commit?.disabled).toBe(true);
  });

  it("disables commit button when no entries", () => {
    renderPanel({ entries: [] });
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "test commit"));
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Commit"));
    expect(commit?.disabled).toBe(true);
  });

  it("disables commit button while committing", () => {
    renderPanel({ committing: true });
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "test commit"));
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Committing..."));
    expect(commit?.disabled).toBe(true);
  });

  it("enables commit when message is provided and entries exist", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "fix: something"));
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Commit"));
    expect(commit?.disabled).toBe(false);
  });

  // ── Commit submission ──

  it("calls onCommit with trimmed message on button click", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "  fix: broken test  "));
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Commit"))!;
    act(() => commit.click());
    expect(defaultProps.onCommit).toHaveBeenCalledWith("fix: broken test");
  });

  it("clears message after successful commit", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "fix: broken test"));
    const allButtons = Array.from(container.querySelectorAll("button"));
    const commit = allButtons.find((b) => b.textContent?.includes("Commit"))!;
    act(() => commit.click());
    expect(input.value).toBe("");
  });

  it("calls onCommit on Cmd+Enter", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "chore: update deps"));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    expect(defaultProps.onCommit).toHaveBeenCalledWith("chore: update deps");
  });

  it("calls onCommit on Ctrl+Enter", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => changeInputValue(input, "chore: update deps"));
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(defaultProps.onCommit).toHaveBeenCalledWith("chore: update deps");
  });

  it("does not call onCommit on Cmd+Enter with empty message", () => {
    renderPanel();
    const input = container.querySelector("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    expect(defaultProps.onCommit).not.toHaveBeenCalled();
  });

  // ── Callback tests ──

  it("calls onRefresh when refresh button is clicked", () => {
    renderPanel();
    const refreshBtn = container.querySelector('button[aria-label="Refresh changes"]') as HTMLButtonElement;
    act(() => refreshBtn.click());
    expect(defaultProps.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables refresh button when loading", () => {
    renderPanel({ loading: true });
    const refreshBtn = container.querySelector('button[aria-label="Refresh changes"]') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
  });

  it("calls onClose when close button is clicked", () => {
    renderPanel();
    const closeBtn = container.querySelector('button[aria-label="Close Source Control"]') as HTMLButtonElement;
    act(() => closeBtn.click());
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onReview when review button is clicked", () => {
    renderPanel();
    const reviewBtn = container.querySelector('button[aria-label="Review changes"]') as HTMLButtonElement;
    act(() => reviewBtn.click());
    expect(defaultProps.onReview).toHaveBeenCalledTimes(1);
  });

  it("disables review button when no entries", () => {
    renderPanel({ entries: [] });
    const reviewBtn = container.querySelector('button[aria-label="Review changes"]') as HTMLButtonElement;
    expect(reviewBtn.disabled).toBe(true);
  });

  // ── File row selection ──

  it("calls onSelectFile when file row is clicked", () => {
    renderPanel();
    const options = container.querySelectorAll('[role="option"]');
    act(() => (options[1] as HTMLElement).click());
    expect(defaultProps.onSelectFile).toHaveBeenCalledWith("src/utils/helpers.ts");
  });

  it("marks selected file with aria-selected", () => {
    renderPanel({ selectedFilePath: "src/utils/helpers.ts" });
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[2].getAttribute("aria-selected")).toBe("false");
  });

  // ── Error rendering ──

  it("renders error message with alert role", () => {
    renderPanel({ error: "Commit failed: nothing to commit" });
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe("Commit failed: nothing to commit");
  });

  it("does not render error when null", () => {
    renderPanel({ error: null });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // ── Empty / loading states ──

  it("shows empty state when no entries", () => {
    renderPanel({ entries: [], loading: false });
    expect(container.textContent).toContain("No uncommitted changes");
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it("shows loading message when loading with no entries", () => {
    renderPanel({ entries: [], loading: true });
    expect(container.textContent).toContain("Loading changes...");
  });

  it("hides change count badge when entries is empty", () => {
    renderPanel({ entries: [] });
    expect(container.textContent).toContain("Changes");
    // Should not contain a count badge number
    const changesSection = container.textContent?.split("Changes")[1] ?? "";
    expect(changesSection).not.toMatch(/^\d/);
  });

  // ── Accessibility ──

  it("has a listbox for file entries", () => {
    renderPanel();
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute("aria-label")).toBe("Changed files");
  });
});
