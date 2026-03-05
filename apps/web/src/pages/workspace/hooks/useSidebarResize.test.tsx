import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarResize } from "./useSidebarResize";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useSidebarResize>;

function TestComponent({ initialWidth, reverse }: { initialWidth?: number; reverse?: boolean }) {
  hookResult = useSidebarResize(initialWidth, reverse);
  return <div ref={hookResult.panelRef as React.RefObject<HTMLDivElement>}>width:{hookResult.sidebarWidth}</div>;
}

describe("useSidebarResize", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("returns default width of 300", () => {
    act(() => {
      root.render(<TestComponent />);
    });
    expect(container.textContent).toContain("width:300");
  });

  it("uses custom initial width", () => {
    act(() => {
      root.render(<TestComponent initialWidth={400} />);
    });
    expect(container.textContent).toContain("width:400");
  });

  it("returns sidebarDragging as false initially", () => {
    act(() => {
      root.render(<TestComponent />);
    });
    expect(hookResult.sidebarDragging).toBe(false);
  });

  it("starts dragging on mousedown and updates width on mousemove", () => {
    act(() => {
      root.render(<TestComponent />);
    });

    const mouseDownEvent = new MouseEvent("mousedown", { clientX: 300, bubbles: true }) as unknown as React.MouseEvent;
    Object.defineProperty(mouseDownEvent, "preventDefault", { value: () => {} });

    act(() => {
      hookResult.handleSidebarMouseDown(mouseDownEvent);
    });
    expect(hookResult.sidebarDragging).toBe(true);

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    });

    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.width).toBe("400px");

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(hookResult.sidebarDragging).toBe(false);
    expect(container.textContent).toContain("width:400");
  });

  it("clamps width to min 200", () => {
    act(() => {
      root.render(<TestComponent />);
    });

    const mouseDownEvent = new MouseEvent("mousedown", { clientX: 300, bubbles: true }) as unknown as React.MouseEvent;
    Object.defineProperty(mouseDownEvent, "preventDefault", { value: () => {} });

    act(() => {
      hookResult.handleSidebarMouseDown(mouseDownEvent);
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 }));
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(container.textContent).toContain("width:200");
  });

  it("clamps width to max 500", () => {
    act(() => {
      root.render(<TestComponent />);
    });

    const mouseDownEvent = new MouseEvent("mousedown", { clientX: 300, bubbles: true }) as unknown as React.MouseEvent;
    Object.defineProperty(mouseDownEvent, "preventDefault", { value: () => {} });

    act(() => {
      hookResult.handleSidebarMouseDown(mouseDownEvent);
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 900 }));
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(container.textContent).toContain("width:500");
  });

  it("reverses drag direction when reverse=true", () => {
    act(() => {
      root.render(<TestComponent reverse />);
    });

    const mouseDownEvent = new MouseEvent("mousedown", { clientX: 300, bubbles: true }) as unknown as React.MouseEvent;
    Object.defineProperty(mouseDownEvent, "preventDefault", { value: () => {} });

    act(() => {
      hookResult.handleSidebarMouseDown(mouseDownEvent);
    });

    // Moving left should increase width when reversed
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 200 }));
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(container.textContent).toContain("width:400");
  });

  it("cleans up event listeners when effect is re-run", () => {
    act(() => {
      root.render(<TestComponent />);
    });

    const mouseDownEvent = new MouseEvent("mousedown", { clientX: 300, bubbles: true }) as unknown as React.MouseEvent;
    Object.defineProperty(mouseDownEvent, "preventDefault", { value: () => {} });

    act(() => {
      hookResult.handleSidebarMouseDown(mouseDownEvent);
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    // After mouseup, further mousemove should not change the panel width
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
    });
    expect(container.textContent).toContain("width:300");
  });
});
