import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, Repository } from "@codesymphony/shared-types";
import { SettingsDialog } from "./SettingsDialog";

const apiMocks = vi.hoisted(() => ({
  updateRepositoryScripts: vi.fn(),
  listBranches: vi.fn(),
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  activateModelProvider: vi.fn(),
  deactivateAllProviders: vi.fn(),
  testModelProvider: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    updateRepositoryScripts: apiMocks.updateRepositoryScripts,
    listBranches: apiMocks.listBranches,
    listModelProviders: apiMocks.listModelProviders,
    createModelProvider: apiMocks.createModelProvider,
    updateModelProvider: apiMocks.updateModelProvider,
    deleteModelProvider: apiMocks.deleteModelProvider,
    activateModelProvider: apiMocks.activateModelProvider,
    deactivateAllProviders: apiMocks.deactivateAllProviders,
    testModelProvider: apiMocks.testModelProvider,
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
  apiMocks.updateRepositoryScripts.mockImplementation(async (_repoId: string, payload: Record<string, unknown>) => ({
    ...makeRepo(),
    ...(payload.runScript ? { runScript: payload.runScript as string[] } : {}),
    ...(payload.setupScript ? { setupScript: payload.setupScript as string[] } : {}),
    ...(payload.teardownScript ? { teardownScript: payload.teardownScript as string[] } : {}),
    ...(payload.defaultBranch ? { defaultBranch: payload.defaultBranch as string } : {}),
  }));
  apiMocks.listBranches.mockResolvedValue(["main", "dev"]);
  apiMocks.listModelProviders.mockResolvedValue([]);
  apiMocks.createModelProvider.mockResolvedValue({});
  apiMocks.updateModelProvider.mockResolvedValue({});
  apiMocks.deleteModelProvider.mockResolvedValue(undefined);
  apiMocks.activateModelProvider.mockResolvedValue({});
  apiMocks.deactivateAllProviders.mockResolvedValue(undefined);
  apiMocks.testModelProvider.mockResolvedValue({ success: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    name: "test-repo",
    rootPath: "/home/test",
    defaultBranch: "main",
    setupScript: null,
    teardownScript: null,
    runScript: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    worktrees: [],
    ...overrides,
  };
}

function renderDialog(
  repositories: Repository[],
  onClose = vi.fn(),
  onProvidersChanged?: (providers: ModelProvider[]) => void,
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsDialog
          open={true}
          onClose={onClose}
          repositories={repositories}
          onRemoveRepository={vi.fn()}
          onProvidersChanged={onProvidersChanged}
        />
      </QueryClientProvider>,
    );
  });
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
    expect(document.body.textContent).toContain("Licenses");
  });

  it("shows bundled open-source license details in the Licenses tab", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    const licensesTab = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Licenses");
    if (!licensesTab) {
      throw new Error("Licenses tab not found");
    }

    await act(async () => {
      licensesTab.click();
    });

    expect(document.body.textContent).toContain("Open Source Licenses");
    expect(document.body.textContent).toContain("Material Icon Theme");
    expect(document.body.textContent).toContain("The MIT License (MIT)");
    expect(document.body.textContent).toContain("https://github.com/material-extensions/vscode-material-icon-theme");
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

  it("shows script configuration fields in workspace settings", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    expect(document.body.textContent).toContain("Default Branch");
    expect(document.body.textContent).toContain("Run Script");
    expect(document.body.textContent).toContain("Setup Scripts");
    expect(document.body.textContent).toContain("Teardown Scripts");
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

  it("keeps dirty workspace form values when repositories refresh", async () => {
    renderDialog([makeRepo({ runScript: ["npm run dev"] })]);
    await flushEffects();

    const defaultBranchSelect = document.body.querySelectorAll("select")[1] as HTMLSelectElement;
    expect(defaultBranchSelect.value).toBe("main");

    await act(async () => {
      defaultBranchSelect.value = "dev";
      defaultBranchSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushEffects();
    expect((document.body.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("dev");

    renderDialog([
      makeRepo({
        runScript: ["remote refresh"],
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    await flushEffects();

    expect((document.body.querySelectorAll("select")[1] as HTMLSelectElement).value).toBe("dev");
  });


  it("reselects a valid repository when the current one disappears", async () => {
    renderDialog([
      makeRepo(),
      makeRepo({
        id: "r2",
        name: "other-repo",
        defaultBranch: "develop",
        runScript: ["pnpm test"],
      }),
    ]);
    await flushEffects();

    const repoSelect = document.body.querySelectorAll("select")[0] as HTMLSelectElement;
    await act(async () => {
      repoSelect.value = "r2";
      repoSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushEffects();

    renderDialog([makeRepo()]);
    await flushEffects();

    const nextRepoSelect = document.body.querySelectorAll("select")[0] as HTMLSelectElement;
    const runScriptTextarea = document.body.querySelector('textarea[rows="3"]') as HTMLTextAreaElement;

    expect(nextRepoSelect.value).toBe("r1");
    expect(runScriptTextarea.value).toBe("");
  });

  it("syncs fetched model providers back to the parent when the Models tab opens", async () => {
    const providers = [{
      id: "provider-1",
      name: "Custom",
      modelId: "claude-custom",
      baseUrl: "https://example.com",
      apiKeyMasked: "••••",
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);
    const onProvidersChanged = vi.fn();

    renderDialog([makeRepo()], vi.fn(), onProvidersChanged);

    const modelsButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Models");
    expect(modelsButton).toBeDefined();

    await act(async () => {
      modelsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(onProvidersChanged).toHaveBeenCalledWith(providers);
    expect(document.body.textContent).toContain("claude-custom");
  });

  it("does not show active or inactive controls in the Models tab", async () => {
    const providers = [{
      id: "provider-1",
      name: "Custom",
      modelId: "claude-custom",
      baseUrl: "https://example.com",
      apiKeyMasked: "••••",
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);

    renderDialog([makeRepo()]);

    const modelsButton = Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Models");
    expect(modelsButton).toBeDefined();

    await act(async () => {
      modelsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).not.toContain("Active");
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.title === "Activate" || button.title === "Deactivate")).toBe(false);
    expect(document.body.textContent).toContain("choose the model you want from the composer");
  });
});
