import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, ModelProvider, SlashCommand } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { Composer } from "./composer";
import { getPlainTextFromEditor } from "./composer/composerEditorUtils";

const tauriDragDropState = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: { type: string; paths?: string[] } }) => void | Promise<void>),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async (handler: (event: { payload: { type: string; paths?: string[] } }) => void | Promise<void>) => {
      tauriDragDropState.handler = handler;
      return () => {
        tauriDragDropState.handler = null;
      };
    }),
  }),
}));

const sampleFileIndex: FileEntry[] = [
  { path: "src/index.ts", type: "file" },
  { path: "src/utils", type: "directory" },
  { path: "src/a.ts", type: "file" },
  { path: "src/b.ts", type: "file" },
  { path: "src/c.ts", type: "file" },
  { path: "src/components.tsx", type: "file" },
];

const sampleSlashCommands: SlashCommand[] = [
  { name: "commit", description: "Create a commit", argumentHint: "" },
  { name: "review-pr", description: "Review a pull request", argumentHint: "<number>" },
  { name: "simplify", description: "Review changed code for simplification", argumentHint: "" },
];

const defaultProps = {
  disabled: false,
  sending: false,
  showStop: false,
  stopping: false,
  threadId: "thread-1",
  worktreeId: "wt-1",
  mode: "default" as const,
  modeLocked: false,
  fileIndex: sampleFileIndex,
  fileIndexLoading: false,
  slashCommands: sampleSlashCommands,
  slashCommandsLoading: false,
  providers: [],
  agent: "claude" as const,
  model: "claude-sonnet-4-6",
  modelProviderId: null,
  permissionMode: "default" as const,
  hasMessages: false,
  onSubmitMessage: vi.fn().mockResolvedValue(true),
  onModeChange: vi.fn(),
  onStop: vi.fn(),
  onAgentSelectionChange: vi.fn(),
  onPermissionModeChange: vi.fn(),
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
    tauriDragDropState.handler = null;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    const modelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Select CLI agent and model"]');
    if (!modelButton) {
      throw new Error("Model selector button not found");
    }
    return modelButton;
  }

  function getPermissionSelectorButton(): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const permissionButton = buttons.find((button) => button.textContent?.trim() === "Default");
    if (!permissionButton) {
      throw new Error("Permission selector button not found");
    }
    return permissionButton;
  }

  function getPermissionOptionButton(label: string): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const optionButton = buttons.find((button) => button.getAttribute("aria-label")?.startsWith(label));
    if (!optionButton) {
      throw new Error(`${label} option not found`);
    }
    return optionButton;
  }

  function getButtonByExactText(label: string): HTMLButtonElement {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const button = buttons.find((entry) => entry.textContent?.trim() === label);
    if (!button) {
      throw new Error(`${label} button not found`);
    }
    return button;
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

  it("shows slash commands immediately when / is typed", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "/");
    await flushMicrotasks();

    const buttons = container.querySelectorAll("button[data-index]");
    expect(buttons.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Create a commit");
  });

  it("shows Codex skill suggestions when the active agent is codex", async () => {
    renderComposer({
      agent: "codex",
      slashCommands: [
        { name: "dogfood", description: "QA a web app", argumentHint: "" },
        { name: "Excel", description: "Spreadsheet work", argumentHint: "" },
      ],
    });
    const editor = getEditor();

    typeInEditor(editor, "/");
    await flushMicrotasks();

    const texts = Array.from(container.querySelectorAll("button[data-index]")).map((button) => button.textContent);
    expect(texts.some((text) => text?.includes("dogfood"))).toBe(true);
    expect(texts.some((text) => text?.includes("Spreadsheet work"))).toBe(true);
  });

  it("closes slash command suggestions on outside click without changing the draft", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "/");
    await flushMicrotasks();

    expect(container.textContent).toContain("Create a commit");

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flushMicrotasks();

    expect(container.textContent).not.toContain("Create a commit");
    expect(getPlainTextFromEditor(editor)).toBe("/");
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

  it("filters slash commands by query", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "/rev");
    await flushMicrotasks();

    const texts = Array.from(container.querySelectorAll("button[data-index]")).map((button) => button.textContent);
    expect(texts.some((text) => text?.includes("review-pr"))).toBe(true);
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

  it("submits message on Enter when no mention is active", async () => {
    setMobileViewport(false);
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage, mode: "plan" });
    const editor = getEditor();
    typeInEditor(editor, "hello");
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledWith({
      content: "hello",
      mode: "plan",
      attachments: [],
    });
  });

  it("inserts selected slash command with Enter and submits as plain text", async () => {
    setMobileViewport(false);
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });
    const editor = getEditor();

    typeInEditor(editor, "/com");
    await flushMicrotasks();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(editor.querySelector("[data-slash-command=\"commit\"]")).toBeTruthy();
    expect(getPlainTextFromEditor(editor).replace(/\u00A0/g, " ")).toContain("/commit");

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledWith({
      content: "/commit",
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
    const onModeChange = vi.fn();
    renderComposer({ onModeChange });
    const editor = getEditor();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });

    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("ignores mode changes when locked", async () => {
    const onModeChange = vi.fn();
    renderComposer({ modeLocked: true, onModeChange });
    const editor = getEditor();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });

    expect(onModeChange).not.toHaveBeenCalled();
    const toggleButton = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to plan mode"]');
    expect(toggleButton?.disabled).toBe(true);
  });

  it("shows loading indicator when file index is loading", async () => {
    renderComposer({ fileIndex: [], fileIndexLoading: true });
    const editor = getEditor();
    typeInEditor(editor, "@");
    await flushMicrotasks();

    const loadingText = container.querySelector(".text-muted-foreground");
    expect(loadingText?.textContent).toContain("Loading files...");
  });

  it("shows loading indicator when slash commands are loading", async () => {
    renderComposer({ slashCommands: [], slashCommandsLoading: true });
    const editor = getEditor();
    typeInEditor(editor, "/");
    await flushMicrotasks();

    expect(container.textContent).toContain("Loading commands...");
  });

  it("keeps model selector next to the mode toggle in the left action row", () => {
    renderComposer();

    const modeToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to plan mode"]');
    if (!modeToggle) {
      throw new Error("Mode toggle not found");
    }

    const modelButton = getModelSelectorButton();
    const leftActionRow = modeToggle.closest("div");
    expect(leftActionRow).not.toBeNull();
    expect(leftActionRow?.className).toContain("bottom-2 left-2.5");
    expect(leftActionRow?.contains(modelButton)).toBe(true);
  });

  it("keeps permission selector next to the model selector in the left action row", () => {
    renderComposer();

    const modeToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to plan mode"]');
    if (!modeToggle) {
      throw new Error("Mode toggle not found");
    }
    const modelButton = getModelSelectorButton();
    const permissionButton = getPermissionSelectorButton();
    const leftActionRow = modeToggle.closest("div");
    expect(leftActionRow).not.toBeNull();
    expect(leftActionRow?.contains(modelButton)).toBe(true);
    expect(leftActionRow?.contains(permissionButton)).toBe(true);
  });

  it("does not show the shift-tab shortcut hint", () => {
    renderComposer();

    expect(container.textContent).not.toContain("Shift+Tab");
  });

  it("locks model selector when thread already has messages", () => {
    renderComposer({ hasMessages: true });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.title).toContain("CLI agent is locked for this thread");
  });

  it("shows Claude and Codex icons with a compact desktop agent list", () => {
    renderComposer();

    const modelButton = getModelSelectorButton();
    expect(modelButton.textContent).toContain("Claude · Sonnet 4.6");

    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('svg[data-agent-icon="claude"]')).not.toBeNull();
    expect(container.querySelector('svg[data-agent-icon="codex"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-model-panel="overlay"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-model-panel="stacked"]')).toBeNull();
    expect(container.textContent).not.toContain("CLI Agent");
    expect(container.textContent).not.toContain("Claude Models");
    expect(container.textContent).not.toContain("Codex Models");

    const agentList = container.querySelector('[data-cli-agent-list="true"]');
    expect(agentList?.querySelectorAll("button")).toHaveLength(2);
  });

  it("shows agent-specific model options and emits thread agent selection updates", () => {
    const onAgentSelectionChange = vi.fn();
    const providers: ModelProvider[] = [
      {
        id: "provider-codex-1",
        agent: "codex",
        name: "Team Codex",
        modelId: "gpt-5.3-codex-enterprise",
        baseUrl: null,
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderComposer({
      providers,
      onAgentSelectionChange,
    });

    const modelButton = getModelSelectorButton();
    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const codexButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Codex"));
    if (!codexButton) {
      throw new Error("Codex agent button not found");
    }

    act(() => {
      codexButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    const customModelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("GPT-5.3 Codex Enterprise") && button.textContent?.includes("Team Codex"));
    if (!customModelButton) {
      throw new Error("Custom Codex model button not found");
    }
    expect(container.querySelector('[data-model-separator="custom"]')).not.toBeNull();

    act(() => {
      customModelButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onAgentSelectionChange).toHaveBeenCalledWith({
      agent: "codex",
      model: "gpt-5.3-codex-enterprise",
      modelProviderId: "provider-codex-1",
    });
  });

  it("switches the model preview list when hovering between CLI agents", () => {
    const providers: ModelProvider[] = [
      {
        id: "provider-claude-1",
        agent: "claude",
        name: "z.ai",
        modelId: "glm-4.7",
        baseUrl: null,
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "provider-codex-1",
        agent: "codex",
        name: "OpenAI QA",
        modelId: "gpt-5.4-custom",
        baseUrl: null,
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderComposer({
      providers,
      agent: "codex",
      model: "gpt-5.4",
    });

    const modelButton = getModelSelectorButton();
    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("GPT-5.4 Custom");
    expect(container.textContent).not.toContain("GLM-4.7");

    const claudeButton = getButtonByExactText("Claude");
    act(() => {
      claudeButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(container.textContent).toContain("Sonnet 4.6");
    expect(container.textContent).toContain("GLM-4.7");
    expect(container.textContent).not.toContain("GPT-5.4 Custom");

    const codexButton = getButtonByExactText("Codex");
    act(() => {
      codexButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(container.textContent).toContain("GPT-5.4");
    expect(container.textContent).toContain("GPT-5.4 Custom");
    expect(container.textContent).not.toContain("GLM-4.7");
  });

  it("changes permission mode from the selector", () => {
    const onPermissionModeChange = vi.fn();
    renderComposer({ onPermissionModeChange });

    const permissionButton = getPermissionSelectorButton();
    act(() => {
      permissionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const fullAccessButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Full Access"),
    );
    if (!fullAccessButton) {
      throw new Error("Full Access option not found");
    }

    act(() => {
      fullAccessButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onPermissionModeChange).toHaveBeenCalledWith("full_access");
  });

  it("shows permission icons and only reveals descriptions on hover", () => {
    renderComposer();

    const permissionButton = getPermissionSelectorButton();
    expect(permissionButton.querySelector("svg")).not.toBeNull();

    act(() => {
      permissionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const defaultOption = getPermissionOptionButton("Default");
    const fullAccessOption = getPermissionOptionButton("Full Access");

    expect(defaultOption.querySelector("svg")).not.toBeNull();
    expect(fullAccessOption.querySelector("svg")).not.toBeNull();
    expect(container.textContent).not.toContain("Ask before approval-gated actions");
    expect(container.textContent).not.toContain("Always allow approval-gated actions");

    act(() => {
      fullAccessOption.focus();
    });

    expect(container.textContent).toContain("Always allow approval-gated actions");
    expect(container.textContent).not.toContain("Ask before approval-gated actions");
  });

  it("shows inline permission descriptions on mobile", () => {
    setMobileViewport(true);
    renderComposer();

    const permissionButton = getPermissionSelectorButton();
    act(() => {
      permissionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Ask before approval-gated actions");
    expect(container.textContent).toContain("Always allow approval-gated actions");
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

  it("does not show slash command suggestions inside another token", async () => {
    renderComposer();
    const editor = getEditor();

    typeInEditor(editor, "foo/bar");
    await flushMicrotasks();

    expect(container.querySelectorAll("button[data-index]").length).toBe(0);
  });

  it("submits pasted attachment from local composer state", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });

    const editor = getEditor();
    const longText = "alpha\nbeta\ngamma\n".repeat(120);

    act(() => {
      dispatchPasteWithText(editor, longText);
    });
    await flushMicrotasks();

    expect(editor.textContent).toContain("Paste text 360 lines");

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

  it("handles native Tauri drag/drop attachments in desktop mode", async () => {
    vi.spyOn(api, "readLocalAttachments").mockResolvedValue([{
      path: "/tmp/dropped.txt",
      filename: "dropped.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      content: "hello world",
    }]);
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    renderComposer();
    await flushMicrotasks();

    expect(tauriDragDropState.handler).toBeTypeOf("function");

    await act(async () => {
      await tauriDragDropState.handler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/dropped.txt"],
        },
      });
    });
    await flushMicrotasks();

    expect(api.readLocalAttachments).toHaveBeenCalledWith(["/tmp/dropped.txt"]);
    expect(container.textContent).toContain("dropped.txt");
  });

  it("opens pasted text chip details from the composer before sending", async () => {
    renderComposer();

    const editor = getEditor();
    const longText = "first line\nsecond line\nthird line\n".repeat(120);

    act(() => {
      dispatchPasteWithText(editor, longText);
    });
    await flushMicrotasks();

    const attachmentChip = editor.querySelector("[data-attachment-id]") as HTMLElement | null;
    expect(attachmentChip).toBeTruthy();
    expect(editor.textContent).toContain("Paste text 360 lines");

    act(() => {
      attachmentChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Paste text 360 lines");
    expect(document.body.textContent).toContain("first line");
    expect(document.body.textContent).toContain("pasted-");
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
