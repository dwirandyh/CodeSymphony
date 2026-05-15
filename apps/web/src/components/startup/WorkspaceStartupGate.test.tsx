import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStartupGate } from "./WorkspaceStartupGate";

const isTauriDesktopMock = vi.fn();

vi.mock("../../lib/openExternalUrl", () => ({
  isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    runtimeBaseUrl: "http://127.0.0.1:4322",
  },
}));

describe("WorkspaceStartupGate", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    act(() => {
      flushSync(() => {
        root.unmount();
      });
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function renderGate() {
    act(() => {
      flushSync(() => {
        root.render(
          <WorkspaceStartupGate>
            <div data-testid="workspace-ready">Workspace ready</div>
          </WorkspaceStartupGate>,
        );
      });
    });
  }

  it("renders children immediately outside the desktop shell", () => {
    isTauriDesktopMock.mockReturnValue(false);

    renderGate();

    expect(container.querySelector("[data-testid='workspace-ready']")).not.toBeNull();
    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the startup splash visible until the desktop runtime health check succeeds", async () => {
    isTauriDesktopMock.mockReturnValue(true);
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true } as Response);

    renderGate();

    expect(container.querySelector("[data-testid='startup-splash']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-ready']")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(container.querySelector("[data-testid='workspace-ready']")).not.toBeNull();
    expect(container.querySelector("[data-testid='startup-splash']")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("http://127.0.0.1:4322/health");
  });
});
