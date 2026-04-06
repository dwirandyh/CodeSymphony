import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";

let container: HTMLDivElement;
let root: Root;

function setTextInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("QuestionCard", () => {
  const baseProps = {
    requestId: "q-1",
    busy: false,
    onAnswer: vi.fn(),
    onDismiss: vi.fn(),
  };

  it("renders nothing when questions array is empty", () => {
    act(() => {
      root.render(<QuestionCard {...baseProps} questions={[]} />);
    });
    expect(container.textContent).toBe("");
  });

  it("renders question text", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{ question: "Which framework?" }]}
        />
      );
    });
    expect(container.textContent).toContain("Which framework?");
  });

  it("renders question with header", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{ question: "Pick one", header: "Configuration" }]}
        />
      );
    });
    expect(container.textContent).toContain("Configuration");
  });

  it("renders options as selectable buttons", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{
            question: "Pick one",
            options: [
              { label: "Option A" },
              { label: "Option B", description: "B description" },
            ],
          }]}
        />
      );
    });
    expect(container.textContent).toContain("Option A");
    expect(container.textContent).toContain("Option B");
    expect(container.textContent).toContain("B description");
    expect(container.querySelectorAll("input[type='text']")).toHaveLength(1);
  });

  it("renders free text input when no options", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{ question: "Enter your answer" }]}
        />
      );
    });
    const input = container.querySelector("textarea, input[type='text'], input:not([type])");
    expect(input).toBeTruthy();
  });

  it("shows dismiss button", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{ question: "Q?" }]}
        />
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const dismissBtn = buttons.find((b) => b.getAttribute("aria-label")?.includes("Dismiss"));
    expect(dismissBtn).toBeTruthy();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          onDismiss={onDismiss}
          questions={[{ question: "Q?" }]}
        />
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const dismissBtn = buttons.find((b) => b.getAttribute("aria-label")?.includes("Dismiss"));
    if (dismissBtn) {
      act(() => dismissBtn.click());
      expect(onDismiss).toHaveBeenCalledWith("q-1");
    }
  });

  it("shows step navigation for multiple questions", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[
            { question: "Q1?" },
            { question: "Q2?" },
          ]}
        />
      );
    });
    expect(container.textContent).toContain("1 / 2");
  });

  it("selects option on click", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          questions={[{
            question: "Pick one",
            options: [{ label: "Alpha" }, { label: "Beta" }],
          }]}
        />
      );
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const alphaBtn = buttons.find((b) => b.textContent?.includes("Alpha"));
    if (alphaBtn) {
      act(() => alphaBtn.click());
    }
  });

  it("allows manual input for single-select questions with options", () => {
    const onAnswer = vi.fn();
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          onAnswer={onAnswer}
          questions={[{
            question: "Pick one",
            options: [{ label: "Alpha" }, { label: "Beta" }],
          }]}
        />
      );
    });

    const input = container.querySelector("input[type='text']");
    expect(input).toBeTruthy();
    if (!input) {
      return;
    }

    act(() => {
      input.dispatchEvent(new Event("focus", { bubbles: true }));
      setTextInputValue(input, "Gamma");
    });

    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.includes("Submit answer"),
    );
    expect(submitButton?.hasAttribute("disabled")).toBe(false);

    if (submitButton) {
      act(() => submitButton.click());
    }

    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      "Pick one": "Gamma",
    });
  });

  it("combines manual input with selected options for multi-select questions", () => {
    const onAnswer = vi.fn();
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          onAnswer={onAnswer}
          questions={[{
            question: "Pick many",
            multiSelect: true,
            options: [{ label: "Alpha" }, { label: "Beta" }],
          }]}
        />
      );
    });

    const alphaBtn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Alpha"));
    if (alphaBtn) {
      act(() => alphaBtn.click());
    }

    const input = container.querySelector("input[type='text']");
    expect(input).toBeTruthy();
    if (!input) {
      return;
    }

    act(() => {
      setTextInputValue(input, "Gamma");
    });

    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.includes("Submit answer"),
    );
    if (submitButton) {
      act(() => submitButton.click());
    }

    expect(onAnswer).toHaveBeenCalledWith("q-1", {
      "Pick many": "Alpha, Gamma",
    });
  });

  it("disables interactions when busy", () => {
    act(() => {
      root.render(
        <QuestionCard
          {...baseProps}
          busy={true}
          questions={[{ question: "Q?" }]}
        />
      );
    });
    const buttons = container.querySelectorAll("button[disabled]");
    expect(buttons.length).toBeGreaterThan(0);
  });
});
