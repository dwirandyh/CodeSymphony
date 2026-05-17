import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, Repository, SaveAutomationConfig } from "@codesymphony/shared-types";
import { SettingsDialog } from "./SettingsDialog";
import { AGENT_DEFAULTS_STORAGE_KEY } from "../../pages/workspace/agentDefaults";
import { DEFAULT_GENERAL_SETTINGS, getModifierEnterLabel } from "../../lib/generalSettings";

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
const codexModels = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    description: "Frontier coding model",
    hidden: false,
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    description: "Strong model for everyday coding.",
    hidden: false,
    isDefault: false,
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    description: "Coding-optimized model.",
    hidden: false,
    isDefault: false,
  },
] as const;
const defaultGeneralSettings = DEFAULT_GENERAL_SETTINGS;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  apiMocks.updateRepositoryScripts.mockImplementation(async (_repoId: string, payload: Record<string, unknown>) => ({
    ...makeRepo(),
    ...(payload.runScript ? { runScript: payload.runScript as string[] } : {}),
    ...(payload.setupScript ? { setupScript: payload.setupScript as string[] } : {}),
    ...(payload.teardownScript ? { teardownScript: payload.teardownScript as string[] } : {}),
    ...(payload.saveAutomation !== undefined ? { saveAutomation: payload.saveAutomation as SaveAutomationConfig | null } : {}),
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
  window.localStorage.removeItem(AGENT_DEFAULTS_STORAGE_KEY);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(window.navigator, "userAgentData", {
    value: undefined,
    configurable: true,
  });
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
    saveAutomation: null,
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
  options?: {
    runtimeLabel?: string | null;
    runtimeTitle?: string | null;
    selectedRepositoryId?: string | null;
  },
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsDialog
          open={true}
          onClose={onClose}
          repositories={repositories}
          selectedRepositoryId={options?.selectedRepositoryId}
          codexModels={codexModels}
          generalSettings={defaultGeneralSettings}
          runtimeLabel={options?.runtimeLabel}
          runtimeTitle={options?.runtimeTitle}
          onRemoveRepository={vi.fn()}
          onGeneralSettingsChange={vi.fn()}
          onProvidersChanged={onProvidersChanged}
        />
      </QueryClientProvider>,
    );
  });
}

async function openModelsTab() {
  const modelsButton = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Models",
  );
  if (!modelsButton) {
    throw new Error("Models tab not found");
  }

  await act(async () => {
    modelsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

async function openGeneralTab() {
  const generalButton = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "General",
  );
  if (!generalButton) {
    throw new Error("General tab not found");
  }

  await act(async () => {
    generalButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

async function openWorkspaceTab() {
  const workspaceButton = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Workspace",
  );
  if (!workspaceButton) {
    throw new Error("Workspace tab not found");
  }

  await act(async () => {
    workspaceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushEffects();
}

async function flushEffects() {
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.resolve();
  });
}

async function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("Input value setter not available");
  }

  await act(async () => {
    valueSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function getRadixSelectTrigger(label: string) {
  const trigger = document.body.querySelector(`[aria-label="${label}"]`);
  if (!(trigger instanceof HTMLElement)) {
    throw new Error(`${label} trigger not found`);
  }

  return trigger;
}

async function openRadixSelect(label: string) {
  const trigger = getRadixSelectTrigger(label);

  await act(async () => {
    if (typeof PointerEvent === "function") {
      trigger.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        ctrlKey: false,
      }));
    } else {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
    }
  });
  await flushEffects();

  let options = Array.from(document.body.querySelectorAll('[role="option"]'));
  if (options.length === 0) {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flushEffects();
    options = Array.from(document.body.querySelectorAll('[role="option"]'));
  }

  return options;
}

async function setRadixSelectValue(label: string, optionText: string) {
  const options = await openRadixSelect(label);

  const normalizedOptionText = optionText.replace(/\s+/g, "").toLowerCase();
  const option = options.find((candidate) => {
    const candidateText = candidate.textContent?.replace(/\s+/g, "").toLowerCase() ?? "";
    return candidateText === normalizedOptionText || candidateText.includes(normalizedOptionText);
  });
  if (!(option instanceof HTMLElement)) {
    throw new Error(`${optionText} option not found`);
  }

  await act(async () => {
    option.click();
  });
  await flushEffects();
}

async function getRadixSelectOptions(label: string) {
  const options = await openRadixSelect(label);
  const labels = options.map((option) => normalizeText(option.textContent)).filter((value) => value.length > 0);

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flushEffects();

  return labels;
}

function getRadixSelectTriggerText(label: string) {
  return normalizeText(getRadixSelectTrigger(label).textContent);
}

describe("SettingsDialog", () => {
  it("renders nothing when closed", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={false}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    await flushEffects();
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
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).toContain("Settings");
  });

  it("shows General, Workspace, Models, and Licenses tabs", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    expect(document.body.textContent).toContain("General");
    expect(document.body.textContent).toContain("Workspace");
    expect(document.body.textContent).toContain("Models");
    expect(document.body.textContent).toContain("Licenses");
  });

  it("places the General tab first in the settings sidebar", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    const sidebar = document.body.querySelector<HTMLElement>('[data-testid="settings-sidebar"]');
    if (!sidebar) {
      throw new Error("Settings sidebar not found");
    }

    const sidebarButtons = Array.from(sidebar.querySelectorAll("button"));
    expect(sidebarButtons[1]?.textContent?.trim()).toBe("General");
    expect(sidebarButtons[2]?.textContent?.trim()).toBe("Workspace");
  });

  it("opens on the General tab by default", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    expect(document.body.textContent).toContain("Send messages with");
    expect(document.body.textContent).not.toContain("Default Branch");
  });

  it("updates send-message preference from the General tab", async () => {
    const onGeneralSettingsChange = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={onGeneralSettingsChange}
          />
        </QueryClientProvider>
      );
    });
    await openGeneralTab();

    await setRadixSelectValue("Send messages with", getModifierEnterLabel());

    expect(onGeneralSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      sendMessagesWith: "mod_enter",
    }));
  });

  it("enables desktop notifications directly in the desktop shell", async () => {
    const onGeneralSettingsChange = vi.fn();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    Object.defineProperty(window.navigator, "userAgentData", {
      value: { platform: "macOS" },
      configurable: true,
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SettingsDialog
            open={true}
            onClose={vi.fn()}
            repositories={[makeRepo()]}
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={onGeneralSettingsChange}
          />
        </QueryClientProvider>
      );
    });
    await openGeneralTab();

    const toggle = document.body.querySelector('[aria-label="Desktop notifications"]');
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error("Desktop notifications toggle not found");
    }

    await act(async () => {
      toggle.click();
    });
    await flushEffects();

    expect(onGeneralSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      desktopNotificationsEnabled: true,
    }));
    expect(document.body.textContent).toContain("OS notification settings");
  });

  it("renders Default Agent controls in the Models tab", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    expect(document.body.textContent).toContain("Default Agent");
    expect(document.body.textContent).toContain("Agent for new chats");
    expect(document.body.textContent).toContain("Agent for commit");
    expect(document.body.textContent).toContain("Agent for PR");
  });

  it("persists default agent selections to localStorage", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    await setRadixSelectValue("Agent for new chats CLI Agent", "Codex");
    await setRadixSelectValue("Agent for new chats model", "GPT-5.3 Codex");

    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"agent\":\"codex\"");
    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"model\":\"gpt-5.3-codex\"");
  });

  it("reserves the macOS title bar area when running inside the desktop shell", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    Object.defineProperty(window.navigator, "userAgentData", {
      value: { platform: "macOS" },
      configurable: true,
    });

    renderDialog([makeRepo()]);
    await flushEffects();

    const sidebar = document.body.querySelector<HTMLElement>('[data-testid="settings-sidebar"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar?.className).toContain("pt-[46px]");
  });

  it("renders a desktop top spacer in the settings content when running inside the desktop shell", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    Object.defineProperty(window.navigator, "userAgentData", {
      value: { platform: "macOS" },
      configurable: true,
    });

    renderDialog([makeRepo()]);
    await flushEffects();

    const appBar = document.body.querySelector<HTMLElement>('[data-testid="settings-desktop-appbar"]');
    expect(appBar).not.toBeNull();
    expect(appBar?.className).toContain("bg-background");
    expect(appBar?.textContent?.trim()).toBe("");
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
            codexModels={codexModels}
            generalSettings={defaultGeneralSettings}
            onRemoveRepository={vi.fn()}
            onGeneralSettingsChange={vi.fn()}
          />
        </QueryClientProvider>
      );
    });
    await openWorkspaceTab();
    expect(document.body.textContent).toContain("test-repo");
  });

  it("prefers the active repository when the dialog opens", async () => {
    renderDialog(
      [
        makeRepo(),
        makeRepo({
          id: "r2",
          name: "codesymphony",
          defaultBranch: "feat/chat/mcp-webseawrch",
        }),
      ],
      vi.fn(),
      undefined,
      { selectedRepositoryId: "r2" },
    );
    await flushEffects();
    await openWorkspaceTab();

    expect(getRadixSelectTriggerText("Repository")).toBe("codesymphony");
  });

  it("shows script configuration fields in workspace settings", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openWorkspaceTab();

    expect(document.body.textContent).toContain("Default Branch");
    expect(document.body.textContent).toContain("Run Script");
    expect(document.body.textContent).toContain("Save Automation");
    expect(document.body.textContent).toContain("Setup Scripts");
    expect(document.body.textContent).toContain("Teardown Scripts");
  });

  it("shows runtime label in the settings sidebar footer", async () => {
    renderDialog(
      [makeRepo()],
      vi.fn(),
      undefined,
      {
        runtimeLabel: "Desktop runtime :4322",
        runtimeTitle: "Runtime cwd: /bundle/runtime\nDatabase: /db.sqlite",
      },
    );
    await flushEffects();

    const runtimeContext = document.body.querySelector<HTMLElement>('[data-testid="settings-runtime-context"]');

    expect(runtimeContext?.textContent).toContain("Desktop runtime :4322");
    expect(runtimeContext?.getAttribute("title")).toContain("Runtime cwd: /bundle/runtime");
  });

  it("keeps save automation enabled after autosave even before fields are filled", async () => {
    vi.useFakeTimers();
    try {
      renderDialog([makeRepo()]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const workspaceButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Workspace",
      );
      if (!workspaceButton) {
        throw new Error("Workspace tab not found");
      }
      await act(async () => {
        workspaceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const enabledCheckbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!enabledCheckbox) {
        throw new Error("Save automation toggle not found");
      }

      await act(async () => {
        enabledCheckbox.click();
      });

      expect(enabledCheckbox.checked).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(apiMocks.updateRepositoryScripts).toHaveBeenCalledWith("r1", expect.objectContaining({
        saveAutomation: {
          enabled: true,
          target: "active_run_session",
          filePatterns: [],
          actionType: "send_stdin",
          payload: "",
          debounceMs: 400,
        },
      }));
      expect((document.body.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
      expect(document.body.textContent).toContain("Preset");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the Flutter template and autosaves generic save automation settings", async () => {
    vi.useFakeTimers();
    try {
      renderDialog([makeRepo()]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const workspaceButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Workspace",
      );
      if (!workspaceButton) {
        throw new Error("Workspace tab not found");
      }
      await act(async () => {
        workspaceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
      });

      const enabledCheckbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (!enabledCheckbox) {
        throw new Error("Save automation toggle not found");
      }

      await act(async () => {
        enabledCheckbox.click();
      });

      await setRadixSelectValue("Save automation preset", "Flutter hot reload");

      const payloadInput = document.body.querySelector('input[placeholder="reload"]') as HTMLInputElement | null;
      const filePatternsTextarea = Array.from(document.body.querySelectorAll("textarea")).find((textarea) =>
        textarea.getAttribute("placeholder")?.includes("lib/**/*.dart"),
      ) as HTMLTextAreaElement | undefined;

      if (!payloadInput || !filePatternsTextarea) {
        throw new Error("Save automation inputs not found");
      }

      expect(filePatternsTextarea.value).toBe("lib/**/*.dart");
      expect(payloadInput.value).toBe("r");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(apiMocks.updateRepositoryScripts).toHaveBeenCalledWith("r1", expect.objectContaining({
        saveAutomation: {
          enabled: true,
          target: "active_run_session",
          filePatterns: ["lib/**/*.dart"],
          actionType: "send_stdin",
          payload: "r",
          debounceMs: 400,
        },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onClose when close triggered", async () => {
    const onClose = vi.fn();
    renderDialog([], onClose);
    await flushEffects();

    const closeButton = document.body.querySelector('button[aria-label="Close settings"]') as HTMLButtonElement | null;
    if (!closeButton) {
      throw new Error("Close settings button not found");
    }

    await act(async () => {
      closeButton.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps dirty workspace form values when repositories refresh", async () => {
    renderDialog([makeRepo({ runScript: ["npm run dev"] })]);
    await flushEffects();
    await openWorkspaceTab();

    expect(getRadixSelectTriggerText("Default Branch")).toBe("main");

    await setRadixSelectValue("Default Branch", "dev");
    await flushEffects();
    expect(getRadixSelectTriggerText("Default Branch")).toBe("dev");

    renderDialog([
      makeRepo({
        runScript: ["remote refresh"],
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    ]);
    await flushEffects();

    expect(getRadixSelectTriggerText("Default Branch")).toBe("dev");
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
    await openWorkspaceTab();

    await setRadixSelectValue("Repository", "other-repo");
    await flushEffects();

    renderDialog([makeRepo()]);
    await flushEffects();

    const runScriptTextarea = document.body.querySelector('textarea[rows="3"]') as HTMLTextAreaElement;

    expect(getRadixSelectTriggerText("Repository")).toBe("test-repo");
    expect(runScriptTextarea.value).toBe("");
  });

  it("syncs fetched model providers back to the parent when the Models tab opens", async () => {
    const providers = [{
      id: "provider-1",
      agent: "claude" as const,
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
    await openModelsTab();

    expect(onProvidersChanged).toHaveBeenLastCalledWith(providers);
    expect(document.body.textContent).toContain("claude-custom");
  });

  it("does not show active or inactive controls in the Models tab", async () => {
    const providers = [{
      id: "provider-1",
      agent: "claude" as const,
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
    await openModelsTab();

    expect(document.body.textContent).not.toContain("Active");
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.title === "Activate" || button.title === "Deactivate")).toBe(false);
    expect(document.body.textContent).toContain("choose them per thread under Claude in the composer");
  });

  it("switches provider placeholders based on the selected agent and supports endpoint tests for Codex and OpenCode entries", async () => {
    renderDialog([makeRepo()]);
    await openModelsTab();

    const addButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    if (!addButton) {
      throw new Error("Add provider button not found");
    }

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain("Agent");
    expect(document.body.querySelector('input[placeholder=\'e.g. "claude-sonnet-4-6", "glm-4.7"\']')).not.toBeNull();
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Test")).toBe(true);

    await setRadixSelectValue("Provider CLI Agent", "Codex");
    await flushEffects();

    expect(document.body.querySelector('input[placeholder=\'e.g. "gpt-5.4", "gpt-5.3-codex"\']')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="Leave empty to use Codex CLI defaults"]')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="Only if your Codex setup needs it"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Responses-compatible entries can be simple model aliases like gpt-5.4");
    expect(document.body.textContent).toContain("Endpoint tests validate OpenAI Responses API compatible backends before the Codex CLI runtime starts.");
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Test")).toBe(true);

    await setRadixSelectValue("Provider CLI Agent", "OpenCode");
    await flushEffects();

    expect(document.body.querySelector('input[placeholder=\'e.g. "openai/gpt-5" or "gpt-5-custom"\']')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="Leave empty when Model ID already uses provider/model"]')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="Only for custom OpenCode endpoints"]')).not.toBeNull();
    expect(document.body.textContent).toContain("For built-in OpenCode providers, enter Model ID as provider/model");
    expect(document.body.textContent).toContain("Built-in OpenCode auth and /connect flows still work even if you never add an entry here.");
  });

  it("does not offer Cursor as a custom provider option and keeps Cursor provider edits non-testable", async () => {
    const providers = [{
      id: "provider-cursor-1",
      agent: "cursor" as const,
      name: "Cursor Account",
      modelId: "default[]",
      baseUrl: null,
      apiKeyMasked: "",
      isActive: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);

    renderDialog([makeRepo()]);
    await openModelsTab();

    expect(document.body.textContent).toContain("Cursor Account");
    expect(document.body.textContent).toContain("Cursor");

    const addButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    if (!addButton) {
      throw new Error("Add provider button not found");
    }

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(await getRadixSelectOptions("Provider CLI Agent")).toEqual(["Claude", "Codex", "OpenCode"]);

    const editButton = document.body.querySelector('button[aria-label="Edit Cursor provider Cursor Account (default[])"]') as HTMLButtonElement | null;
    if (!editButton) {
      throw new Error("Edit Cursor provider button not found");
    }

    await act(async () => {
      editButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.querySelector('input[placeholder="Cursor built-in models are managed via Cursor account settings"]')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="Cursor custom endpoints are not supported"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Cursor models come from the authenticated Cursor account over ACP.");

    const testButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    ) as HTMLButtonElement | undefined;
    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    ) as HTMLButtonElement | undefined;
    if (!testButton || !saveButton) {
      throw new Error("Cursor provider form buttons not found");
    }

    expect(testButton.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);
    expect(document.body.textContent).toContain("No custom provider rows or endpoint tests are available for Cursor.");
  });

  it("passes the selected OpenCode agent when testing a provider", async () => {
    renderDialog([makeRepo()]);
    await openModelsTab();

    const addButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    if (!addButton) {
      throw new Error("Add provider button not found");
    }

    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    const providerNameInput = document.body.querySelector('input[aria-label="Provider Name"]') as HTMLInputElement | null;
    if (!providerNameInput) {
      throw new Error("Provider form fields not found");
    }

    await setRadixSelectValue("Provider CLI Agent", "OpenCode");
    await flushEffects();

    const modelIdInput = document.body.querySelector('input[aria-label="Provider Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("OpenCode test controls not found");
    }

    await setInputValue(providerNameInput, "OpenCode QA");
    await setInputValue(modelIdInput, "gpt-5-custom");
    await setInputValue(baseUrlInput, "https://api.openai.com/v1");
    await setInputValue(apiKeyInput, "sk-test");
    await flushEffects();

    const testButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    ) as HTMLButtonElement | undefined;
    if (!testButton) {
      throw new Error("Test button not found");
    }
    expect(testButton.disabled).toBe(false);

    await act(async () => {
      testButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(apiMocks.testModelProvider).toHaveBeenCalledWith({
      agent: "opencode",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-5-custom",
    });
  });

  it("adds explicit labels to provider edit and delete actions", async () => {
    const providers = [{
      id: "provider-1",
      agent: "codex" as const,
      name: "OpenAI",
      modelId: "gpt-5.4",
      baseUrl: null,
      apiKeyMasked: null,
      isActive: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }, {
      id: "provider-2",
      agent: "opencode" as const,
      name: "OpenCode QA",
      modelId: "openai/gpt-5",
      baseUrl: null,
      apiKeyMasked: null,
      isActive: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);

    renderDialog([makeRepo()]);
    await openModelsTab();

    expect(document.body.querySelector('button[aria-label="Edit Codex provider OpenAI (gpt-5.4)"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Delete Codex provider OpenAI (gpt-5.4)"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Edit OpenCode provider OpenCode QA (openai/gpt-5)"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Delete OpenCode provider OpenCode QA (openai/gpt-5)"]')).not.toBeNull();
  });
});
