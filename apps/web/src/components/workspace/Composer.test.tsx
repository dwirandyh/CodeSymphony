import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableCommand, FileEntry } from "@codesymphony/shared-types";
import { Composer } from "./composer";

const sampleFileIndex: FileEntry[] = [
  { path: "src/index.ts", type: "file" },
  { path: "src/utils", type: "directory" },
  { path: "src/a.ts", type: "file" },
  { path: "src/b.ts", type: "file" },
  { path: "src/c.ts", type: "file" },
  { path: "src/components.tsx", type: "file" },
];

const sampleCommands: AvailableCommand[] = [
  { name: "commit", description: "Create a git commit", input: { hint: "-m 'msg'" } },
  { name: "review-pr", description: "Review the current PR" },
];

const defaultProps = {
  disabled: false,
  sending: false,
  showStop: false,
  stopping: false,
  threadId: "thread-1",
  worktreeId: "wt-1",
  fileIndex: sampleFileIndex,
  fileIndexLoading: false,
  providers: [],
  availableCommands: sampleCommands,
  hasMessages: false,
  onSubmitMessage: vi.fn().mockResolvedValue(true),
  onStop: vi.fn(),
  onSelectProvider: vi.fn(),
};

describe("Composer", () => {
  let container: HTMLDivElement;
  let root: Root;

  function setMobileViewport(isMobile: boolean) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 767px)" ? isMobile : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    setMobileViewport(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
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

  function getModelSelectorButton(): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const modelButton = buttons.find((button) => button.textContent?.trim() === "CLI");
    if (!modelButton) {
      throw new Error("Model selector button not found");
    }
    return modelButton;
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

  /** Flush queueMicrotask callbacks and pending React state updates. */
  async function flushMicrotasks() {
    await act(async () => {});
  }

  function dispatchPasteWithText(editor: HTMLDivElement, text: string) {
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
      configurable: true,
    });
    editor.dispatchEvent(pasteEvent);
  }

  it("renders the editor", () => {
    renderComposer();
    const editor = getEditor();
    expect(editor).toBeDefined();
    expect(editor.getAttribute("contenteditable")).not.toBe("false");
  });

  it("applies responsive max-height with internal scroll", () => {
    renderComposer();
    const editor = getEditor();
    expect(editor.className).toContain("overflow-y-auto");
    expect(editor.className).toContain("max-h-[140px]");
    expect(editor.className).toContain("md:max-h-[400px]");
  });

  it("shows suggestions immediately when @ is typed", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "@");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("shows slash command suggestions when / is typed", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "/");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-slash-index]");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]?.textContent).toContain("/commit");
  });

  it("shows no slash suggestions when no ACP commands are available", async () => {
    renderComposer({ availableCommands: [] });
    const editor = getEditor();

    typeInEditor(editor, "/");
    await flushMicrotasks();

    expect(container.querySelectorAll("button[data-slash-index]").length).toBe(0);
  });

  it("shows no suggestions when worktreeId is null (empty fileIndex)", async () => {
    renderComposer({ worktreeId: null, fileIndex: [], fileIndexLoading: false });
    const editor = getEditor();

    typeInEditor(editor, "@");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBe(0);
  });

  it("performs fuzzy matching on query", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "@idx");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-index]");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts.some((t) => t?.includes("index.ts"))).toBe(true);
  });

  it("renders suggestion popover when results are available", async () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@src");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("navigates suggestions with ArrowDown/ArrowUp", async () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");
    await flushMicrotasks();

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
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");
    await flushMicrotasks();

    expect(container.querySelectorAll("button[data-index]").length).toBeGreaterThan(0);

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelectorAll("button[data-index]").length).toBe(0);
  });

  it("inserts slash command selection via Enter", async () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "/");
    await flushMicrotasks();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushMicrotasks();

    expect(editor.textContent).toContain("/commit -m 'msg'");
  });

  it("submits message on Enter when no mention is active", async () => {
    setMobileViewport(false);
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });
    const editor = getEditor();
    typeInEditor(editor, "hello");
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledWith({
      content: "hello",
      mode: "default",
      attachments: [],
    });
  });

  it("does not submit on Enter in mobile viewport", async () => {
    setMobileViewport(true);
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });
    const editor = getEditor();
    typeInEditor(editor, "hello");
    await flushMicrotasks();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("toggles mode on Shift+Tab", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });
    const editor = getEditor();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });

    typeInEditor(editor, "plan this");
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledWith({
      content: "plan this",
      mode: "plan",
      attachments: [],
    });
  });

  it("shows loading indicator when file index is loading", async () => {
    renderComposer({ fileIndex: [], fileIndexLoading: true });
    const editor = getEditor();
    typeInEditor(editor, "@");
    await flushMicrotasks();

    const loadingText = container.querySelector(".text-muted-foreground");
    expect(loadingText?.textContent).toContain("Loading files...");
  });

  it("keeps model selector next to send button in right action row", () => {
    renderComposer();

    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    if (!sendButton) {
      throw new Error("Send button not found");
    }

    const modelButton = getModelSelectorButton();
    const rightActionRow = sendButton.closest("div");
    expect(rightActionRow).not.toBeNull();
    expect(rightActionRow?.className).toContain("bottom-2 right-2.5");
    expect(rightActionRow?.contains(modelButton)).toBe(true);
  });

  it("locks model selector when thread already has messages", () => {
    renderComposer({ hasMessages: true });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.title).toContain("Model is locked for this thread");
  });

  it("filters out already-mentioned files from suggestions", async () => {
    renderComposer();
    const editor = getEditor();
    typeInEditor(editor, "@");
    await flushMicrotasks();

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
    await flushMicrotasks();

    // The selected file should be filtered out
    const buttons = container.querySelectorAll("button[data-index]");
    // We should have fewer suggestions than original (one was filtered)
    expect(buttons.length).toBeLessThan(sampleFileIndex.length);
  });

  it("syncs value during composition (button state updates)", async () => {
    renderComposer();
    const editor = getEditor();

    act(() => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });

    act(() => {
      editor.textContent = "hello";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushMicrotasks();

    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(false);
  });

  it("detects mentions during composition (mobile keyboard)", async () => {
    renderComposer();
    const editor = getEditor();

    // Start composition (simulates mobile soft keyboard predictive text)
    act(() => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });

    // Type "@" during composition — mention detection should still work
    act(() => {
      editor.textContent = "@";
      const textNode = editor.childNodes[0];
      if (textNode) {
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.setStart(textNode, 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushMicrotasks();

    // Mention popover should appear even during composition
    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("submits pasted attachment from local composer state", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });

    const editor = getEditor();
    const longText = "x".repeat(400);

    act(() => {
      dispatchPasteWithText(editor, longText);
    });
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const [payload] = onSubmitMessage.mock.calls[0] as [{
      content: string;
      mode: string;
      attachments: Array<{ source: string; content: string }>;
    }];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].source).toBe("clipboard_text");
    expect(payload.attachments[0].content).toBe(longText);
  });

  it("resets local draft when thread changes", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage, threadId: "thread-1" });
    const editor = getEditor();

    typeInEditor(editor, "hello");
    await flushMicrotasks();
    expect(editor.textContent).toBe("hello");

    renderComposer({ onSubmitMessage, threadId: "thread-2" });
    await flushMicrotasks();

    expect(editor.textContent).toBe("");
  });

  it("keeps draft when submit fails", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(false);
    renderComposer({ onSubmitMessage });
    const editor = getEditor();

    typeInEditor(editor, "hello");
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(editor.textContent).toBe("hello");
  });
});
