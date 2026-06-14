import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSwitcherOverlay } from "./SessionSwitcherOverlay";
import type { SessionSwitcherItem } from "../../pages/workspace/sessionSwitcherItems";

const items: SessionSwitcherItem[] = [
  { key: "thread:wtA:t1", kind: "thread", label: "Fix auth bug", sublabel: "" },
  { key: "terminal:wtA:term1", kind: "terminal", label: "bun dev", sublabel: "" },
  { key: "thread:wtB:b1", kind: "thread", label: "Other worktree", sublabel: "", contextLabel: "feature/x" },
];

describe("SessionSwitcherOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders nothing when closed", () => {
    act(() => {
      root.render(<SessionSwitcherOverlay open={false} items={items} selectedIndex={0} />);
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders all item labels when open", () => {
    act(() => {
      root.render(<SessionSwitcherOverlay open items={items} selectedIndex={0} />);
    });
    expect(container.textContent).toContain("Fix auth bug");
    expect(container.textContent).toContain("bun dev");
    expect(container.textContent).toContain("Other worktree");
  });

  it("shows the branch context label for other-worktree targets", () => {
    act(() => {
      root.render(<SessionSwitcherOverlay open items={items} selectedIndex={0} />);
    });
    expect(container.textContent).toContain("feature/x");
  });

  it("marks the selected item via aria-selected", () => {
    act(() => {
      root.render(<SessionSwitcherOverlay open items={items} selectedIndex={1} />);
    });
    const rows = Array.from(container.querySelectorAll('[role="option"]'));
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[2].getAttribute("aria-selected")).toBe("false");
  });
});
