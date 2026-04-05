import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api";
import { OpenInAppButton } from "./OpenInAppButton";

vi.mock("../../hooks/queries/useInstalledApps", () => ({
  useInstalledApps: vi.fn().mockReturnValue({
    data: [
      { id: "cursor", name: "Cursor", bundleId: "com.cursor", path: "/Applications/Cursor.app", iconUrl: "/api/system/installed-apps/cursor/icon" },
      { id: "finder", name: "Finder", bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app", iconUrl: "/api/system/installed-apps/finder/icon" },
      { id: "vscode", name: "VS Code", bundleId: "com.vscode", path: "/Applications/Code.app", iconUrl: "/api/system/installed-apps/vscode/icon" },
    ],
    isLoading: false,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    openInApp: vi.fn().mockResolvedValue(undefined),
    runtimeBaseUrl: "http://127.0.0.1:4331",
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("OpenInAppButton", () => {
  it("renders app selector and open button", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenInAppButton targetPath="/project" />
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toContain("Cursor");
  });

  it("renders open icon button", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenInAppButton targetPath="/project" />
        </QueryClientProvider>
      );
    });
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("shows selected app name", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenInAppButton targetPath="/project" />
        </QueryClientProvider>
      );
    });
    const text = container.textContent || "";
    expect(text.length).toBeGreaterThan(0);
  });

  it("renders the original app icon when iconUrl is available", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenInAppButton targetPath="/project" />
        </QueryClientProvider>
      );
    });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("http://127.0.0.1:4331/api/system/installed-apps/cursor/icon");
  });

  it("opens the preferred Finder option for the current worktree", async () => {
    localStorage.setItem("codesymphony:preferred-editor", "finder");

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenInAppButton targetPath="/project" />
        </QueryClientProvider>
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    const openButton = buttons[1];
    if (!openButton) {
      throw new Error("Open button not found");
    }

    await act(async () => {
      openButton.click();
      await Promise.resolve();
    });

    expect(api.openInApp).toHaveBeenCalledWith({ appId: "finder", targetPath: "/project" });
  });
});
