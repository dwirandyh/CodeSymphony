import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useSearch: vi.fn().mockReturnValue({ view: "chat", repoId: "r1" }),
  useNavigate: vi.fn().mockReturnValue(vi.fn()),
}));


import { useWorkspaceSearchParams } from "./useWorkspaceSearchParams";
import { useNavigate, useSearch } from "@tanstack/react-router";

let container: HTMLDivElement;
let root: Root;
let hookResult: ReturnType<typeof useWorkspaceSearchParams>;

function TestComponent() {
  hookResult = useWorkspaceSearchParams();
  return <div>search:{JSON.stringify(hookResult.search)}</div>;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useWorkspaceSearchParams", () => {
  it("returns current search params", () => {
    act(() => {
      root.render(<TestComponent />);
    });
    expect(hookResult.search).toEqual({ view: "chat", repoId: "r1" });
  });

  it("provides updateSearch function", () => {
    act(() => {
      root.render(<TestComponent />);
    });
    expect(typeof hookResult.updateSearch).toBe("function");
  });

  it("calls navigate when updateSearch is called", async () => {
    const mockNav = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(mockNav);
    act(() => {
      root.render(<TestComponent />);
    });
    act(() => {
      hookResult.updateSearch({ repoId: "r2" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockNav).toHaveBeenCalled();
  });

  it("batches multiple updateSearch calls", async () => {
    const mockNav = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(mockNav);
    act(() => {
      root.render(<TestComponent />);
    });
    act(() => {
      hookResult.updateSearch({ repoId: "r2" });
      hookResult.updateSearch({ view: "review" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockNav).toHaveBeenCalledTimes(1);
  });

  it("clears automation-only search params when leaving the automations view", async () => {
    const mockNav = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(mockNav);
    vi.mocked(useSearch).mockReturnValue({
      view: "automations",
      repoId: "r1",
      automationId: "automation-1",
      automationCreate: true,
    });

    act(() => {
      root.render(<TestComponent />);
    });

    act(() => {
      hookResult.updateSearch({ view: undefined });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const navigationCall = mockNav.mock.calls[0]?.[0];
    expect(navigationCall).toBeTruthy();
    if (typeof navigationCall?.search !== "function") {
      throw new Error("Expected navigate search updater");
    }

    expect(navigationCall.search({
      view: "automations",
      repoId: "r1",
      automationId: "automation-1",
      automationCreate: true,
    })).toEqual({ repoId: "r1" });
  });
});
