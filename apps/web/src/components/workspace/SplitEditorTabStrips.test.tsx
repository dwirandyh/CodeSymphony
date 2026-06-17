import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SplitEditorTabStrips } from "./SplitEditorTabStrips";

describe("SplitEditorTabStrips", () => {
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

  it("reserves a w-1 gutter between left and right strips to match the editor split divider", () => {
    act(() => {
      root.render(
        <SplitEditorTabStrips
          dividerPosition={42}
          left={<span data-testid="left-strip">L</span>}
          right={<span data-testid="right-strip">R</span>}
        />,
      );
    });

    const gutter = container.querySelector<HTMLElement>('[data-testid="split-tab-strips-divider-gutter"]');
    const left = container.querySelector<HTMLElement>('[data-testid="split-tab-strips-left"]');
    if (!gutter || !left) {
      throw new Error("Split tab strip layout nodes not found");
    }

    const right = container.querySelector<HTMLElement>('[data-testid="split-tab-strips-right"]');
    if (!right) {
      throw new Error("Right split tab strip not found");
    }

    expect(gutter.className).toContain("w-1");
    expect(gutter.className).toContain("shrink-0");
    expect(left.style.width).toBe("42%");
    expect(right.style.width).toBe("calc(58% - 0.25rem)");
  });
});