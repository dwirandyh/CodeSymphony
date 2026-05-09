import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "@codesymphony/shared-types";
import { PlanDecisionComposer } from "./PlanDecisionComposer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PlanDecisionComposer", () => {
  const providers: ModelProvider[] = [{
    id: "provider-codex-1",
    agent: "codex",
    name: "Team Codex",
    modelId: "gpt-5-custom",
    baseUrl: "https://example.invalid/v1",
    apiKeyMasked: "sk-***",
    isActive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }];

  function renderComposer(overrides: Partial<Parameters<typeof PlanDecisionComposer>[0]> = {}) {
    act(() => {
      root.render(
        <PlanDecisionComposer
          busy={false}
          currentSelection={{
            agent: "codex",
            model: "gpt-5.4",
            modelProviderId: null,
          }}
          threadKind="default"
          hasMessages={true}
          providers={providers}
          cursorModels={[]}
          opencodeModels={[]}
          onApprove={vi.fn()}
          onRevise={vi.fn()}
          {...overrides}
        />
      );
    });
  }

  it("renders the decision UI with the shared selector and compact actions", () => {
    renderComposer();

    expect(container.textContent).toContain("Plan requires decision");
    expect(container.textContent).toContain("Implement this plan?");
    expect(container.textContent).toContain("Pending");
    expect(container.querySelector('button[aria-label="Select plan execution target"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Implement plan"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Handover plan"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Dismiss");
  });

  it("calls onApprove with same-thread execution when Implement is clicked", () => {
    const onApprove = vi.fn();
    renderComposer({ onApprove });

    const implementButton = container.querySelector('button[aria-label="Implement plan"]');
    act(() => implementButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onApprove).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "same_thread_switch",
    });
  });

  it("calls onApprove with explicit handoff when Handover is clicked", () => {
    const onApprove = vi.fn();
    renderComposer({ onApprove });

    const handoverButton = container.querySelector('button[aria-label="Handover plan"]');
    act(() => handoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onApprove).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });
  });

  it("shows only Handover when the selected target requires a handoff", () => {
    const onApprove = vi.fn();
    renderComposer({ onApprove });

    const selectorButton = container.querySelector('button[aria-label="Select plan execution target"]') as HTMLButtonElement;
    act(() => selectorButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const agentList = container.querySelector('[data-cli-agent-list="true"]');
    const codexAgentButton = Array.from(agentList?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes("Codex"));
    if (!codexAgentButton) {
      throw new Error("Codex agent button not found");
    }

    act(() => codexAgentButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const customModelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("GPT-5 Custom") && button.textContent?.includes("Team Codex"));
    if (!customModelButton) {
      throw new Error("Custom Codex model button not found");
    }

    act(() => customModelButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    expect(container.querySelector('button[aria-label="Implement plan"]')).toBeNull();
    const handoverButton = container.querySelector('button[aria-label="Handover plan"]');
    expect(handoverButton).toBeTruthy();

    act(() => handoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onApprove).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5-custom",
      modelProviderId: "provider-codex-1",
      executionKind: "handoff",
    });
  });

  it("clicks Handover plan in the handoff-required flow and requests handoff execution", () => {
    const onApprove = vi.fn();
    renderComposer({
      onApprove,
      currentSelection: {
        agent: "claude",
        model: "claude-sonnet-4-6",
        modelProviderId: null,
      },
    });

    const selectorButton = container.querySelector('button[aria-label="Select plan execution target"]') as HTMLButtonElement;
    act(() => selectorButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const agentList = container.querySelector('[data-cli-agent-list="true"]');
    const codexAgentButton = Array.from(agentList?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes("Codex"));
    if (!codexAgentButton) {
      throw new Error("Codex agent button not found");
    }

    act(() => codexAgentButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const builtinCodexButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("GPT-5.4") && button.textContent?.includes("Built-in"));
    if (!builtinCodexButton) {
      throw new Error("Built-in Codex model button not found");
    }

    act(() => builtinCodexButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const handoverButton = container.querySelector('button[aria-label="Handover plan"]');
    expect(container.querySelector('button[aria-label="Implement plan"]')).toBeNull();

    act(() => handoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onApprove).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5.4",
      modelProviderId: null,
      executionKind: "handoff",
    });
  });

  it("preserves the selected handoff target across parent rerenders with unchanged current thread values", () => {
    const onApprove = vi.fn();
    renderComposer({ onApprove });

    const selectorButton = container.querySelector('button[aria-label="Select plan execution target"]') as HTMLButtonElement;
    act(() => selectorButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const agentList = container.querySelector('[data-cli-agent-list="true"]');
    const claudeAgentButton = Array.from(agentList?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.includes("Claude"));
    if (!claudeAgentButton) {
      throw new Error("Claude agent button not found");
    }

    act(() => claudeAgentButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    const sonnetButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Sonnet 4.6") && button.textContent?.includes("Built-in"));
    if (!sonnetButton) {
      throw new Error("Claude Sonnet 4.6 button not found");
    }

    act(() => sonnetButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

    renderComposer({ onApprove });

    const handoverButton = container.querySelector('button[aria-label="Handover plan"]');
    act(() => handoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onApprove).toHaveBeenCalledWith({
      agent: "claude",
      model: "claude-sonnet-4-6",
      modelProviderId: null,
      executionKind: "handoff",
    });
  });

  it("disables execution actions when busy", () => {
    renderComposer({ busy: true });

    expect((container.querySelector('button[aria-label="Implement plan"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    expect((container.querySelector('button[aria-label="Handover plan"]') as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  it("switches to revise mode and submits feedback", () => {
    const onRevise = vi.fn();
    renderComposer({ onRevise });

    const input = container.querySelector('input[aria-label="Plan revision feedback"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      input.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      nativeInputValueSetter?.call(input, "Please change approach");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const submitRevisionButton = container.querySelector('button[aria-label="Submit plan revision"]');
    act(() => submitRevisionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onRevise).toHaveBeenCalledWith("Please change approach");
  });
});
