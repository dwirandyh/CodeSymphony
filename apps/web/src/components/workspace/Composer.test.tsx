import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@codesymphony/shared-types";
import { Composer } from "./Composer";

function noop() {}

const sampleFileIndex: FileEntry[] = [
  { path: "src/index.ts", type: "file" },
  { path: "src/utils", type: "directory" },
  { path: "src/a.ts", type: "file" },
  { path: "src/b.ts", type: "file" },
  { path: "src/c.ts", type: "file" },
  { path: "src/components.tsx", type: "file" },
];

const defaultProps = {
  value: "",
  disabled: false,
  sending: false,
  showStop: false,
  stopping: false,
  mode: "default" as const,
  worktreeId: "wt-1",
  fileIndex: sampleFileIndex,
  fileIndexLoading: false,
  onChange: noop,
  onModeChange: noop,
  onSubmitMessage: noop,
  onStop: noop,
};

describe("Composer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    vi.useRealTimers();
  });

  function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
    act(() => {
      root.render(<Composer {...defaultProps} {...overrides} />);
    });
  }

  function getEditor(): HTMLDivElement {
    const el = container.querySelector<HTMLDivElement>('[role="textbox"]');
    if (!el) throw new Error("Editor not found");
    return el;
  }

  function typeInEditor(editor: HTMLDivElement, text: string) {
    act(() => {
      editor.textContent = text;
      const textNode = editor.childNodes[0];
      if (textNode) {
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(textNode, text.length);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders the editor", () => {
    renderComposer();
    const editor = getEditor();
    expect(editor).toBeDefined();
    expect(editor.getAttribute("contenteditable")).not.toBe("false");
  });

  it("shows suggestions immediately when @ is typed", () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "@");

    // rAF triggers mention detection
    act(() => {
      vi.advanceTimersByTime(20);
    });

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("shows no suggestions when worktreeId is null (empty fileIndex)", () => {
    renderComposer({ worktreeId: null, fileIndex: [], fileIndexLoading: false });
    const editor = getEditor();

    typeInEditor(editor, "@");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBe(0);
  });

  it("performs fuzzy matching on query", () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "@idx");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    const buttons = container.querySelectorAll("button[data-index]");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts.some((t) => t?.includes("index.ts"))).toBe(true);
  });

  it("renders suggestion popover when results are available", () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@src");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("navigates suggestions with ArrowDown/ArrowUp", () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    // Initially first item selected
    let selectedBtn = container.querySelector('button[data-index="0"]');
    expect(selectedBtn?.className).toContain("bg-accent");

    // Press ArrowDown
    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    selectedBtn = container.querySelector('button[data-index="1"]');
    expect(selectedBtn?.className).toContain("bg-accent");

    // Press ArrowUp
    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });

    selectedBtn = container.querySelector('button[data-index="0"]');
    expect(selectedBtn?.className).toContain("bg-accent");
  });

  it("closes suggestions on Escape", () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    expect(container.querySelectorAll("button[data-index]").length).toBeGreaterThan(0);

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelectorAll("button[data-index]").length).toBe(0);
  });

  it("submits message on Enter when no mention is active", () => {
    const onSubmitMessage = vi.fn();
    renderComposer({ onSubmitMessage, value: "hello" });
    const editor = getEditor();
    typeInEditor(editor, "hello");

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalled();
  });

  it("toggles mode on Shift+Tab", () => {
    const onModeChange = vi.fn();
    renderComposer({ onModeChange });
    const editor = getEditor();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });

    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("shows loading indicator when file index is loading", () => {
    renderComposer({ fileIndex: [], fileIndexLoading: true });
    const editor = getEditor();
    typeInEditor(editor, "@");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    const loadingText = container.querySelector(".text-muted-foreground");
    expect(loadingText?.textContent).toContain("Loading files...");
  });

  it("filters out already-mentioned files from suggestions", () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    act(() => {
      vi.advanceTimersByTime(20);
    });

    // Select first suggestion via Enter
    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // Instead of typeInEditor (which destroys chips by overwriting textContent),
    // append a text node with "@" so the chip remains intact
    act(() => {
      const atNode = document.createTextNode("@");
      editor.appendChild(atNode);

      const sel = window.getSelection()!;
      const range = document.createRange();
      range.setStart(atNode, 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });

    act(() => {
      vi.advanceTimersByTime(20);
    });

    // The selected file should be filtered out
    const buttons = container.querySelectorAll("button[data-index]");
    // We should have fewer suggestions than original (one was filtered)
    expect(buttons.length).toBeLessThan(sampleFileIndex.length);
  });
});
