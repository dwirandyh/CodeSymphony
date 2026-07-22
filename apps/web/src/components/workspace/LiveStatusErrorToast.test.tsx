import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOBILE_OVERLAY_Z_CLASS } from "../../lib/mobileStacking";
import { LiveStatusErrorToast } from "./LiveStatusErrorToast";

describe("LiveStatusErrorToast", () => {
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

  it("stacks above the fixed mobile composer", () => {
    act(() => {
      root.render(
        <LiveStatusErrorToast
          description="SSE disconnected"
          mobileComposerPinned
          onDismiss={() => undefined}
          title="Live updates paused"
        />,
      );
    });
    const toast = document.body.querySelector("[data-testid='workspace-live-error-toast']")?.parentElement;
    expect(toast?.className).toContain(MOBILE_OVERLAY_Z_CLASS);
    expect(toast?.className).toContain("bottom-[calc(0.75rem+var(--cs-mobile-composer-rest-offset,4rem))]");
  });

  it("renders into document.body via portal so filtered/overflow ancestors cannot clip it", () => {
    const clippingAncestor = document.createElement("div");
    clippingAncestor.style.overflow = "hidden";
    clippingAncestor.style.backdropFilter = "blur(4px)";
    document.body.appendChild(clippingAncestor);
    const clippedRoot = createRoot(clippingAncestor);

    act(() => {
      clippedRoot.render(
        <LiveStatusErrorToast
          description="SSE disconnected"
          onDismiss={() => undefined}
          title="Source Control"
        />,
      );
    });

    const toast = document.body.querySelector("[data-testid='workspace-live-error-toast']");
    expect(toast).not.toBeNull();
    // Portaled to body, NOT nested inside the clipping ancestor.
    expect(clippingAncestor.contains(toast)).toBe(false);

    act(() => {
      clippedRoot.unmount();
    });
    clippingAncestor.remove();
  });
});