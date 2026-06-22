import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";

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

describe("ScrollArea", () => {
  it("renders a Radix viewport as the scroll container and supports rerenders", () => {
    const ref = createRef<HTMLDivElement>();

    act(() => {
      root.render(
        <ScrollArea ref={ref} className="h-10" data-testid="scroll-area">
          <div>first render</div>
        </ScrollArea>,
      );
    });

    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.hasAttribute("data-radix-scroll-area-viewport")).toBe(true);
    expect(container.textContent).toContain("first render");

    act(() => {
      root.render(
        <ScrollArea ref={ref} className="h-10" data-testid="scroll-area">
          <div>second render</div>
        </ScrollArea>,
      );
    });

    expect(container.textContent).toContain("second render");
  });

  it("keeps the root clipped while the viewport handles scrolling", () => {
    act(() => {
      root.render(
        <ScrollArea className="h-10">
          <div style={{ height: "200px" }}>tall content</div>
        </ScrollArea>,
      );
    });

    const viewport = container.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement | null;
    const rootElement = viewport?.parentElement as HTMLDivElement | null;

    expect(rootElement?.className).toContain("overflow-hidden");
    expect(viewport).not.toBeNull();
  });
});