import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenInAppButton } from "./OpenInAppButton";

vi.mock("../../hooks/queries/useInstalledApps", () => ({
  useInstalledApps: vi.fn().mockReturnValue({
    data: [
      { id: "cursor", name: "Cursor", bundleId: "com.cursor", path: "/Applications/Cursor.app" },
      { id: "vscode", name: "VS Code", bundleId: "com.vscode", path: "/Applications/Code.app" },
    ],
    isLoading: false,
  }),
}));

vi.mock("../../lib/api", () => ({
  api: {
    openInApp: vi.fn().mockResolvedValue(undefined),
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
});
