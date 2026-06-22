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
    const toast = container.querySelector("[data-testid='workspace-live-error-toast']")?.parentElement;
    expect(toast?.className).toContain(MOBILE_OVERLAY_Z_CLASS);
    expect(toast?.className).toContain("bottom-[calc(0.75rem+var(--cs-mobile-composer-rest-offset,4rem))]");
  });
});