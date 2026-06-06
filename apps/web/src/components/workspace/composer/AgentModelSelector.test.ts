import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModelSelector, calculateAgentModelPopoverPosition } from "./AgentModelSelector";

describe("calculateAgentModelPopoverPosition", () => {
  it("clamps an above-positioned popover into the viewport", () => {
    const position = calculateAgentModelPopoverPosition({
      triggerRect: {
        top: 260,
        left: 240,
        bottom: 296,
      } as DOMRect,
      containerRect: {
        top: 0,
        left: 0,
        bottom: 0,
      } as DOMRect,
      viewportWidth: 1280,
      viewportHeight: 340,
      popoverWidth: 468,
      popoverHeight: 320,
    });

    expect(position.top).toBe(16);
    expect(position.left).toBe(240);
  });

  it("places the popover below when that side has more usable space", () => {
    const position = calculateAgentModelPopoverPosition({
      triggerRect: {
        top: 80,
        left: 320,
        bottom: 116,
      } as DOMRect,
      containerRect: {
        top: 0,
        left: 0,
        bottom: 0,
      } as DOMRect,
      viewportWidth: 1280,
      viewportHeight: 760,
      popoverWidth: 468,
      popoverHeight: 240,
    });

    expect(position.top).toBe(122);
    expect(position.left).toBe(320);
  });
});

describe("AgentModelSelector", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it("caps the inline model list to 10 visible items before scrolling", () => {
    const onSelectionChange = vi.fn();
    const opencodeModels = Array.from({ length: 12 }, (_, index) => ({
      id: `opencode/model-${index + 1}`,
      name: `Model ${index + 1}`,
      providerId: "opencode",
    }));

    act(() => {
      root.render(
        createElement(AgentModelSelector, {
          selection: {
            agent: "opencode",
            model: opencodeModels[0]!.id,
            modelProviderId: null,
          },
          providers: [],
          opencodeModels,
          showAgentList: true,
          onSelectionChange,
        }),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Select CLI agent and model"]');
    if (!trigger) {
      throw new Error("Model selector trigger not found");
    }

    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const scroller = container.querySelector<HTMLDivElement>('[data-agent-model-panel="overlay"] .overflow-y-auto');
    expect(scroller).toBeTruthy();
    expect(scroller?.style.maxHeight).toBe("280px");
    expect(scroller?.querySelectorAll("button")).toHaveLength(12);
  });

  it("shows a loading state while the preview agent catalog is still being fetched", () => {
    const onSelectionChange = vi.fn();

    act(() => {
      root.render(
        createElement(AgentModelSelector, {
          selection: {
            agent: "cursor",
            model: "default[]",
            modelProviderId: null,
          },
          providers: [],
          cursorModels: [],
          opencodeModels: [],
          modelCatalogReadyByAgent: {
            claude: true,
            codex: true,
            cursor: false,
            opencode: true,
          },
          showAgentList: true,
          onSelectionChange,
        }),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Select CLI agent and model"]');
    if (!trigger) {
      throw new Error("Model selector trigger not found");
    }

    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Loading models...");
  });

  it("selects an OpenAI-compatible custom provider for a new Codex thread", () => {
    const onSelectionChange = vi.fn();

    act(() => {
      root.render(
        createElement(AgentModelSelector, {
          selection: {
            agent: "codex",
            model: "gpt-5.4",
            modelProviderId: null,
          },
          providers: [{
            id: "provider-codex",
            name: "Team Codex",
            compatibility: "openai",
            baseUrl: "https://provider.example.com/v1",
            apiKeyMasked: "sk-test...7890",
            models: [{
              id: "provider-codex-model",
              providerId: "provider-codex",
              modelId: "gpt-5-custom",
              createdAt: "2026-06-03T08:00:00.000Z",
              updatedAt: "2026-06-03T08:00:00.000Z",
            }],
            createdAt: "2026-06-03T08:00:00.000Z",
            updatedAt: "2026-06-03T08:00:00.000Z",
          }],
          codexModels: [{
            id: "gpt-5.4",
            name: "GPT-5.4",
            description: "Built-in Codex model.",
            hidden: false,
            isDefault: true,
          }],
          opencodeModels: [],
          showAgentList: true,
          onSelectionChange,
        }),
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Select CLI agent and model"]');
    if (!trigger) {
      throw new Error("Model selector trigger not found");
    }

    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const providerButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Team Codex"));
    if (!providerButton) {
      throw new Error("Custom provider option not found");
    }

    act(() => {
      providerButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onSelectionChange).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5-custom",
      modelProviderId: "provider-codex",
    });
  });
});
