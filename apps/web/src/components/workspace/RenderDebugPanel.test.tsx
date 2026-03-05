import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("RenderDebugPanel", () => {
  it("renders nothing when debug is not enabled", async () => {
    vi.doMock("../../lib/renderDebug", () => ({
      isRenderDebugEnabled: () => false,
      getRenderDebugEntries: () => [],
      clearRenderDebugEntries: vi.fn(),
      copyRenderDebugLog: vi.fn(),
      subscribeRenderDebug: vi.fn(),
    }));
    const { RenderDebugPanel } = await import("./RenderDebugPanel");
    act(() => {
      root.render(<RenderDebugPanel />);
    });
    expect(container.querySelector('[data-testid="render-debug-panel"]')).toBeNull();
    vi.doUnmock("../../lib/renderDebug");
  });

  it("exports RenderDebugPanel component", async () => {
    const mod = await import("./RenderDebugPanel");
    expect(typeof mod.RenderDebugPanel).toBe("function");
  });
});
