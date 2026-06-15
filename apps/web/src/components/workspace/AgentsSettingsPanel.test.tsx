import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@codesymphony/shared-types";
import { AgentsSettingsPanel } from "./AgentsSettingsPanel";

function act(callback: () => void): void;
function act(callback: () => Promise<void>): Promise<void>;
function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
    return (result as Promise<void>).then(() => Promise.resolve());
  }
  return undefined;
}

const apiMocks = vi.hoisted(() => ({
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
  testAgentConfig: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  api: {
    getAgentConfig: apiMocks.getAgentConfig,
    updateAgentConfig: apiMocks.updateAgentConfig,
    testAgentConfig: apiMocks.testAgentConfig,
  },
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    claudePath: null,
    codexPath: null,
    opencodePath: null,
    claudePathResolved: "claude",
    codexPathResolved: "codex",
    opencodePathResolved: "opencode",
    cursorApiKeyMasked: "",
    cursorApiKeySet: false,
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

async function renderPanel() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentsSettingsPanel />
      </QueryClientProvider>,
    );
  });
  await flushEffects();
  await flushEffects();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  queryClient.clear();
});

describe("AgentsSettingsPanel", () => {
  it("renders Claude, Codex, OpenCode, and Cursor sections", async () => {
    apiMocks.getAgentConfig.mockResolvedValue(baseConfig());
    await renderPanel();

    expect(container.querySelector('[data-testid="agent-section-claude"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-section-codex"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-section-opencode"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-section-cursor"]')).not.toBeNull();
  });

  it("shows the masked cursor key in the field when a key is set", async () => {
    apiMocks.getAgentConfig.mockResolvedValue(
      baseConfig({ cursorApiKeySet: true, cursorApiKeyMasked: "cursor-...7890" }),
    );
    await renderPanel();

    const keyInput = container.querySelector('[data-testid="cursor-key-input"]') as HTMLInputElement;
    expect(keyInput).not.toBeNull();
    // Field is prefilled with the masked key (prefix + ... + suffix), never the raw key.
    expect(keyInput.value).toBe("cursor-...7890");
    expect(keyInput.value).not.toContain("secret");
  });

  it("submits only the changed path field on save", async () => {
    apiMocks.getAgentConfig.mockResolvedValue(baseConfig());
    apiMocks.updateAgentConfig.mockResolvedValue(baseConfig({ claudePath: "/custom/claude" }));
    await renderPanel();

    const input = container.querySelector('input[aria-label="Claude Code CLI path"]') as HTMLInputElement;
    await setInputValue(input, "/custom/claude");

    const claudeSection = container.querySelector('[data-testid="agent-section-claude"]')!;
    const saveButton = Array.from(claudeSection.querySelectorAll("button")).find(
      (b) => b.textContent === "Save",
    ) as HTMLButtonElement;
    await act(async () => { saveButton.click(); });
    await flushEffects();

    expect(apiMocks.updateAgentConfig).toHaveBeenCalledTimes(1);
    expect(apiMocks.updateAgentConfig).toHaveBeenCalledWith({ claudePath: "/custom/claude" });
  });

  it("shows the test result inline", async () => {
    apiMocks.getAgentConfig.mockResolvedValue(baseConfig());
    apiMocks.testAgentConfig.mockResolvedValue({ ok: true, detail: "codex 1.2.3" });
    await renderPanel();

    const codexSection = container.querySelector('[data-testid="agent-section-codex"]')!;
    const testButton = Array.from(codexSection.querySelectorAll("button")).find(
      (b) => b.textContent === "Test",
    ) as HTMLButtonElement;
    await act(async () => { testButton.click(); });
    await flushEffects();

    expect(apiMocks.testAgentConfig).toHaveBeenCalledWith({ agent: "codex", value: "codex" });
    expect(codexSection.textContent).toContain("codex 1.2.3");
  });
});
