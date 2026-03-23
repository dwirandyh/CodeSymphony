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
  it("renders a native scroll container and supports rerenders", () => {
    const ref = createRef<HTMLDivElement>();

    act(() => {
      root.render(
        <ScrollArea ref={ref} className="h-10">
          <div>first render</div>
        </ScrollArea>,
      );
    });

    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.className).toContain("overflow-auto");
    expect(container.textContent).toContain("first render");

    act(() => {
      root.render(
        <ScrollArea ref={ref} className="h-10">
          <div>second render</div>
        </ScrollArea>,
      );
    });

    expect(container.textContent).toContain("second render");
  });
});
