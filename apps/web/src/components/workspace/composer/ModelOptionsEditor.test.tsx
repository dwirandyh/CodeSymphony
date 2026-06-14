import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilities } from "@codesymphony/shared-types";
import { ModelOptionsEditor } from "./ModelOptionsEditor";

function act(callback: () => void): void {
  flushSync(callback);
}

const EFFORT_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Effort",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    },
  ],
};

const TOGGLE_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "fastMode",
      label: "Fast mode",
      type: "toggle",
      currentValue: false,
    },
  ],
};

const EFFORT_AND_FAST_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    ...EFFORT_CAPABILITIES.optionDescriptors,
    {
      id: "fastMode",
      label: "Fast mode",
      type: "toggle",
      currentValue: true,
    },
  ],
};

describe("ModelOptionsEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("renders select options", () => {
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={EFFORT_CAPABILITIES}
          selections={[{ id: "reasoningEffort", value: "high" }]}
          onChange={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Effort");
    expect(container.textContent).toContain("High");
  });

  it("calls onChange when select option clicked", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={EFFORT_CAPABILITIES}
          selections={[{ id: "reasoningEffort", value: "medium" }]}
          onChange={onChange}
        />,
      );
    });

    const buttons = container.querySelectorAll("button");
    const highButton = Array.from(buttons).find((b) => b.textContent === "High");
    expect(highButton).toBeTruthy();
    act(() => {
      highButton!.click();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: "reasoningEffort", value: "high" },
    ]);
  });

  it("emits descriptor defaults for unchanged options when one option changes", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={EFFORT_AND_FAST_CAPABILITIES}
          selections={[]}
          onChange={onChange}
        />,
      );
    });

    const highButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "High");
    expect(highButton).toBeTruthy();
    act(() => {
      highButton!.click();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("renders toggle switch", () => {
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={TOGGLE_CAPABILITIES}
          selections={[{ id: "fastMode", value: false }]}
          onChange={() => {}}
        />,
      );
    });

    expect(container.textContent).toContain("Fast mode");
    const toggle = container.querySelector("[role='switch']");
    expect(toggle).toBeTruthy();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onChange when toggle clicked", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={TOGGLE_CAPABILITIES}
          selections={[{ id: "fastMode", value: false }]}
          onChange={onChange}
        />,
      );
    });

    const toggle = container.querySelector("[role='switch']") as HTMLElement;
    act(() => {
      toggle.click();
    });

    expect(onChange).toHaveBeenCalledWith([
      { id: "fastMode", value: true },
    ]);
  });

  it("renders null for empty capabilities", () => {
    act(() => {
      root.render(
        <ModelOptionsEditor
          capabilities={{ optionDescriptors: [] }}
          selections={[]}
          onChange={() => {}}
        />,
      );
    });

    expect(container.innerHTML).toBe("");
  });
});
