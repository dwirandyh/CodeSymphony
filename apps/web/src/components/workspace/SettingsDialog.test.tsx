import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
  CursorModelCatalogEntry,
  ModelProvider,
  OpencodeModelCatalogEntry,
  Repository,
  SaveAutomationConfig,
} from "@codesymphony/shared-types";
import { SettingsDialog } from "./SettingsDialog";
import { AGENT_DEFAULTS_STORAGE_KEY } from "../../pages/workspace/agentDefaults";
import { DEFAULT_GENERAL_SETTINGS, getModifierEnterLabel } from "../../lib/generalSettings";

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });

  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return result.then(() => Promise.resolve());
  }

  return undefined;
}

const apiMocks = vi.hoisted(() => ({
  updateRepositoryScripts: vi.fn(),
  listBranches: vi.fn(),
  listModelProviders: vi.fn(),
  createModelProvider: vi.fn(),
  updateModelProvider: vi.fn(),
  deleteModelProvider: vi.fn(),
  createModelProviderModel: vi.fn(),
  deleteModelProviderModel: vi.fn(),
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
    createModelProviderModel: apiMocks.createModelProviderModel,
    deleteModelProviderModel: apiMocks.deleteModelProviderModel,
    testModelProvider: apiMocks.testModelProvider,
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const claudeModels = [
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    description: "Built-in Claude model.",
  },
  {
    id: "claude-opus-4-6",
    name: "Opus 4.6",
    description: "Most capable for complex work.",
  },
] as const;
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
const cursorModels = [
  {
    id: "default[]",
    name: "Auto",
  },
  {
    id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
    name: "GPT-5.4",
  },
] as const;
const opencodeModels = [
  {
    id: "github-copilot/gpt-5.5",
    name: "GPT-5.5",
    providerId: "github-copilot",
  },
  {
    id: "zai/glm-5-turbo",
    name: "GLM-5-Turbo",
    providerId: "zai",
  },
  {
    id: "jatevo/gpt-5.5",
    name: "gpt-5.5 Jetevo",
    providerId: "Jetevo",
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
  apiMocks.createModelProviderModel.mockResolvedValue({});
  apiMocks.deleteModelProviderModel.mockResolvedValue(undefined);
  apiMocks.testModelProvider.mockResolvedValue({ success: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(AGENT_DEFAULTS_STORAGE_KEY);
  Object.defineProperty(window, "__CS_ELECTRON__", {
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

function makeModelProvider(
  overrides: {
    id?: string;
    name?: string;
    compatibility?: "anthropic" | "openai";
    modelId?: string;
    baseUrl?: string | null;
    apiKeyMasked?: string;
  } = {},
): ModelProvider {
  const providerId = overrides.id ?? "provider-1";
  const modelId = overrides.modelId ?? "claude-custom";
  const compatibility = overrides.compatibility ?? "anthropic";
  return {
    id: providerId,
    name: overrides.name ?? "Custom",
    compatibility,
    baseUrl: overrides.baseUrl ?? "https://example.com",
    apiKeyMasked: overrides.apiKeyMasked ?? "••••",
    models: [{
      id: `${providerId}-model-1`,
      providerId,
      modelId,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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
    claudeModels?: readonly ClaudeModelCatalogEntry[];
    codexModels?: readonly CodexModelCatalogEntry[];
    cursorModels?: readonly CursorModelCatalogEntry[];
    opencodeModels?: readonly OpencodeModelCatalogEntry[];
    modelCatalogsLoading?: boolean;
    onOpenIssueReport?: () => void;
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
          claudeModels={options?.claudeModels ?? claudeModels}
          codexModels={options?.codexModels ?? codexModels}
          cursorModels={options?.cursorModels ?? cursorModels}
          opencodeModels={options?.opencodeModels ?? opencodeModels}
          modelCatalogsLoading={options?.modelCatalogsLoading}
          generalSettings={defaultGeneralSettings}
          runtimeLabel={options?.runtimeLabel}
          runtimeTitle={options?.runtimeTitle}
          onRemoveRepository={vi.fn()}
          onGeneralSettingsChange={vi.fn()}
          onOpenIssueReport={options?.onOpenIssueReport}
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

async function expandProviderRow(providerName: string) {
  const toggle = document.body.querySelector(
    `button[aria-label="Expand provider ${providerName}"], button[aria-label="Collapse provider ${providerName}"]`,
  );
  if (!(toggle instanceof HTMLElement)) {
    throw new Error(`Provider row toggle for ${providerName} not found`);
  }
  if (toggle.getAttribute("aria-label")?.startsWith("Expand")) {
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();
  }
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

async function openShortcutsTab() {
  const shortcutsButton = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Shortcuts",
  );
  if (!shortcutsButton) {
    throw new Error("Shortcuts tab not found");
  }

  await act(async () => {
    shortcutsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("shows General, Workspace, Models, Shortcuts, and Licenses tabs", async () => {
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
    expect(document.body.textContent).toContain("Shortcuts");
    expect(document.body.textContent).toContain("Licenses");
    expect(document.body.textContent).toContain("Settings");
    expect(document.body.textContent).toContain("About");
  });

  it("opens the issue report dialog from Diagnostics", async () => {
    const onOpenIssueReport = vi.fn();
    renderDialog([makeRepo()], vi.fn(), undefined, { onOpenIssueReport });
    await flushEffects();

    const reportButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Report Issue",
    );

    if (!reportButton) {
      throw new Error("Report Issue button not found");
    }

    await act(async () => {
      reportButton.click();
    });

    expect(onOpenIssueReport).toHaveBeenCalledOnce();
  });

  it("places the General item first in the settings sidebar navigation", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    const navigation = document.body.querySelector<HTMLElement>('[data-testid="settings-navigation"]');
    if (!navigation) {
      throw new Error("Settings navigation not found");
    }

    const menuButtons = Array.from(navigation.querySelectorAll("button"));
    expect(menuButtons[0]?.textContent?.trim()).toBe("General");
    expect(menuButtons[1]?.textContent?.trim()).toBe("Workspace");
    expect(menuButtons[3]?.textContent?.trim()).toBe("Shortcuts");
    expect(menuButtons[4]?.textContent?.trim()).toBe("Licenses");
  });

  it("renders mobile settings as a menu that opens a detail page", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    const mobileMenu = document.body.querySelector<HTMLElement>('[data-testid="settings-mobile-menu"]');
    if (!mobileMenu) {
      throw new Error("Mobile settings menu not found");
    }

    expect(mobileMenu.textContent).toContain("General");
    expect(mobileMenu.textContent).toContain("Repository defaults, scripts, and save automation.");

    const workspaceButton = Array.from(mobileMenu.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Workspace"),
    );
    if (!workspaceButton) {
      throw new Error("Mobile Workspace menu item not found");
    }

    await act(async () => {
      workspaceButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    const content = document.body.querySelector<HTMLElement>('[data-testid="settings-content"]');
    expect(mobileMenu.className).toContain("hidden");
    expect(content?.className).toContain("flex");
    expect(document.body.querySelector('button[aria-label="Back to settings"]')).not.toBeNull();
  });

  it("opens on the General tab by default", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();

    expect(document.body.textContent).toContain("Send messages with");
    expect(document.body.textContent).not.toContain("Default Branch");
  });

  it("renders the shortcut reference list", async () => {
    renderDialog([makeRepo()]);
    await openShortcutsTab();

    expect(document.body.textContent).toContain("Keyboard shortcuts");
    expect(document.body.querySelector('input[aria-label="Search shortcuts"]')).toBeTruthy();
    expect(document.body.textContent).toContain("Open settings");
    expect(document.body.textContent).toContain("Toggle repositories sidebar");
    expect(document.body.textContent).toContain("Focus chat input");
    expect(document.body.textContent).toContain("Open quick file picker");
    expect(document.body.textContent).toContain("Create new terminal");
    expect(document.body.textContent).toContain("Create new thread");
    expect(document.body.textContent).toContain("Previous session tab");
    expect(document.body.textContent).toContain("Next session tab");
    expect(document.body.textContent).toContain("Previous worktree");
    expect(document.body.textContent).toContain("Next worktree");
    expect(document.body.textContent).toContain("Jump to worktree 1-9");
    expect(document.body.textContent).toContain("Navigate back");
    expect(document.body.textContent).toContain("Navigate forward");
    expect(document.body.textContent).toContain("Find in terminal");
  });

  it("filters the shortcut reference list", async () => {
    renderDialog([makeRepo()]);
    await openShortcutsTab();

    const searchInput = document.body.querySelector('input[aria-label="Search shortcuts"]') as HTMLInputElement | null;
    if (!searchInput) {
      throw new Error("Shortcut search input not found");
    }

    await setInputValue(searchInput, "Navigate back");
    await flushEffects();

    expect(document.body.textContent).toContain("Navigate back");
    expect(document.body.textContent).not.toContain("Open settings");
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
    Object.defineProperty(window, "__CS_ELECTRON__", {
      value: true,
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

  it("shows a loading state while model catalogs are still being prepared", async () => {
    renderDialog([makeRepo()], vi.fn(), undefined, {
      modelCatalogsLoading: true,
    });
    await flushEffects();
    await openModelsTab();

    expect(document.body.textContent).toContain("Loading...");
  });

  it("keeps legacy built-in model selections visible when the runtime catalog uses new ids", async () => {
    renderDialog([makeRepo()], vi.fn(), undefined, {
      claudeModels: [
        {
          id: "default",
          name: "Default (recommended)",
          description: "Use the default model.",
        },
        {
          id: "opus",
          name: "Opus",
          description: "Most capable for complex work.",
        },
      ],
    });
    await flushEffects();
    await openModelsTab();

    expect(getRadixSelectTriggerText("Agent for new chats model")).toBe("Sonnet 4.6");
    expect(getRadixSelectTriggerText("Agent for commit model")).toBe("Sonnet 4.6");
    expect(getRadixSelectTriggerText("Agent for PR model")).toBe("Sonnet 4.6");
  });

  it("persists default agent selections to localStorage", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    expect(getRadixSelectTriggerText("Agent for new chats model")).toBe("Sonnet 4.6");

    await setRadixSelectValue("Agent for new chats CLI Agent", "Codex");
    const codexOptions = await getRadixSelectOptions("Agent for new chats model");
    expect(codexOptions).toContain("GPT-5.5 · Built-in");
    await setRadixSelectValue("Agent for new chats model", "GPT-5.3 Codex");

    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"agent\":\"codex\"");
    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"model\":\"gpt-5.3-codex\"");
  });

  it("uses the shared OpenCode catalog for settings model options", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    await setRadixSelectValue("Agent for new chats CLI Agent", "OpenCode");
    const options = await getRadixSelectOptions("Agent for new chats model");

    expect(options).toContain("GPT-5.5 · github-copilot");
    expect(options).toContain("GLM-5-Turbo · zai");
    expect(options).toContain("gpt-5.5 Jetevo · Jetevo");
  });

  it("preserves selected OpenCode built-in models across dialog remounts", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    await setRadixSelectValue("Agent for new chats CLI Agent", "OpenCode");
    await setRadixSelectValue("Agent for new chats model", "GPT-5.5");

    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"agent\":\"opencode\"");
    expect(window.localStorage.getItem(AGENT_DEFAULTS_STORAGE_KEY)).toContain("\"model\":\"github-copilot/gpt-5.5\"");

    act(() => root.unmount());
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    expect(getRadixSelectTriggerText("Agent for new chats CLI Agent")).toBe("OpenCode");
    expect(getRadixSelectTriggerText("Agent for new chats model")).toBe("GPT-5.5");
  });

  it("renders settings model options with composer-style model and provider detail", async () => {
    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();

    const trigger = getRadixSelectTrigger("Agent for new chats model");
    expect(trigger.querySelector(".font-medium")?.textContent).toBe("Sonnet 4.6");
    expect(trigger.querySelector(".text-muted-foreground")).toBeNull();

    const options = await openRadixSelect("Agent for new chats model");
    const sonnetOption = options.find((option) => normalizeText(option.textContent) === "Sonnet 4.6 · Built-in");
    if (!(sonnetOption instanceof HTMLElement)) {
      throw new Error("Sonnet option not found");
    }

    expect(sonnetOption.querySelector(".font-medium")?.textContent).toBe("Sonnet 4.6");
    expect(sonnetOption.querySelector(".text-muted-foreground")?.textContent).toBe("Built-in");
  });

  it("separates custom provider models from built-in models in the settings picker", async () => {
    apiMocks.listModelProviders.mockResolvedValue([
      makeModelProvider({
        id: "provider-openai-1",
        name: "OpenAI QA",
        compatibility: "openai",
        modelId: "gpt-5-custom",
        baseUrl: "https://api.openai.com/v1",
      }),
    ]);

    renderDialog([makeRepo()]);
    await flushEffects();
    await openModelsTab();
    await flushEffects();

    expect(document.body.textContent).toContain("OpenAI QA");

    await setRadixSelectValue("Agent for new chats CLI Agent", "OpenCode");
    await openRadixSelect("Agent for new chats model");

    const customSeparator = document.body.querySelector('[data-model-separator="custom"]');
    expect(customSeparator).not.toBeNull();
    expect(document.body.textContent).toContain("gpt-5-custom");
    expect(document.body.textContent).toContain("OpenAI QA");
  });

  it("reserves the macOS title bar area when running inside the desktop shell", async () => {
    Object.defineProperty(window, "__CS_ELECTRON__", {
      value: true,
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
    Object.defineProperty(window, "__CS_ELECTRON__", {
      value: true,
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

  it("shows runtime label in the settings header", async () => {
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

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    renderDialog([], onClose);
    await flushEffects();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
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
        runScript: ["bun test"],
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
    const providers = [makeModelProvider()];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);
    const onProvidersChanged = vi.fn();

    renderDialog([makeRepo()], vi.fn(), onProvidersChanged);
    await openModelsTab();

    expect(onProvidersChanged).toHaveBeenLastCalledWith(providers);
    await expandProviderRow("Custom");
    expect(document.body.textContent).toContain("claude-custom");
  });

  it("does not show active or inactive controls in the Models tab", async () => {
    const providers = [makeModelProvider()];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);

    renderDialog([makeRepo()]);
    await openModelsTab();

    expect(document.body.textContent).not.toContain("Active");
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.title === "Activate" || button.title === "Deactivate")).toBe(false);
    expect(document.body.textContent).toContain("One provider has one API compatibility and endpoint");
  });

  it("opens the provider dialog and switches placeholders based on API compatibility", async () => {
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

    expect(document.body.textContent).toContain("Provider Compatibility");
    expect(document.body.querySelector('input[placeholder=\'e.g. "claude-sonnet-4-6", "glm-4.7"\']')).not.toBeNull();
    expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Test")).toBe(true);

    await setRadixSelectValue("Provider Compatibility", "OpenAI");
    await flushEffects();

    expect(document.body.querySelector('input[placeholder=\'e.g. "gpt-5.4", "gpt-5.3-codex"\']')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="e.g. https://api.openai.com/v1 or https://lb.jatevo.ai/v1"]')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder="API Key"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Works with Codex and OpenCode.");
    expect(document.body.textContent).toContain("For Codex, the endpoint must implement the OpenAI Responses API.");
  });

  it("passes the selected compatibility when testing a provider", async () => {
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

    await setRadixSelectValue("Provider Compatibility", "OpenAI");
    await flushEffects();

    const modelIdInput = document.body.querySelector('input[aria-label="Initial Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("Provider test controls not found");
    }

    await setInputValue(providerNameInput, "OpenAI QA");
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
      compatibility: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-5-custom",
    });
  });

  it("saves a new provider and renders it in the provider list", async () => {
    const createdProvider = makeModelProvider({
      id: "provider-created",
      name: "9Router",
      compatibility: "anthropic",
      modelId: "sumo/deepseek-v4-pro",
      baseUrl: "http://43.134.228.167:20128/v1",
      apiKeyMasked: "sk-c0f5...e1d1",
    });
    apiMocks.createModelProvider.mockResolvedValueOnce(createdProvider);
    apiMocks.listModelProviders.mockResolvedValueOnce([]);
    apiMocks.listModelProviders.mockResolvedValueOnce([createdProvider]);

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
    const modelIdInput = document.body.querySelector('input[aria-label="Initial Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!providerNameInput || !modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("Provider form fields not found");
    }

    await setInputValue(providerNameInput, "9Router");
    await setInputValue(modelIdInput, "sumo/deepseek-v4-pro");
    await setInputValue(baseUrlInput, "http://43.134.228.167:20128/v1");
    await setInputValue(apiKeyInput, "sk-test");
    await flushEffects();

    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    ) as HTMLButtonElement | undefined;
    if (!saveButton) {
      throw new Error("Save button not found");
    }

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(apiMocks.createModelProvider).toHaveBeenCalledWith({
      name: "9Router",
      compatibility: "anthropic",
      baseUrl: "http://43.134.228.167:20128/v1",
      apiKey: "sk-test",
      models: [{ modelId: "sumo/deepseek-v4-pro" }],
    });
    expect(document.body.textContent).toContain("9Router");
    await expandProviderRow("9Router");
    expect(document.body.textContent).toContain("sumo/deepseek-v4-pro");
  });

  it("keeps the provider dialog open and shows the save error when creation fails", async () => {
    apiMocks.createModelProvider.mockRejectedValueOnce(new Error("Duplicate model ID"));

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
    const modelIdInput = document.body.querySelector('input[aria-label="Initial Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!providerNameInput || !modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("Provider form fields not found");
    }

    await setInputValue(providerNameInput, "9Router");
    await setInputValue(modelIdInput, "sumo/deepseek-v4-pro");
    await setInputValue(baseUrlInput, "http://43.134.228.167:20128/v1");
    await setInputValue(apiKeyInput, "sk-test");
    await flushEffects();

    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    ) as HTMLButtonElement | undefined;
    if (!saveButton) {
      throw new Error("Save button not found");
    }

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain("Add Provider");
    expect(document.body.textContent).toContain("Duplicate model ID");
  });

  it("adds a model to an existing provider without asking for provider details", async () => {
    const provider = makeModelProvider({
      id: "provider-1",
      name: "9Router",
      compatibility: "anthropic",
      modelId: "sumo/deepseek-v4-pro",
      baseUrl: "http://43.134.228.167:20128/v1",
    });
    const updatedProvider: ModelProvider = {
      ...provider,
      models: [
        ...(provider.models ?? []),
        {
          id: "provider-1-model-2",
          providerId: provider.id,
          modelId: "sumo/kimi-k2.6",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    apiMocks.listModelProviders.mockResolvedValueOnce([provider]);
    apiMocks.createModelProviderModel.mockResolvedValueOnce(updatedProvider);

    renderDialog([makeRepo()]);
    await openModelsTab();
    await expandProviderRow("9Router");

    const createProviderCallsBefore = apiMocks.createModelProvider.mock.calls.length;
    const addModelButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.replace(/\s+/g, " ").trim() === "Add model",
    );
    if (!addModelButton) {
      throw new Error("Add model button not found");
    }

    await act(async () => {
      addModelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain("Add a model ID for 9Router.");

    const modelIdInput = document.body.querySelector('input[aria-label="Model ID"]') as HTMLInputElement | null;
    if (!modelIdInput) {
      throw new Error("Add model dialog input not found");
    }

    await setInputValue(modelIdInput, "sumo/kimi-k2.6");
    await flushEffects();

    const dialog = document.body.querySelector('[role="dialog"]');
    const confirmAddModelButton = dialog
      ? Array.from(dialog.querySelectorAll("button")).find(
        (button) => normalizeText(button.textContent) === "Add model",
      )
      : undefined;
    if (!confirmAddModelButton) {
      throw new Error("Add model dialog confirm button not found");
    }

    await act(async () => {
      confirmAddModelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(apiMocks.createModelProviderModel).toHaveBeenCalledWith("provider-1", {
      modelId: "sumo/kimi-k2.6",
    });
    expect(apiMocks.createModelProvider.mock.calls.length).toBe(createProviderCallsBefore);
    expect(document.body.textContent).toContain("sumo/deepseek-v4-pro");
    expect(document.body.textContent).toContain("sumo/kimi-k2.6");
  });

  it("disables provider testing and saving until the base URL is valid", async () => {
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
    const modelIdInput = document.body.querySelector('input[aria-label="Initial Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!providerNameInput || !modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("Provider form fields not found");
    }

    await setInputValue(providerNameInput, "OpenAI QA");
    await setInputValue(modelIdInput, "gpt-5-custom");
    await setInputValue(baseUrlInput, "url openai: https://api.z.ai/api/paas/v4");
    await setInputValue(apiKeyInput, "sk-test");
    await flushEffects();

    const testButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    ) as HTMLButtonElement | undefined;
    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    ) as HTMLButtonElement | undefined;
    if (!testButton || !saveButton) {
      throw new Error("Provider action buttons not found");
    }

    expect(baseUrlInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Enter a valid http:// or https:// URL.");
    expect(testButton.disabled).toBe(true);
    expect(saveButton.disabled).toBe(true);

    await setInputValue(baseUrlInput, "https://api.z.ai/api/paas/v4");
    await flushEffects();

    expect(baseUrlInput.getAttribute("aria-invalid")).toBe("false");
    expect(document.body.textContent).not.toContain("Enter a valid http:// or https:// URL.");
    expect(testButton.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
  });

  it("clears the previous provider test result when the form changes", async () => {
    apiMocks.testModelProvider.mockResolvedValueOnce({
      success: false,
      error: "Provider returned 404: not found",
    });
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
    const modelIdInput = document.body.querySelector('input[aria-label="Initial Model ID"]') as HTMLInputElement | null;
    const baseUrlInput = document.body.querySelector('input[aria-label="Provider Base URL"]') as HTMLInputElement | null;
    const apiKeyInput = document.body.querySelector('input[aria-label="Provider API Key"]') as HTMLInputElement | null;
    if (!providerNameInput || !modelIdInput || !baseUrlInput || !apiKeyInput) {
      throw new Error("Provider form fields not found");
    }

    await setInputValue(providerNameInput, "OpenAI QA");
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

    await act(async () => {
      testButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(document.body.textContent).toContain("Provider returned 404: not found");

    await setInputValue(baseUrlInput, "https://api.z.ai/api/paas/v4");
    await flushEffects();

    expect(document.body.textContent).not.toContain("Provider returned 404: not found");
  });

  it("adds explicit labels to provider edit and delete actions", async () => {
    const providers = [
      makeModelProvider({
        id: "provider-1",
        name: "OpenAI",
        compatibility: "openai",
        modelId: "gpt-5.4",
        baseUrl: null,
        apiKeyMasked: "",
      }),
      makeModelProvider({
        id: "provider-2",
        name: "Anthropic QA",
        compatibility: "anthropic",
        modelId: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1",
        apiKeyMasked: "",
      }),
    ];
    apiMocks.listModelProviders.mockResolvedValueOnce(providers);

    renderDialog([makeRepo()]);
    await openModelsTab();

    expect(document.body.querySelector('button[aria-label="Edit provider OpenAI"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Delete provider OpenAI"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Edit provider Anthropic QA"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Delete provider Anthropic QA"]')).not.toBeNull();
  });

  it("tests the selected model for a saved provider", async () => {
    const provider = makeModelProvider({
      id: "provider-1",
      name: "9Router",
      compatibility: "anthropic",
      modelId: "sumo/deepseek-v4-pro",
    });
    provider.models = [
      ...(provider.models ?? []),
      {
      id: "provider-1-model-2",
      providerId: provider.id,
      modelId: "sumo/kimi-k2.6",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    apiMocks.listModelProviders.mockResolvedValueOnce([provider]);

    apiMocks.testModelProvider.mockResolvedValueOnce({ success: true });

    renderDialog([makeRepo()]);
    await openModelsTab();
    await expandProviderRow("9Router");

    const testButton = document.body.querySelector(
      'button[aria-label="Test model sumo/kimi-k2.6"]',
    ) as HTMLButtonElement | null;
    if (!testButton) {
      throw new Error("Per-model test button not found");
    }

    await act(async () => {
      testButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushEffects();

    expect(apiMocks.testModelProvider).toHaveBeenCalledWith({
      providerId: "provider-1",
      modelId: "sumo/kimi-k2.6",
    });
  });
});
