import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueuedMessage, FileEntry, ModelProvider, SlashCommand } from "@codesymphony/shared-types";
import { api } from "../../lib/api";
import { Composer } from "./composer";
import { getPlainTextFromEditor, getSerializedTextFromEditor } from "./composer/composerEditorUtils";

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

const sampleQueuedMessages: ChatQueuedMessage[] = [
  {
    id: "queue-1",
    threadId: "thread-1",
    seq: 0,
    content: "Review pending migrations and send after the current response finishes.",
    mode: "plan",
    status: "dispatch_requested",
    dispatchRequestedAt: "2026-04-27T10:00:00.000Z",
    attachments: [
      {
        id: "queue-attachment-1",
        queuedMessageId: "queue-1",
        filename: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 128,
        content: "content",
        storagePath: null,
        source: "file_picker",
        createdAt: "2026-04-27T10:00:00.000Z",
      },
    ],
    createdAt: "2026-04-27T10:00:00.000Z",
    updatedAt: "2026-04-27T10:00:00.000Z",
  },
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
  opencodeModels: [
    {
      id: "opencode/minimax-m2.5-free",
      name: "MiniMax M2.5 Free",
      providerId: "opencode",
    },
    {
      id: "opencode/ling-2.6-flash-free",
      name: "Ling 2.6 Flash Free",
      providerId: "opencode",
    },
    {
      id: "opencode/nemotron-3-super-free",
      name: "Nemotron 3 Super Free",
      providerId: "opencode",
    },
    {
      id: "zai/glm-4.7-flash",
      name: "GLM-4.7-Flash",
      providerId: "zai",
    },
  ],
  cursorModels: [
    {
      id: "default[]",
      name: "Auto",
    },
    {
      id: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      name: "GPT-5.4",
    },
  ],
  agent: "claude" as const,
  model: "claude-sonnet-4-6",
  modelProviderId: null,
  threadKind: "default" as const,
  threadRunning: false,
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
  let queryClient: QueryClient;

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
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
    setMobileViewport(false);
    tauriDragDropState.handler = null;
    window.localStorage.clear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Composer {...defaultProps} {...overrides} />
        </QueryClientProvider>,
      );
    });
  }

  function getEditor(): HTMLDivElement {
    const el = container.querySelector<HTMLDivElement>('[role="textbox"]');
    if (!el) throw new Error("Editor not found");
    return el;
  }

  function getDragDropTarget(): HTMLDivElement {
    const target = getEditor().parentElement;
    if (!(target instanceof HTMLDivElement)) {
      throw new Error("Composer drag/drop target not found");
    }
    return target;
  }

  function getModelSelectorButton(): HTMLButtonElement {
    const modelButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select CLI agent and model"], button[aria-label^="Select "][aria-label$=" model"]',
    );
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

  function getSessionSettingsButton(): HTMLButtonElement {
    const sessionButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open session settings"]');
    if (!sessionButton) {
      throw new Error("Session settings button not found");
    }
    return sessionButton;
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

  function buildFileDragData(file: File) {
    return {
      types: ["Files"],
      files: [file],
      items: [{
        kind: "file",
        getAsFile: () => file,
      }],
      dropEffect: "none",
    };
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

  it("renders queued drafts inside the composer shell", () => {
    renderComposer({
      queuedMessages: sampleQueuedMessages,
      onDeleteQueuedMessage: vi.fn(),
      onDispatchQueuedMessage: vi.fn(),
      onUpdateQueuedMessage: vi.fn().mockResolvedValue(true),
    });

    const composerSection = getEditor().closest("section");
    expect(composerSection?.textContent).toContain("1 queued draft");
    expect(composerSection?.textContent).toContain("Review pending migrations and send after the current response finishes.");
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

  it("submits message on Ctrl+Enter when configured to require the modifier", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "Linux",
      configurable: true,
    });
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage, sendMessagesWith: "mod_enter" });
    const editor = getEditor();
    typeInEditor(editor, "hello");
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledWith({
      content: "hello",
      mode: "default",
      attachments: [],
    });
  });

  it("does not submit on plain Enter when Ctrl+Enter is required", async () => {
    Object.defineProperty(window.navigator, "platform", {
      value: "Linux",
      configurable: true,
    });
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage, sendMessagesWith: "mod_enter" });
    const editor = getEditor();
    typeInEditor(editor, "hello");
    await flushMicrotasks();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).not.toHaveBeenCalled();
  });

  it("prioritizes Stop run over Queue draft while the current submit is still sending", async () => {
    const onQueueDraft = vi.fn().mockResolvedValue(true);
    renderComposer({ onQueueDraft });
    const editor = getEditor();

    typeInEditor(editor, "hello");
    await flushMicrotasks();

    renderComposer({
      onQueueDraft,
      sending: true,
      showStop: true,
      threadRunning: true,
    });

    expect(container.querySelector('button[aria-label="Stop run"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Queue draft"]')).toBeNull();
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

  it("keeps the built-in model selector active after history and hides agent switching", () => {
    const providers: ModelProvider[] = [
      {
        id: "provider-claude-1",
        agent: "claude",
        name: "Team Claude",
        modelId: "claude-opus-4-6",
        baseUrl: "https://api.example.com/v1",
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderComposer({
      hasMessages: true,
      threadKind: "default",
      providers,
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(false);

    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-cli-agent-list="true"]')).toBeNull();
    expect(container.querySelector('[data-agent-model-panel="single"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-model-panel="overlay"]')).toBeNull();
    expect(container.textContent).toContain("Sonnet 4.6");
    expect(container.textContent).toContain("Opus 4.6");
    expect(container.textContent).not.toContain("Team Claude");
  });

  it("blocks model switching for review threads with history", () => {
    renderComposer({
      hasMessages: true,
      threadKind: "review",
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.title).toContain("Review threads keep their model locked");
  });

  it("blocks provider-backed Claude model switching after the first message", () => {
    const providers: ModelProvider[] = [
      {
        id: "provider-claude-1",
        agent: "claude",
        name: "Anthropic Proxy",
        modelId: "claude-sonnet-4-6",
        baseUrl: "https://api.example.com/v1",
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderComposer({
      hasMessages: true,
      providers,
      modelProviderId: "provider-claude-1",
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.title).toContain("Claude threads using a custom endpoint keep their model locked");
  });

  it("blocks custom-provider model switching after the first message", () => {
    const providers: ModelProvider[] = [
      {
        id: "provider-codex-1",
        agent: "codex",
        name: "Team Codex",
        modelId: "gpt-5.4-enterprise",
        baseUrl: null,
        apiKeyMasked: "",
        isActive: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    renderComposer({
      hasMessages: true,
      agent: "codex",
      model: "gpt-5.4-enterprise",
      modelProviderId: "provider-codex-1",
      providers,
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.title).toContain("Threads using a custom model provider keep their model locked");
  });

  it("shows Claude, Codex, Cursor, and OpenCode icons with a compact desktop agent list", () => {
    renderComposer();

    const modelButton = getModelSelectorButton();
    expect(modelButton.textContent).toContain("Claude · Sonnet 4.6");

    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('svg[data-agent-icon="claude"]')).not.toBeNull();
    expect(container.querySelector('svg[data-agent-icon="codex"]')).not.toBeNull();
    expect(container.querySelector('svg[data-agent-icon="cursor"]')).not.toBeNull();
    const opencodeIcon = container.querySelector('svg[data-agent-icon="opencode"]');
    expect(opencodeIcon).not.toBeNull();
    expect(opencodeIcon?.querySelectorAll("path")).toHaveLength(1);
    expect(opencodeIcon?.querySelector("path")?.getAttribute("d")).toBe("M16 6H8v12h8V6zm4 16H4V2h16v20z");
    expect(container.querySelector('[data-agent-model-panel="overlay"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-model-panel="stacked"]')).toBeNull();
    expect(container.textContent).not.toContain("CLI Agent");
    expect(container.textContent).not.toContain("Claude Models");
    expect(container.textContent).not.toContain("Codex Models");
    expect(container.textContent).not.toContain("Cursor Models");
    expect(container.textContent).not.toContain("OpenCode Models");

    const agentList = container.querySelector('[data-cli-agent-list="true"]');
    expect(agentList?.querySelectorAll("button")).toHaveLength(4);
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

  it("shows the dynamic Codex catalog even when a Codex CLI default model is configured", () => {
    renderComposer({
      agent: "codex",
      model: "gpt-5.4",
      codexModels: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          description: "Strong model for everyday coding",
          hidden: false,
          isDefault: false,
        },
        {
          id: "gpt-5.4-mini",
          name: "GPT-5.4-Mini",
          description: "Small and fast",
          hidden: false,
          isDefault: false,
        },
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier coding model",
          hidden: false,
          isDefault: true,
        },
      ],
      runtimeInfo: {
        pid: 1,
        cwd: "/runtime",
        nodeVersion: "v22.14.0",
        runtimeHost: "0.0.0.0",
        runtimePort: 4331,
        uptimeSec: 1,
        database: {
          urlKind: "file",
          resolvedPath: "/tmp/runtime.db",
          urlPreview: "file:/tmp/runtime.db",
        },
        listenAddress: null,
        codexCliProviderOverride: {
          configPath: "/Users/test/.codex/config.toml",
          providerId: "openai",
          providerName: "OpenAI",
          baseUrl: null,
          model: "gpt-5.4",
          wireApi: "responses",
        },
      },
    });

    const modelButton = getModelSelectorButton();
    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Codex CLI default");
    expect(container.textContent).toContain("GPT-5.4");
    expect(container.textContent).toContain("GPT-5.4-Mini");
    expect(container.textContent).toContain("GPT-5.5");
  });

  it("renders Codex built-in model choices from the dynamic catalog", () => {
    renderComposer({
      agent: "codex",
      model: "gpt-5.5",
      codexModels: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          description: "Frontier coding model",
          hidden: false,
          isDefault: true,
        },
        {
          id: "gpt-5.2",
          name: "GPT-5.2",
          description: "Optimized for professional work",
          hidden: false,
          isDefault: false,
        },
      ],
    });

    const modelButton = getModelSelectorButton();
    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("GPT-5.5");
    expect(container.textContent).toContain("GPT-5.2");
    expect(container.textContent).not.toContain("GPT-5.3 Codex Spark");
  });

  it("clarifies when an existing thread can only switch models for the current agent", () => {
    renderComposer({
      hasMessages: true,
      agent: "codex",
      model: "gpt-5.4-mini",
      modelProviderId: null,
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.getAttribute("aria-label")).toBe("Select Codex model");

    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Models for Codex");
    expect(container.querySelector('[data-cli-agent-list="true"]')).toBeNull();
    expect(container.textContent).not.toContain("Models for Claude");
  });

  it("shows OpenCode model options and emits thread agent selection updates", () => {
    const onAgentSelectionChange = vi.fn();
    const providers: ModelProvider[] = [
      {
        id: "provider-opencode-1",
        agent: "opencode",
        name: "OpenCode QA",
        modelId: "gpt-5-custom",
        baseUrl: "https://api.openai.com/v1",
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

    const opencodeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("OpenCode"));
    if (!opencodeButton) {
      throw new Error("OpenCode agent button not found");
    }

    act(() => {
      opencodeButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    const customModelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("gpt-5-custom") && button.textContent?.includes("OpenCode QA"));
    if (!customModelButton) {
      throw new Error("Custom OpenCode model button not found");
    }
    expect(container.querySelector('[data-model-separator="custom"]')).not.toBeNull();

    act(() => {
      customModelButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onAgentSelectionChange).toHaveBeenCalledWith({
      agent: "opencode",
      model: "gpt-5-custom",
      modelProviderId: "provider-opencode-1",
    });
  });

  it("shows Cursor model options and emits thread agent selection updates", () => {
    const onAgentSelectionChange = vi.fn();

    renderComposer({
      onAgentSelectionChange,
    });

    const modelButton = getModelSelectorButton();
    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const cursorButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Cursor"));
    if (!cursorButton) {
      throw new Error("Cursor agent button not found");
    }

    act(() => {
      cursorButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    const cursorModelButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("GPT-5.4") && button.textContent?.includes("Built-in"));
    if (!cursorModelButton) {
      throw new Error("Cursor model button not found");
    }

    act(() => {
      cursorModelButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onAgentSelectionChange).toHaveBeenCalledWith({
      agent: "cursor",
      model: "gpt-5.4[context=272k,reasoning=medium,fast=false]",
      modelProviderId: null,
    });
  });

  it("switches the model preview list when moving between CLI agents", () => {
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
      {
        id: "provider-opencode-1",
        agent: "opencode",
        name: "OpenCode QA",
        modelId: "gpt-5-custom",
        baseUrl: "https://api.openai.com/v1",
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
      claudeButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.textContent).toContain("Sonnet 4.6");
    expect(container.textContent).toContain("GLM 4.7");
    expect(container.textContent).not.toContain("GPT-5.4 Custom");

    const codexButton = getButtonByExactText("Codex");
    act(() => {
      codexButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.textContent).toContain("GPT-5.4");
    expect(container.textContent).toContain("GPT-5.4 Custom");
    expect(container.textContent).not.toContain("GLM 4.7");

    const cursorButton = getButtonByExactText("Cursor");
    act(() => {
      cursorButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.textContent).toContain("Auto");
    expect(container.textContent).toContain("GPT-5.4");
    expect(container.textContent).not.toContain("GPT-5.4 Custom");

    const opencodeButton = getButtonByExactText("OpenCode");
    act(() => {
      opencodeButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(container.textContent).toContain("MiniMax M2.5 Free");
    expect(container.textContent).toContain("opencode");
    expect(container.textContent).toContain("gpt-5-custom");
    expect(container.textContent).not.toContain("z.ai");
  });

  it("shows OpenCode display names with source labels in the selector", () => {
    renderComposer({
      agent: "opencode",
      model: "opencode/minimax-m2.5-free",
    });

    const modelButton = getModelSelectorButton();
    expect(modelButton.textContent).toContain("OpenCode · MiniMax M2.5 Free");
    expect(modelButton.title).toBe("opencode/minimax-m2.5-free");

    act(() => {
      modelButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("MiniMax M2.5 Free");
    expect(container.textContent).toContain("Ling 2.6 Flash Free");
    expect(container.textContent).toContain("GLM-4.7-Flash");
    expect(container.textContent).toContain("opencode");
    expect(container.textContent).toContain("zai");
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

    const sessionButton = getSessionSettingsButton();
    act(() => {
      sessionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const screenText = document.body.textContent ?? "";
    expect(screenText).toContain("Session settings");
    expect(screenText).toContain("Ask before approval-gated actions");
    expect(screenText).toContain("Always allow approval-gated actions");
  });

  it("collapses model and permission controls into one mobile session button", () => {
    setMobileViewport(true);
    renderComposer({ permissionMode: "full_access" });

    const sessionButton = getSessionSettingsButton();
    expect(sessionButton).not.toBeNull();
    expect(sessionButton?.textContent).toContain("Claude");
    expect(container.querySelector('button[aria-label="Select CLI agent and model"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Full Access")).toBe(false);
  });

  it("keeps mobile session settings accessible when model switching is blocked", () => {
    setMobileViewport(true);
    renderComposer({
      hasMessages: true,
      threadKind: "review",
    });

    const sessionButton = getSessionSettingsButton();
    expect(sessionButton.disabled).toBe(false);

    act(() => {
      sessionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const screenText = document.body.textContent ?? "";
    expect(screenText).toContain("Session settings");
    expect(screenText).toContain("Review threads keep their model locked. Start a new thread to change it.");
    expect(screenText).toContain("Permission mode");
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

  it("preserves newline characters from block nodes in editor serialization", () => {
    renderComposer();
    const editor = getEditor();

    act(() => {
      editor.innerHTML = "<div>first line</div><div>second line</div><div>third line</div>";
    });

    expect(getPlainTextFromEditor(editor)).toBe("first line\nsecond line\nthird line\n");
    expect(getSerializedTextFromEditor(editor)).toBe("first line\nsecond line\nthird line\n");
  });

  it("submits newline-separated content created by contenteditable block nodes", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });

    const editor = getEditor();

    act(() => {
      editor.innerHTML = "<div>first line</div><div>second line</div><div>third line</div>";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushMicrotasks();

    const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
    expect(sendButton?.disabled).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const [payload] = onSubmitMessage.mock.calls[0] as [{
      content: string;
      mode: string;
      attachments: Array<{ source: string; content: string }>;
    }];
    expect(payload.content).toBe("first line\nsecond line\nthird line");
  });

  it("submits pasted attachment from local composer state", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage });

    const editor = getEditor();
    const longText = "alpha\nbeta\ngamma\n".repeat(320);

    act(() => {
      dispatchPasteWithText(editor, longText);
    });
    await flushMicrotasks();

    expect(editor.textContent).toContain("Paste text 960 lines");

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

  it("keeps very long inline text out of attachment conversion when auto-convert is disabled", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({
      onSubmitMessage,
      autoConvertLongTextEnabled: false,
    });

    const editor = getEditor();
    const longText = "alpha\nbeta\ngamma\n".repeat(320);

    typeInEditor(editor, longText);
    await flushMicrotasks();

    expect(editor.querySelector("[data-attachment-id]")).toBeNull();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const [payload] = onSubmitMessage.mock.calls[0] as [{
      content: string;
      attachments: Array<{ source: string }>;
    }];
    expect(payload.attachments).toHaveLength(0);
    expect(payload.content).toContain("alpha");
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
    await vi.dynamicImportSettled();
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

  it("falls back to DOM drag/drop attachments in desktop mode when native drop handling does not arrive", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    renderComposer();
    await vi.dynamicImportSettled();
    await flushMicrotasks();

    const dropTarget = getDragDropTarget();
    const file = new File(["desktop fallback"], "desktop-fallback.txt", { type: "text/plain" });
    const dragData = buildFileDragData(file);
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", { value: dragData, configurable: true });

    act(() => {
      dropTarget.dispatchEvent(dropEvent);
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    });
    await flushMicrotasks();

    expect(container.textContent).toContain("desktop-fallback.txt");
  });

  it("does not duplicate desktop drag/drop attachments when native Tauri handling succeeds", async () => {
    vi.useFakeTimers();
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    vi.spyOn(api, "readLocalAttachments").mockResolvedValue([{
      path: "/tmp/desktop-native.txt",
      filename: "desktop-native.txt",
      mimeType: "text/plain",
      sizeBytes: 14,
      content: "desktop native",
    }]);
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    renderComposer({ onSubmitMessage });
    await vi.dynamicImportSettled();
    await flushMicrotasks();

    const dropTarget = getDragDropTarget();
    const editor = getEditor();
    const file = new File(["desktop native"], "desktop-native.txt", { type: "text/plain" });
    const dragData = buildFileDragData(file);
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", { value: dragData, configurable: true });

    act(() => {
      dropTarget.dispatchEvent(dropEvent);
    });

    await act(async () => {
      await tauriDragDropState.handler?.({
        payload: {
          type: "drop",
          paths: ["/tmp/desktop-native.txt"],
        },
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(151);
    });
    await flushMicrotasks();

    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    const [payload] = onSubmitMessage.mock.calls[0] as [{
      attachments: Array<{ filename: string }>;
    }];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]?.filename).toBe("desktop-native.txt");
  });

  it("handles browser drag/drop image attachments in the composer", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:dropped-image");

    try {
      renderComposer();
      const editor = getEditor();
      const dropTarget = getDragDropTarget();
      const imageFile = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });
      const dragData = buildFileDragData(imageFile);

      const dragEnterEvent = new Event("dragenter", { bubbles: true, cancelable: true });
      Object.defineProperty(dragEnterEvent, "dataTransfer", { value: dragData, configurable: true });

      act(() => {
        dropTarget.dispatchEvent(dragEnterEvent);
      });

      expect(container.textContent).toContain("Drop files here");

      const dragLeaveEvent = new Event("dragleave", { bubbles: true, cancelable: true });
      Object.defineProperty(dragLeaveEvent, "dataTransfer", { value: dragData, configurable: true });
      Object.defineProperty(dragLeaveEvent, "relatedTarget", { value: editor, configurable: true });

      act(() => {
        dropTarget.dispatchEvent(dragLeaveEvent);
      });

      expect(container.textContent).toContain("Drop files here");

      const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, "dataTransfer", { value: dragData, configurable: true });

      await act(async () => {
        dropTarget.dispatchEvent(dropEvent);
      });
      await flushMicrotasks();

      expect(container.textContent).not.toContain("Drop files here");
      expect(container.textContent).toContain("dropped.png");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  it("opens pasted text chip details from the composer before sending", async () => {
    renderComposer();

    const editor = getEditor();
    const longText = "first line\nsecond line\nthird line\n".repeat(320);

    act(() => {
      dispatchPasteWithText(editor, longText);
    });
    await flushMicrotasks();

    const attachmentChip = editor.querySelector("[data-attachment-id]") as HTMLElement | null;
    expect(attachmentChip).toBeTruthy();
    expect(editor.textContent).toContain("Paste text 960 lines");

    act(() => {
      attachmentChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Paste text 960 lines");
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

  it("restores the persisted draft after remounting the same thread", async () => {
    renderComposer({ threadId: "thread-1", worktreeId: "wt-1" });

    typeInEditor(getEditor(), "persist me");
    await flushMicrotasks();

    act(() => root.unmount());
    root = createRoot(container);

    renderComposer({ threadId: "thread-1", worktreeId: "wt-1" });
    await flushMicrotasks();

    expect(getEditor().textContent).toBe("persist me");
  });

  it("keeps drafts isolated between threads", async () => {
    renderComposer({ threadId: "thread-1", worktreeId: "wt-1" });
    typeInEditor(getEditor(), "draft thread 1");
    await flushMicrotasks();

    renderComposer({ threadId: "thread-2", worktreeId: "wt-1" });
    await flushMicrotasks();
    expect(getEditor().textContent).toBe("");

    typeInEditor(getEditor(), "draft thread 2");
    await flushMicrotasks();

    renderComposer({ threadId: "thread-1", worktreeId: "wt-1" });
    await flushMicrotasks();
    expect(getEditor().textContent).toBe("draft thread 1");

    renderComposer({ threadId: "thread-2", worktreeId: "wt-1" });
    await flushMicrotasks();
    expect(getEditor().textContent).toBe("draft thread 2");
  });

  it("clears the persisted draft after a successful submit", async () => {
    const onSubmitMessage = vi.fn().mockResolvedValue(true);
    renderComposer({ onSubmitMessage, threadId: "thread-1", worktreeId: "wt-1" });

    typeInEditor(getEditor(), "submit and clear");
    await flushMicrotasks();

    await act(async () => {
      getEditor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    act(() => root.unmount());
    root = createRoot(container);

    renderComposer({ onSubmitMessage, threadId: "thread-1", worktreeId: "wt-1" });
    await flushMicrotasks();

    expect(getEditor().textContent).toBe("");
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
