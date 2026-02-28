import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";

describe("QuestionCard", () => {
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
    vi.clearAllMocks();
  });

  function renderCard(overrides: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
    const onAnswer = vi.fn();
    const onDismiss = vi.fn();
    const props: Parameters<typeof QuestionCard>[0] = {
      requestId: "q-1",
      questions: [
        {
          question: "Which approach should we use?",
          options: [
            { label: "Option A" },
            { label: "Option B" },
          ],
        },
      ],
      busy: false,
      onAnswer,
      onDismiss,
      ...overrides,
    };

    act(() => {
      root.render(<QuestionCard {...props} />);
    });

    return { props, onAnswer, onDismiss };
  }

  it("calls onDismiss when dismiss button is clicked", () => {
    const { onDismiss } = renderCard();

    const dismissButton = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss question q-1"]');
    expect(dismissButton).toBeDefined();

    act(() => {
      dismissButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("q-1");
  });

  it("disables dismiss button while busy", () => {
    renderCard({ busy: true });

    const dismissButton = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss question q-1"]');
    expect(dismissButton).toBeDefined();
    expect(dismissButton?.disabled).toBe(true);
  });
});
