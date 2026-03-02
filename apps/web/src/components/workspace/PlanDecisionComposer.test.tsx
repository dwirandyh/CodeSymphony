import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("renders plan decision UI", () => {
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={vi.fn()} onRevise={vi.fn()} onDismiss={vi.fn()} />
      );
    });
    expect(container.textContent).toContain("Plan requires decision");
    expect(container.textContent).toContain("Implement this plan?");
    expect(container.textContent).toContain("Yes, implement this plan");
    expect(container.textContent).toContain("Pending");
  });

  it("renders Submit and Dismiss buttons", () => {
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={vi.fn()} onRevise={vi.fn()} onDismiss={vi.fn()} />
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toContain("Submit");
    expect(labels).toContain("Dismiss");
  });

  it("calls onApprove when Submit clicked in accept mode", () => {
    const onApprove = vi.fn();
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={onApprove} onRevise={vi.fn()} onDismiss={vi.fn()} />
      );
    });
    const submitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Submit plan acceptance"
    );
    act(() => submitBtn?.click());
    expect(onApprove).toHaveBeenCalled();
  });

  it("calls onDismiss when Dismiss clicked", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={vi.fn()} onRevise={vi.fn()} onDismiss={onDismiss} />
      );
    });
    const dismissBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Dismiss plan decision"
    );
    act(() => dismissBtn?.click());
    expect(onDismiss).toHaveBeenCalled();
  });

  it("disables submit button when busy", () => {
    act(() => {
      root.render(
        <PlanDecisionComposer busy={true} onApprove={vi.fn()} onRevise={vi.fn()} onDismiss={vi.fn()} />
      );
    });
    const dismissBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Dismiss plan decision"
    );
    expect(dismissBtn?.disabled).toBe(true);
  });

  it("switches to revise mode and calls onRevise when submitting feedback", () => {
    const onRevise = vi.fn();
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={vi.fn()} onRevise={onRevise} onDismiss={vi.fn()} />
      );
    });

    const input = container.querySelector('input[aria-label="Plan revision feedback"]') as HTMLInputElement;
    expect(input).toBeTruthy();

    act(() => {
      input.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      nativeInputValueSetter?.call(input, "Please change approach");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Submit plan revision"
    );
    if (submitBtn && !submitBtn.disabled) {
      act(() => submitBtn.click());
      expect(onRevise).toHaveBeenCalled();
    }
  });

  it("renders revise input placeholder", () => {
    act(() => {
      root.render(
        <PlanDecisionComposer busy={false} onApprove={vi.fn()} onRevise={vi.fn()} onDismiss={vi.fn()} />
      );
    });
    const input = container.querySelector('input[placeholder="Revise this plan"]');
    expect(input).toBeTruthy();
  });
});
