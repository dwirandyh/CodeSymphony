import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCrashFallback } from "./AppCrashFallback";

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

describe("AppCrashFallback", () => {
  it("renders recovery actions and error details", () => {
    act(() => {
      root.render(<AppCrashFallback error={new Error("Maximum update depth exceeded")} />);
    });

    expect(container.textContent).toContain("The app hit a blocking error");
    expect(container.textContent).toContain("Reload App");
    expect(container.textContent).toContain("Reset To Home");
    expect(container.textContent).toContain("Maximum update depth exceeded");
  });

  it("triggers reload from the button and keyboard shortcut", () => {
    const onReload = vi.fn();

    act(() => {
      root.render(<AppCrashFallback onReload={onReload} />);
    });

    const reloadButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reload App");
    expect(reloadButton).toBeTruthy();

    act(() => {
      reloadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: true, bubbles: true }));
    });

    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it("triggers reset home action", () => {
    const onResetHome = vi.fn();

    act(() => {
      root.render(<AppCrashFallback onResetHome={onResetHome} />);
    });

    const resetButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reset To Home");
    expect(resetButton).toBeTruthy();

    act(() => {
      resetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onResetHome).toHaveBeenCalledTimes(1);
  });
});
