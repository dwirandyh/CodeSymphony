import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@codesymphony/shared-types";
import { Composer } from "./Composer";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    searchFiles: vi.fn(),
  },
}));

function noop() {}

const defaultProps = {
  value: "",
  disabled: false,
  sending: false,
  showStop: false,
  stopping: false,
  mode: "default" as const,
  worktreeId: "wt-1",
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
    vi.mocked(api.searchFiles).mockReset();
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

  it("triggers mention search on @ input", async () => {
    const fileResults: FileEntry[] = [
      { path: "src/index.ts", type: "file" },
      { path: "src/utils", type: "directory" },
    ];
    vi.mocked(api.searchFiles).mockResolvedValue(fileResults);

    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "@");

    // Advance past debounce (150ms) and rAF
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    expect(api.searchFiles).toHaveBeenCalledWith("wt-1", "", expect.any(AbortSignal));
  });

  it("does not search when worktreeId is null", async () => {
    renderComposer({ worktreeId: null });
    const editor = getEditor();

    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    expect(api.searchFiles).not.toHaveBeenCalled();
  });

  it("passes AbortSignal to searchFiles", async () => {
    vi.mocked(api.searchFiles).mockResolvedValue([]);

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@s");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    const call = vi.mocked(api.searchFiles).mock.calls[0];
    expect(call).toBeDefined();
    expect(call[2]).toBeInstanceOf(AbortSignal);
  });

  it("aborts previous request when query changes", async () => {
    let resolvers: Array<(value: FileEntry[]) => void> = [];
    vi.mocked(api.searchFiles).mockImplementation(
      () =>
        new Promise<FileEntry[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    renderComposer();
    const editor = getEditor();

    // Type first query
    typeInEditor(editor, "@a");
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    const firstSignal = vi.mocked(api.searchFiles).mock.calls[0]?.[2] as AbortSignal;

    // Type second query (triggers cleanup of first effect)
    typeInEditor(editor, "@ab");
    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    // The first request's signal should be aborted
    expect(firstSignal.aborted).toBe(true);
  });

  it("renders suggestion popover when results are available", async () => {
    const fileResults: FileEntry[] = [
      { path: "src/index.ts", type: "file" },
      { path: "src/utils", type: "directory" },
    ];
    vi.mocked(api.searchFiles).mockResolvedValue(fileResults);

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("src/index.ts");
    expect(buttons[1].textContent).toContain("src/utils");
  });

  it("navigates suggestions with ArrowDown/ArrowUp", async () => {
    const fileResults: FileEntry[] = [
      { path: "src/a.ts", type: "file" },
      { path: "src/b.ts", type: "file" },
      { path: "src/c.ts", type: "file" },
    ];
    vi.mocked(api.searchFiles).mockResolvedValue(fileResults);

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
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

  it("closes suggestions on Escape", async () => {
    vi.mocked(api.searchFiles).mockResolvedValue([
      { path: "src/a.ts", type: "file" },
    ]);

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    expect(container.querySelectorAll("button[data-index]").length).toBe(1);

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

  it("shows loading indicator while fetching suggestions", async () => {
    vi.mocked(api.searchFiles).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    const loadingText = container.querySelector(".text-muted-foreground");
    expect(loadingText?.textContent).toContain("Searching files...");
  });

  it("filters out already-mentioned files from suggestions", async () => {
    // First search returns two files
    vi.mocked(api.searchFiles).mockResolvedValue([
      { path: "src/a.ts", type: "file" },
      { path: "src/b.ts", type: "file" },
    ]);

    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    // Select first suggestion (src/a.ts) via Enter
    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // Now type @ again to trigger new search
    // The editor now has a chip + text, append @
    const currentText = editor.textContent ?? "";
    typeInEditor(editor, currentText + "@");

    vi.mocked(api.searchFiles).mockResolvedValue([
      { path: "src/a.ts", type: "file" },
      { path: "src/b.ts", type: "file" },
    ]);

    await act(async () => {
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();
    });

    // src/a.ts should be filtered out since it's already mentioned
    const buttons = container.querySelectorAll("button[data-index]");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts).not.toContain(expect.stringContaining("src/a.ts"));
  });
});
