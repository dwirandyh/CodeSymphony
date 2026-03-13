import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useSearch: vi.fn().mockReturnValue({ view: "chat", repoId: "r1" }),
  useNavigate: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("../../../lib/debugLog", () => ({
  debugLog: vi.fn(),
}));

import { useWorkspaceSearchParams } from "./useWorkspaceSearchParams";
import { useNavigate } from "@tanstack/react-router";

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
});
