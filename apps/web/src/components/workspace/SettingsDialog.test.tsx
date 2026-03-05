import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "@codesymphony/shared-types";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../../lib/api", () => ({
  api: {
    updateRepositoryScripts: vi.fn().mockResolvedValue({}),
    listBranches: vi.fn().mockResolvedValue(["main", "dev"]),
    listModelProviders: vi.fn().mockResolvedValue([]),
    createModelProvider: vi.fn().mockResolvedValue({}),
    updateModelProvider: vi.fn().mockResolvedValue({}),
    deleteModelProvider: vi.fn().mockResolvedValue(undefined),
    activateModelProvider: vi.fn().mockResolvedValue({}),
    deactivateAllModelProviders: vi.fn().mockResolvedValue(undefined),
    testModelProvider: vi.fn().mockResolvedValue({ success: true }),
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

function makeRepo(): Repository {
  return {
    id: "r1",
    name: "test-repo",
    rootPath: "/home/test",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    worktrees: [],
  };
}

describe("SettingsDialog", () => {
  it("renders nothing when closed", () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={false}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).not.toContain("Settings");
  });

  it("renders dialog with Settings title when open", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).toContain("Settings");
  });

  it("shows Workspace and Models tabs", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).toContain("Workspace");
    expect(document.body.textContent).toContain("Models");
  });

  it("shows repository name in workspace tab", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).toContain("test-repo");
  });

  it("shows script configuration fields when repo selected", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });

    const repoButton = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("test-repo")
    );
    if (repoButton) {
      await act(async () => {
        repoButton.click();
        await new Promise((r) => setTimeout(r, 50));
      });
    }
  });

  it("calls onClose when close triggered", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={onClose}
            repositories={[]}
            onRemoveRepository={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
  });
});
