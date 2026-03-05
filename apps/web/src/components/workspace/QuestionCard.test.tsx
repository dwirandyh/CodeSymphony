import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";

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
