import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatEvent, ChatMessage, ChatThread, Repository } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { WorkspacePage } from "./WorkspacePage";
import { api } from "../lib/api";
import { logService } from "../lib/logService";

vi.mock("../lib/api", () => ({
  api: {
    pickDirectory: vi.fn(),
    listRepositories: vi.fn(),
    getRepository: vi.fn(),
    createRepository: vi.fn(),
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
    getWorktree: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    getThread: vi.fn(),
    deleteThread: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    stopRun: vi.fn(),
    answerQuestion: vi.fn(),
    resolvePermission: vi.fn(),
    approvePlan: vi.fn(),
    revisePlan: vi.fn(),
    listEvents: vi.fn(),
    searchFiles: vi.fn(),
    openWorktreeFile: vi.fn(),
    getGitStatus: vi.fn(),
    gitCommit: vi.fn(),
    getGitDiff: vi.fn(),
    runtimeBaseUrl: "http://127.0.0.1:4321",
  },
}));

vi.mock("../components/workspace/BottomPanel", () => ({
  BottomPanel: () => {
    const enabled =
      typeof window !== "undefined" && window.localStorage.getItem("cs.debug.render") === "1";
    return enabled ? <div data-testid="render-debug-panel">Instrumentation</div> : null;
  },
}));

const repositoryFixture: Repository[] = [
  {
    id: "repo-1",
    name: "alpha",
    rootPath: "/tmp/alpha",
    defaultBranch: "main",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    worktrees: [
      {
        id: "wt-1",
        repositoryId: "repo-1",
        branch: "feature/ui",
        path: "/tmp/alpha/.worktrees/feature-ui",
        baseBranch: "main",
        status: "active",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ],
  },
];

const repositoryFixtureMultiExpand: Repository[] = [
  ...repositoryFixture,
  {
    id: "repo-2",
    name: "beta",
    rootPath: "/tmp/beta",
    defaultBranch: "main",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
    worktrees: [
      {
        id: "wt-2",
        repositoryId: "repo-2",
        branch: "feature/api",
        path: "/tmp/beta/.worktrees/feature-api",
        baseBranch: "main",
        status: "active",
        createdAt: "2026-01-01T10:00:00.000Z",
        updatedAt: "2026-01-01T10:00:00.000Z",
      },
    ],
  },
];

const threadFixture: ChatThread[] = [
  {
    id: "thread-1",
    worktreeId: "wt-1",
    title: "Main Thread",
    claudeSessionId: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
  },
];

const threadFixtureWithSecondary: ChatThread[] = [
  ...threadFixture,
  {
    id: "thread-2",
    worktreeId: "wt-1",
    title: "Thread 2",
    claudeSessionId: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-01T10:00:00.000Z",
  },
];

const messageFixture: ChatMessage[] = [
  {
    id: "msg-1",
    threadId: "thread-1",
    seq: 0,
    role: "assistant",
    content: "Initial response",
    createdAt: "2026-01-01T10:00:00.000Z",
  },
];

const eventFixture: ChatEvent[] = [
  {
    id: "evt-1",
    threadId: "thread-1",
    idx: 2,
    type: "tool.output",
    payload: { command: "git status" },
    createdAt: "2026-01-01T10:00:00.000Z",
  },
];

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readonly url: string;
  readyState = 1;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const normalizedListener: EventListener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
    const listenersByType = this.listeners.get(type) ?? new Set<EventListener>();
    listenersByType.add(normalizedListener);
    this.listeners.set(type, listenersByType);
  }

  emit(type: string, payload: ChatEvent) {
    const listenersByType = this.listeners.get(type);
    if (!listenersByType || listenersByType.size === 0) {
      return;
    }

    const event = {
      data: JSON.stringify(payload),
    } as MessageEvent<string>;

    listenersByType.forEach((listener) => listener.call(this as unknown as EventSource, event));
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

function latestEventSource(): MockEventSource {
  const current = MockEventSource.instances[MockEventSource.instances.length - 1];
  if (!current) {
    throw new Error("Expected an active EventSource instance");
  }

  return current;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function changeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findComposerEditor(container: HTMLElement): HTMLElement {
  const editor = container.querySelector('[role="textbox"][aria-multiline="true"]');
  if (!editor) {
    throw new Error("Composer editor not found");
  }

  return editor as HTMLElement;
}

function changeComposerValue(editor: HTMLElement, value: string) {
  editor.textContent = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButtonByAriaLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!button) {
    throw new Error(`Button not found by aria-label: ${label}`);
  }

  return button as HTMLButtonElement;
}

describe("WorkspacePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { accepted: 1 } }),
      }),
    );
    MockEventSource.instances = [];
    logService.clear();

    (api.pickDirectory as Mock).mockResolvedValue({ path: "/tmp/alpha" });
    (api.listRepositories as Mock).mockResolvedValue(repositoryFixture);
    (api.createRepository as Mock).mockResolvedValue(repositoryFixture[0]);
    (api.listThreads as Mock).mockResolvedValue(threadFixture);
    (api.listMessages as Mock).mockResolvedValue(messageFixture);
    (api.listEvents as Mock).mockResolvedValue(eventFixture);
    (api.stopRun as Mock).mockResolvedValue(undefined);
    (api.answerQuestion as Mock).mockResolvedValue(undefined);
    (api.resolvePermission as Mock).mockResolvedValue(undefined);
    (api.approvePlan as Mock).mockResolvedValue(undefined);
    (api.revisePlan as Mock).mockResolvedValue(undefined);
    (api.searchFiles as Mock).mockResolvedValue([]);
    (api.openWorktreeFile as Mock).mockResolvedValue(undefined);
    (api.getGitStatus as Mock).mockResolvedValue({ branch: "feature/ui", entries: [] });
    (api.gitCommit as Mock).mockResolvedValue({ result: "ok" });
    (api.getGitDiff as Mock).mockResolvedValue({ diff: "", summary: "" });
    (api.createThread as Mock).mockResolvedValue({ ...threadFixture[0], id: "thread-2", title: "Thread 2" });
    (api.deleteThread as Mock).mockResolvedValue(undefined);
    (api.createWorktree as Mock).mockResolvedValue({
      id: "wt-2",
      repositoryId: "repo-1",
      branch: "aceh",
      path: "/tmp/alpha/.worktrees/aceh",
      baseBranch: "main",
      status: "active",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    logService.clear();
    vi.unstubAllGlobals();
  });

  it("renders workspace sections and loaded data", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("CodeSymphony");
    expect(container.textContent).toContain("Workspace (1)");
    expect(container.textContent).not.toContain("Checks");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("Initial response");
  });

  it("attaches repository from workspace plus button using directory picker", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    act(() => {
      click(findButtonByAriaLabel(container, "Attach repository"));
    });

    await flushEffects();

    expect(api.pickDirectory).toHaveBeenCalledTimes(1);
    expect(api.createRepository).toHaveBeenCalledWith({ path: "/tmp/alpha" });
  });

  it("falls back to manual path prompt when directory picker is unavailable", async () => {
    (api.pickDirectory as Mock).mockRejectedValueOnce(new Error("picker unavailable"));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("/tmp/manual-repo");

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    act(() => {
      click(findButtonByAriaLabel(container, "Attach repository"));
    });

    await flushEffects();

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(api.createRepository).toHaveBeenCalledWith({ path: "/tmp/manual-repo" });

    promptSpy.mockRestore();
  });

  it("does not attach repository when manual prompt is canceled or empty", async () => {
    (api.pickDirectory as Mock).mockRejectedValueOnce(new Error("picker unavailable"));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("   ");

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    act(() => {
      click(findButtonByAriaLabel(container, "Attach repository"));
    });

    await flushEffects();

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(api.createRepository).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it("groups tool events into inline activity trace blocks", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-tool.output"]')).toBeNull();
  });

  it("renders any read-file response in markdown mode", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-file",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "please open src/main.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-file",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "export const main = () => 42;",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-file",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { toolName: "Read", summary: "Read src/main.ts" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-msg-file",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-file", role: "assistant", delta: "export const main = () => 42;" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-complete-file",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-file" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.textContent).toContain("export const main = () => 42;");
  });

  it("keeps read-file output in markdown until a code fence appears during stream", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-stream",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open src/main.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-stream",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-stream",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read src/main.ts" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-msg-read-stream-initial",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-stream", role: "assistant", delta: "" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const stream = latestEventSource();
    act(() => {
      stream.emit("message.delta", {
        id: "evt-msg-read-stream-lead",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-read-stream",
          role: "assistant",
          delta: "Saya sudah buka filenya, berikut isinya:",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file-stream"]')).toBeNull();

    act(() => {
      stream.emit("message.delta", {
        id: "evt-msg-read-stream-fence",
        threadId: "thread-1",
        idx: 4,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-read-stream",
          role: "assistant",
          delta: "\n```ts\nexport const main = () => 42;",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file-stream"]')).toBeNull();
  });

  it("falls back to raw text when markdown is incomplete", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-assistant-fallback",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: "```md\n# Draft\n- item",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-msg-fallback",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-fallback", role: "assistant", delta: "```md\n# Draft\n- item" },
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).toBeNull();
  });

  it("keeps read responses with unclosed fence in markdown mode", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-unclosed",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open src/read-unclosed.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-unclosed",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "```ts\nexport const value = 1;",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-unclosed-read",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read src/read-unclosed.ts" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-unclosed-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-unclosed", role: "assistant", delta: "```ts\nexport const value = 1;" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.textContent).toContain("export const value = 1;");
  });

  it("keeps markdown fallback stable during stream until completion", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-assistant-fallback-stream",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: "",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-msg-fallback-stream-initial",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-fallback-stream", role: "assistant", delta: "" },
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const stream = latestEventSource();
    act(() => {
      stream.emit("message.delta", {
        id: "evt-msg-fallback-stream-open",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-fallback-stream", role: "assistant", delta: "```md\n# Draft" },
        createdAt: "2026-01-01T10:00:01.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).toBeNull();

    act(() => {
      stream.emit("message.delta", {
        id: "evt-msg-fallback-stream-close",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-fallback-stream", role: "assistant", delta: "\n```" },
        createdAt: "2026-01-01T10:00:02.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).toBeNull();

    act(() => {
      stream.emit("chat.completed", {
        id: "evt-msg-fallback-stream-complete",
        threadId: "thread-1",
        idx: 4,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-fallback-stream" },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
  });

  it("keeps read-file content visible in markdown when text includes fenced blocks", async () => {
    const rawContent = [
      "START",
      "```md",
      "# heading",
      "```",
      "middle",
      "```json",
      "{\"a\":1}",
      "```",
      "TAIL_MARKER",
    ].join("\n");

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-verbatim",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "show README.md",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-verbatim",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: rawContent,
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-verbatim",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read README.md" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-msg-verbatim",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-verbatim", role: "assistant", delta: rawContent },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.textContent).toContain("START");
    expect(container.textContent).toContain("TAIL_MARKER");
    expect(container.textContent).toContain("{\"a\":1}");
  });

  it("renders assistant narration in markdown mode for read responses", async () => {
    const content = [
      "Saya sudah buka filenya, berikut isi lengkap:",
      "```ts",
      "export function sum(a: number, b: number) {",
      "  return a + b;",
      "}",
      "```",
      "Perlu saya jelaskan baris per baris?",
    ].join("\n");

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-hybrid",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open src/math.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-hybrid",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content,
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-hybrid-read",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read src/math.ts" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-hybrid-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-hybrid", role: "assistant", delta: content },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.textContent).toContain("Saya sudah buka filenya, berikut isi lengkap:");
    expect(container.textContent).toContain("export function sum(a: number, b: number) {");
    expect(container.textContent).toContain("Perlu saya jelaskan baris per baris?");
  });

  it("shows narration progressively in markdown while read fence is still incomplete", async () => {
    const content = ["Saya sedang baca file ini:", "```ts", "export const inProgress = true;"].join("\n");

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-progressive",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open src/in-progress.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-progressive",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content,
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-progressive-read",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read src/in-progress.ts" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-progressive-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-progressive", role: "assistant", delta: content },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-fallback"]')).toBeNull();
    expect(container.textContent).toContain("Saya sedang baca file ini:");
    expect(container.textContent).toContain("export const inProgress = true;");
  });

  it("keeps read responses in markdown when content has internal fenced sections", async () => {
    const content = [
      "Siap, saya ulangi lagi isi lengkap `README.md`:",
      "```md",
      "# Title",
      "## Project Structure",
      "```text",
      ".",
      "```",
      "## Main Dependencies",
      "- dep-a",
    ].join("\n");

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-internal-fence",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "tolong carikan README.md",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-internal-fence",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content,
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-internal-fence-read",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read README.md" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-internal-fence-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-internal-fence", role: "assistant", delta: content },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file-stream"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
    expect(container.textContent).toContain("Siap, saya ulangi lagi isi lengkap README.md:");
    expect(container.textContent).toContain("Main Dependencies");
  });

  it("toggles between beauty view and raw claude output", async () => {
    window.localStorage.setItem("cs.debug.render", "1");
    try {
      (api.listMessages as Mock).mockResolvedValueOnce([
        {
          id: "msg-assistant-toggle",
          threadId: "thread-1",
          seq: 0,
          role: "assistant",
          content: "## Title\n\nSome formatted text",
          createdAt: "2026-01-01T10:00:00.000Z",
        },
      ]);
      (api.listEvents as Mock).mockResolvedValueOnce([
        {
          id: "evt-toggle-msg",
          threadId: "thread-1",
          idx: 1,
          type: "message.delta",
          payload: { messageId: "msg-assistant-toggle", role: "assistant", delta: "## Title\n\nSome formatted text" },
          createdAt: "2026-01-01T10:00:00.000Z",
        },
      ]);

      await act(async () => {
        root.render(<WorkspacePage />);
      });

      await flushEffects();

      expect(container.querySelector('[data-testid="assistant-render-raw-output"]')).toBeNull();

      act(() => {
        click(findButtonByAriaLabel(container, "Toggle raw output"));
      });

      await flushEffects();

      expect(container.querySelector('[data-testid="assistant-render-raw-output"]')).not.toBeNull();
      expect(container.textContent).toContain("raw");
      expect(container.textContent).toContain("## Title");

      act(() => {
        click(findButtonByAriaLabel(container, "Toggle raw output"));
      });

      await flushEffects();

      expect(container.querySelector('[data-testid="assistant-render-raw-output"]')).toBeNull();
    } finally {
      window.localStorage.removeItem("cs.debug.render");
    }
  });

  it("copies raw assistant output with one click from copy button", async () => {
    window.localStorage.setItem("cs.debug.render", "1");
    try {
      const writeTextMock = vi.fn();
      Object.assign(navigator, {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      (api.listMessages as Mock).mockResolvedValueOnce([
        {
          id: "msg-assistant-copy",
          threadId: "thread-1",
          seq: 0,
          role: "assistant",
          content: "raw-from-claude",
          createdAt: "2026-01-01T10:00:00.000Z",
        },
      ]);
      (api.listEvents as Mock).mockResolvedValueOnce([
        {
          id: "evt-copy-msg",
          threadId: "thread-1",
          idx: 1,
          type: "message.delta",
          payload: { messageId: "msg-assistant-copy", role: "assistant", delta: "raw-from-claude" },
          createdAt: "2026-01-01T10:00:00.000Z",
        },
      ]);

      await act(async () => {
        root.render(<WorkspacePage />);
      });

      await flushEffects();

      act(() => {
        click(findButtonByAriaLabel(container, "Copy output"));
      });

      expect(writeTextMock).toHaveBeenCalledWith("raw-from-claude");
    } finally {
      window.localStorage.removeItem("cs.debug.render");
    }
  });

  it("does not append duplicate replayed message.delta events from stream history", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-stream",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: "A",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-stream-1",
        threadId: "thread-1",
        idx: 7,
        type: "message.delta",
        payload: { messageId: "msg-stream", role: "assistant", delta: "A" },
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const stream = latestEventSource();
    expect(stream.url).toContain("afterIdx=7");

    act(() => {
      stream.emit("message.delta", {
        id: "evt-stream-1",
        threadId: "thread-1",
        idx: 7,
        type: "message.delta",
        payload: { messageId: "msg-stream", role: "assistant", delta: "A" },
        createdAt: "2026-01-01T10:00:01.000Z",
      });
      stream.emit("message.delta", {
        id: "evt-stream-2",
        threadId: "thread-1",
        idx: 8,
        type: "message.delta",
        payload: { messageId: "msg-stream", role: "assistant", delta: "B" },
        createdAt: "2026-01-01T10:00:02.000Z",
      });
    });

    await flushEffects();

    expect(container.textContent).toContain("AB");
    expect(container.textContent).not.toContain("AAB");
  });

  it("keeps read responses in markdown across transient thread reloads", async () => {
    (api.listMessages as Mock)
      .mockResolvedValueOnce([
        {
          id: "msg-user-sticky",
          threadId: "thread-1",
          seq: 0,
          role: "user",
          content: "tolong cek ini",
          createdAt: "2026-01-01T10:00:00.000Z",
        },
        {
          id: "msg-assistant-sticky",
          threadId: "thread-1",
          seq: 1,
          role: "assistant",
          content: "```ts\nexport const value = 1;\n```",
          createdAt: "2026-01-01T10:00:02.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "msg-user-sticky",
          threadId: "thread-1",
          seq: 0,
          role: "user",
          content: "tolong cek ini",
          createdAt: "2026-01-01T10:00:00.000Z",
        },
        {
          id: "msg-assistant-sticky",
          threadId: "thread-1",
          seq: 1,
          role: "assistant",
          content: "```ts\nexport const value = 1;\n```",
          createdAt: "2026-01-01T10:00:02.000Z",
        },
      ]);
    (api.listEvents as Mock)
      .mockResolvedValueOnce([
        {
          id: "evt-sticky-read",
          threadId: "thread-1",
          idx: 1,
          type: "tool.finished",
          payload: { summary: "Read src/value.ts" },
          createdAt: "2026-01-01T10:00:01.000Z",
        },
        {
          id: "evt-sticky-msg",
          threadId: "thread-1",
          idx: 2,
          type: "message.delta",
          payload: { messageId: "msg-assistant-sticky", role: "assistant", delta: "```ts\nexport const value = 1;\n```" },
          createdAt: "2026-01-01T10:00:02.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "evt-sticky-msg",
          threadId: "thread-1",
          idx: 2,
          type: "message.delta",
          payload: { messageId: "msg-assistant-sticky", role: "assistant", delta: "```ts\nexport const value = 1;\n```" },
          createdAt: "2026-01-01T10:00:02.000Z",
        },
      ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("chat.completed", {
        id: "evt-sticky-complete",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-sticky" },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).toBeNull();
  });

  it("does not label non-diff tool summaries as edited files", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-finished",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Edited 1 file" },
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "evt-msg-non-diff",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-1", role: "assistant", delta: "Initial response" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();


    expect(container.querySelector('[data-testid="timeline-edited-diff"]')).toBeNull();
    expect(container.textContent).not.toContain("Edited files");
  });

  it("keeps markdown mode for horizontal rule content", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-hr-markdown",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: "Saya akan cek dulu.\n\n---\n\nBerikut hasilnya.",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-hr-markdown-delta",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-hr-markdown",
          role: "assistant",
          delta: "Saya akan cek dulu.\n\n---\n\nBerikut hasilnya.",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-diff"]')).toBeNull();
  });

  it("renders edited diff card inline between assistant text segments", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edited-inline",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update file sekarang",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edited-inline",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya update dulu. Sudah beres.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edited-inline-msg-before",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edited-inline", role: "assistant", delta: "Saya update dulu." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edited-inline-worktree",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          source: "worktree.diff",
          summary: "Edited 2 files",
          changedFiles: ["src/main.ts", "src/util.ts"],
          diff: "diff --git a/src/main.ts b/src/main.ts\nindex 111..222 100644\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-export const main = () => 1;\n+export const main = () => 2;\ndiff --git a/src/util.ts b/src/util.ts\n@@ -3,0 +4 @@\n+export const next = 3;",
          diffTruncated: false,
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-edited-inline-msg-after",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edited-inline", role: "assistant", delta: " Sudah beres." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-edited-inline-complete",
        threadId: "thread-1",
        idx: 4,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-edited-inline" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited diff card");
    }

    expect(container.querySelector('[data-testid="timeline-tool-diff-preview"]')).toBeNull();
    const summaryEl = editedCard.querySelector("summary");
    if (!summaryEl) {
      throw new Error("Expected summary element in edited diff card");
    }
    expect(summaryEl.textContent).toContain("Edited src/main.ts");
    expect(summaryEl.textContent).toContain("+2");
    expect(summaryEl.textContent).toContain("-1");
    expect(summaryEl.textContent).toContain("(2 files)");

    const details = editedCard.querySelector("details") as HTMLDetailsElement | null;
    if (!details) {
      throw new Error("Expected edited diff details block");
    }

    expect(details.open).toBe(true);
    const collapsedContent = container.textContent ?? "";
    expect(collapsedContent.indexOf("Saya update dulu.")).toBeLessThan(collapsedContent.indexOf("Edited src/main.ts"));
    expect(collapsedContent.indexOf("Edited src/main.ts")).toBeLessThan(collapsedContent.indexOf("Sudah beres."));

    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });

    await flushEffects();

    const detailsAfterToggle = container.querySelector('[data-testid="timeline-edited-diff"] details') as HTMLDetailsElement | null;
    if (!detailsAfterToggle) {
      throw new Error("Expected edited diff details block after toggle");
    }

    expect(detailsAfterToggle.open).toBe(true);
    expect(detailsAfterToggle.textContent).toContain("export const main");
    expect(detailsAfterToggle.querySelector('[data-line-kind="addition"]')).not.toBeNull();
    expect(detailsAfterToggle.querySelector('[data-line-kind="deletion"]')).not.toBeNull();
    expect(detailsAfterToggle.querySelector('[data-line-kind="hunk"]')).not.toBeNull();
    expect(detailsAfterToggle.querySelector('[data-line-kind="meta"]')).toBeNull();
  });

  it("renders editing status with proposed diff while waiting for edit approval", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edit-pending",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "ubah src/main.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edit-pending",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya edit dulu. Menunggu izin.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edit-pending-before",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-pending", role: "assistant", delta: "Saya edit dulu." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edit-pending-permission",
        threadId: "thread-1",
        idx: 2,
        type: "permission.requested",
        payload: {
          requestId: "edit-pending-1",
          toolName: "MultiEdit",
          toolInput: {
            file_path: "src/main.ts",
            edits: [
              {
                old_string: "export const main = () => 1;",
                new_string: "export const main = () => 2;",
              },
            ],
          },
          blockedPath: null,
          decisionReason: "File write requires approval.",
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-edit-pending-after",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-pending", role: "assistant", delta: " Menunggu izin." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected editing diff card");
    }
    expect(editedCard.textContent).toContain("Editing src/main.ts");
    expect(editedCard.textContent).toContain("Proposed diff");

    const details = editedCard.querySelector("details") as HTMLDetailsElement | null;
    if (!details) {
      throw new Error("Expected editing diff details");
    }
    expect(details.open).toBe(true);

    expect(editedCard.textContent).toContain("-export const main = () => 1;");
    expect(editedCard.textContent).toContain("+export const main = () => 2;");
  });

  it("shows rejected by user on edited card and hides permission lifecycle rows", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edit-deny",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "ubah src/main.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edit-deny",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Edit dibatalkan.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edit-deny-permission-requested",
        threadId: "thread-1",
        idx: 1,
        type: "permission.requested",
        payload: {
          requestId: "edit-deny-1",
          toolName: "Edit",
          toolInput: {
            file_path: "src/main.ts",
            old_string: "export const main = () => 1;",
            new_string: "export const main = () => 2;",
          },
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edit-deny-permission-resolved",
        threadId: "thread-1",
        idx: 2,
        type: "permission.resolved",
        payload: {
          requestId: "edit-deny-1",
          decision: "deny",
          resolver: "user",
          message: "Tool execution denied by user.",
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-edit-deny-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-deny", role: "assistant", delta: "Edit dibatalkan." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected denied edited card");
    }

    expect(editedCard.textContent).toContain("Rejected by user: src/main.ts");
    expect(container.querySelector('[data-testid="timeline-permission.requested"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.resolved"]')).toBeNull();
  });

  it("keeps edit proposed diff visible when bash tool events exist in the same assistant context", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edit-with-bash",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edit-with-bash",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Sedang saya proses.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-before-edit-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "bash-before-edit", parentToolUseId: null, isBash: true },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-before-edit-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Ran pwd",
          precedingToolUseIds: ["bash-before-edit"],
          isBash: true,
        },
        createdAt: "2026-01-01T10:00:01.100Z",
      },
      {
        id: "evt-edit-with-bash-permission",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "edit-with-bash-1",
          toolName: "Edit",
          toolInput: {
            file_path: "src/main.ts",
            old_string: "export const main = () => 1;",
            new_string: "export const main = () => 2;",
          },
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-edit-with-bash-msg",
        threadId: "thread-1",
        idx: 4,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-with-bash", role: "assistant", delta: "Sedang saya proses." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited diff card with bash context");
    }

    expect(editedCard.textContent).toContain("Editing src/main.ts");
    expect(editedCard.textContent).toContain("Proposed diff");
  });

  it("replaces proposed editing state with actual edited diff after worktree snapshot", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edit-transition",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update src/main.ts",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edit-transition",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya update dulu. Sudah beres.",
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edit-transition-before",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-transition", role: "assistant", delta: "Saya update dulu." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edit-transition-permission",
        threadId: "thread-1",
        idx: 2,
        type: "permission.requested",
        payload: {
          requestId: "edit-transition-1",
          toolName: "Edit",
          toolInput: {
            file_path: "src/main.ts",
            old_string: "export const main = () => 1;",
            new_string: "export const main = () => 2;",
          },
        },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-edit-transition-started",
        threadId: "thread-1",
        idx: 3,
        type: "tool.started",
        payload: {
          toolName: "Edit",
          toolUseId: "edit-transition-1",
          parentToolUseId: null,
          editTarget: "src/main.ts",
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-edit-transition-finished",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: {
          summary: "Edited src/main.ts",
          precedingToolUseIds: ["edit-transition-1"],
          editTarget: "src/main.ts",
        },
        createdAt: "2026-01-01T10:00:01.700Z",
      },
      {
        id: "evt-edit-transition-worktree",
        threadId: "thread-1",
        idx: 5,
        type: "tool.finished",
        payload: {
          source: "worktree.diff",
          summary: "Edited 1 file",
          changedFiles: ["src/main.ts"],
          diff: "diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export const main = () => 1;\n+export const main = () => 2;",
          diffTruncated: false,
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-edit-transition-after",
        threadId: "thread-1",
        idx: 6,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-transition", role: "assistant", delta: " Sudah beres." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-edit-transition-complete",
        threadId: "thread-1",
        idx: 7,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-edit-transition" },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited transition card");
    }
    expect(editedCard.textContent).toContain("Edited src/main.ts");
    expect(editedCard.textContent).toContain("+1");
    expect(editedCard.textContent).toContain("-1");
    expect(editedCard.textContent).not.toContain("Editing src/main.ts");
    expect(editedCard.textContent).not.toContain("Proposed diff");
  });

  it("renders edited summary fallback when edit succeeds without worktree diff", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edit-fallback",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "edit file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edit-fallback",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Sudah saya edit.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edit-fallback-started",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: {
          toolName: "Edit",
          toolUseId: "edit-fallback-1",
          parentToolUseId: null,
          editTarget: "src/main.ts",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edit-fallback-finished",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Edited src/main.ts",
          precedingToolUseIds: ["edit-fallback-1"],
          editTarget: "src/main.ts",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-edit-fallback-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edit-fallback", role: "assistant", delta: "Sudah saya edit." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited fallback card");
    }
    expect(editedCard.textContent).toContain("Edited src/main.ts");
    expect(editedCard.querySelector("details")).toBeNull();
  });

  it("prefers changedFiles over parsed diff files for edited summary", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edited-priority",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "apply update",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edited-priority",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edited-priority-msg",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-edited-priority", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edited-priority-worktree",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          source: "worktree.diff",
          summary: "Edited 1 file",
          changedFiles: ["src/real.ts"],
          diff: "diff --git a/src/noisy.ts b/src/noisy.ts\n@@ -1 +1 @@\n-export const noisy = 1;\n+export const noisy = 2;",
          diffTruncated: false,
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-edited-priority-complete",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-edited-priority" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited diff card");
    }

    const summary = editedCard.querySelector("summary");
    if (!summary) {
      throw new Error("Expected edited diff summary");
    }
    expect(summary.textContent).toContain("Edited src/real.ts");
    expect(summary.textContent).not.toContain("src/noisy.ts");
  });

  it("keeps first sentence intact before edited card when assistant text is split across deltas", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edited-sentence",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update README",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edited-sentence",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content:
          "I can see that the README.md file already has a Last edited date at the end, which shows 18 Feb 2026 10.31. Since today's date is 18 Feb 2026, I need to update the time.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edited-sentence-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-edited-sentence",
          role: "assistant",
          delta: "I can see that the README.md file already has a Last edited date at the end, which",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edited-sentence-permission",
        threadId: "thread-1",
        idx: 2,
        type: "permission.requested",
        payload: {
          requestId: "edit-sentence-1",
          toolName: "Edit",
          toolInput: {
            file_path: "README.md",
            old_string: "**Last edited:** 18 Feb 2026 10.31",
            new_string: "**Last edited:** 18 Feb 2026",
          },
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-edited-sentence-delta-2",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-edited-sentence",
          role: "assistant",
          delta: " shows 18 Feb 2026 10.31. Since today's date is 18 Feb 2026, I need to update the time.",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const firstSentenceIdx = timelineText.indexOf(
      "I can see that the README.md file already has a Last edited date at the end, which shows 18 Feb 2026 10.31.",
    );
    const editedIdx = timelineText.indexOf("Editing README.md");
    const tailIdx = timelineText.indexOf("Since today's date is 18 Feb 2026, I need to update the time.");

    expect(firstSentenceIdx).toBeGreaterThanOrEqual(0);
    expect(editedIdx).toBeGreaterThanOrEqual(0);
    expect(tailIdx).toBeGreaterThanOrEqual(0);
    expect(editedIdx).toBeGreaterThan(firstSentenceIdx);
    expect(editedIdx).toBeLessThan(tailIdx);
  });

  it("renders edited card after available text when no sentence boundary is present", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-edited-noboundary",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update README",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-edited-noboundary",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "I can see the last edited value which shows old timestamp and i will update it now",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edited-noboundary-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-edited-noboundary",
          role: "assistant",
          delta: "I can see the last edited value which",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-edited-noboundary-permission",
        threadId: "thread-1",
        idx: 2,
        type: "permission.requested",
        payload: {
          requestId: "edit-noboundary-1",
          toolName: "Edit",
          toolInput: {
            file_path: "README.md",
            old_string: "**Last edited:** old",
            new_string: "**Last edited:** new",
          },
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-edited-noboundary-delta-2",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-edited-noboundary",
          role: "assistant",
          delta: " shows old timestamp and i will update it now",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const textIdx = timelineText.indexOf(
      "I can see the last edited value which shows old timestamp and i will update it now",
    );
    const editedIdx = timelineText.indexOf("Editing README.md");

    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(editedIdx).toBeGreaterThanOrEqual(0);
    expect(editedIdx).toBeGreaterThan(textIdx);
  });

  it("renders edited diff card as orphan when no assistant timeline segment is available", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edited-orphan",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          source: "worktree.diff",
          summary: "Edited 1 file",
          changedFiles: ["src/main.ts"],
          diff: "diff --git a/src/main.ts b/src/main.ts\n@@ -1 +1 @@\n-export const main = () => 1;\n+export const main = () => 2;",
          diffTruncated: false,
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited diff orphan card");
    }

    expect(editedCard.textContent).toContain("Edited src/main.ts +1 -1");
    const diffDetails = editedCard.querySelector("details") as HTMLDetailsElement | null;
    if (!diffDetails) {
      throw new Error("Expected diff preview details");
    }

    expect(diffDetails.open).toBe(true);
    act(() => {
      diffDetails.open = true;
      diffDetails.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await flushEffects();

    const diffDetailsAfterToggle = container.querySelector('[data-testid="timeline-edited-diff"] details') as HTMLDetailsElement | null;
    if (!diffDetailsAfterToggle) {
      throw new Error("Expected diff preview details after toggle");
    }

    expect(diffDetailsAfterToggle.open).toBe(true);
    expect(diffDetailsAfterToggle.textContent).toContain("export const main");
  });

  it("keeps read tool events before assistant output in inline timeline", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-order",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open README.md",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-order",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "README content here",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-order-read",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: { summary: "Read README.md" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-order-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-order", role: "assistant", delta: "README content here" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    // Activity is no longer rendered as a visible card, so just check
    // the assistant row is present and contains the expected content.
    const assistantRow = container.querySelector('[data-testid="message-assistant"]');
    if (!assistantRow) {
      throw new Error("Expected assistant row");
    }
    expect(container.textContent).toContain("README content here");
  });

  it("renders tool.started events in timeline as running step", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-started-only",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: {
          toolName: "Read",
          toolUseId: "tool-started-only",
          parentToolUseId: null,
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-tool.started"]')).not.toBeNull();
    expect(container.textContent).toContain("Read (running)");
  });

  it("does not render non-bash tool summaries as bash command cards", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "read readme",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-1", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read README.md",
          precedingToolUseIds: ["tool-read-1"],
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-read-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-read-complete",
        threadId: "thread-1",
        idx: 4,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-read" },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).toBeNull();
    expect(container.textContent).not.toContain("Ran commands");
    expect(container.textContent).toContain("Read README.md");
  });

  it("groups read and search traces into one exploring row in timeline order without duplicate started rows", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-group",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "read docs",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-group",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Summary done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-group-start-1",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-group-1", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-group-finish-1",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read README.md",
          precedingToolUseIds: ["tool-read-group-1"],
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-read-group-start-2",
        threadId: "thread-1",
        idx: 3,
        type: "tool.started",
        payload: { toolName: "Grep", toolUseId: "tool-search-group-1", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-read-group-finish-2",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: {
          summary: "toolName: \"(Glob|Grep|Search|Find|LS|Ls|List)\"|summary: \".*(glob|grep|search|find|list|ls) in WorkspacePage.test.tsx",
          precedingToolUseIds: ["tool-search-group-1"],
        },
        createdAt: "2026-01-01T10:00:01.600Z",
      },
      {
        id: "evt-search-group-start-2",
        threadId: "thread-1",
        idx: 5,
        type: "tool.started",
        payload: { toolName: "Search", toolUseId: "tool-search-group-2", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.700Z",
      },
      {
        id: "evt-search-group-finish-2",
        threadId: "thread-1",
        idx: 6,
        type: "tool.finished",
        payload: {
          summary: "onToolStarted|onToolFinished|summary in test",
          precedingToolUseIds: ["tool-search-group-2"],
        },
        createdAt: "2026-01-01T10:00:01.800Z",
      },
      {
        id: "evt-read-group-start-3",
        threadId: "thread-1",
        idx: 7,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-group-2", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.900Z",
      },
      {
        id: "evt-read-group-msg",
        threadId: "thread-1",
        idx: 8,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-group", role: "assistant", delta: "Summary done." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    expect(timelineText).toContain("Exploring 2 files, 2 searches");
    expect(container.textContent).toContain("Read README.md");
    expect(container.textContent).toContain("Searched for toolName: \"(Glob|Grep|Search|Find|LS|Ls|List)\"|summary: \".*(glob|grep|search|find|list|ls) in WorkspacePage.test.tsx");
    expect(container.textContent).toContain("Searched for onToolStarted|onToolFinished|summary in test");
    expect(container.textContent).toContain("Reading...");
    expect(container.querySelector('[data-testid="timeline-tool.started"]')).toBeNull();

    const readReadmeIdx = timelineText.indexOf("Read README.md");
    const firstSearchIdx = timelineText.indexOf("Searched for toolName: \"(Glob|Grep|Search|Find|LS|Ls|List)\"|summary: \".*(glob|grep|search|find|list|ls) in WorkspacePage.test.tsx");
    const secondSearchIdx = timelineText.indexOf("Searched for onToolStarted|onToolFinished|summary in test");
    const readingIdx = timelineText.indexOf("Reading...");

    expect(readReadmeIdx).toBeGreaterThanOrEqual(0);
    expect(firstSearchIdx).toBeGreaterThan(readReadmeIdx);
    expect(secondSearchIdx).toBeGreaterThan(firstSearchIdx);
    expect(readingIdx).toBeGreaterThan(secondSearchIdx);
  });

  it("renders explored summary when mixed read and search runs are fully completed", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-explore-complete",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "search and read",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-explore-complete",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-explore-complete-read-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-explore-complete-read", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-explore-complete-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read sessionRunner.test.ts",
          precedingToolUseIds: ["tool-explore-complete-read"],
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-explore-complete-search-start",
        threadId: "thread-1",
        idx: 3,
        type: "tool.started",
        payload: { toolName: "Search", toolUseId: "tool-explore-complete-search", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-explore-complete-search-finish",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: {
          summary: "onToolStarted|onToolFinished|summary in test",
          precedingToolUseIds: ["tool-explore-complete-search"],
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-explore-complete-msg",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: { messageId: "msg-assistant-explore-complete", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-explore-complete-chat-completed",
        threadId: "thread-1",
        idx: 6,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-explore-complete" },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    expect(container.textContent).toContain("Explored 1 files, 1 searches");
    expect(container.textContent).toContain("Read sessionRunner.test.ts");
    expect(container.textContent).toContain("Searched for onToolStarted|onToolFinished|summary in test");
    expect(container.textContent).not.toContain("Exploring 1 files, 1 searches");
  });

  it("renders explored summary when explore tools finish before chat.completed", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-explore-before-complete",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "read readme first",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-explore-before-complete",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "I checked it and will continue.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-explore-before-complete-read-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-explore-before-complete-read", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-explore-before-complete-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read README.md",
          precedingToolUseIds: ["tool-explore-before-complete-read"],
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-explore-before-complete-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-explore-before-complete",
          role: "assistant",
          delta: "I checked it and will continue.",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    expect(container.textContent).toContain("Explored 1 files");
    expect(container.textContent).not.toContain("Exploring 1 files");
    expect(container.textContent).toContain("Read README.md");
    expect(container.textContent).toContain("I checked it and will continue.");
  });

  it("uses search tool parameters for generic completed search summaries", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-search-generic",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "run glob",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-search-generic",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-search-generic-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: {
          toolName: "Glob",
          toolUseId: "tool-search-generic",
          parentToolUseId: null,
          searchParams: "pattern=README.md, path=apps/web/src",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-search-generic-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Completed Glob",
          precedingToolUseIds: ["tool-search-generic"],
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-search-generic-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-search-generic", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    expect(container.textContent).toContain("Searched Glob (pattern=README.md, path=apps/web/src)");
    expect(container.textContent).not.toContain("Searched for Completed Glob");
  });

  it("rotates explored-files chevron when expanded", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-chevron",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek dua file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-chevron",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-chevron-1",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          summary: "Read README.md",
          precedingToolUseIds: ["tool-read-chevron-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-chevron-2",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read docs/guide.md",
          precedingToolUseIds: ["tool-read-chevron-2"],
        },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-read-chevron-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-chevron", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const readDetails = container.querySelector('[data-testid="timeline-explore-activity"] details') as HTMLDetailsElement | null;
    if (!readDetails) {
      throw new Error("Expected read-files details");
    }

    const chevronBefore = container.querySelector('[data-testid="timeline-explore-activity-chevron"]') as HTMLElement | null;
    if (!chevronBefore) {
      throw new Error("Expected read-files chevron");
    }
    expect(chevronBefore.className).not.toContain("rotate-90");

    act(() => {
      readDetails.open = true;
      readDetails.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await flushEffects();

    const chevronAfter = container.querySelector('[data-testid="timeline-explore-activity-chevron"]') as HTMLElement | null;
    if (!chevronAfter) {
      throw new Error("Expected read-files chevron after toggle");
    }
    expect(chevronAfter.className).toContain("rotate-90");
  });

  it("shortens read path labels to basename, except hidden directories", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-path",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "baca file ini",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-path",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Ringkasan siap.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-path-finish",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          summary: "Read /Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/west-sumatra/README.md",
          precedingToolUseIds: ["tool-read-path-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-path-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-path", role: "assistant", delta: "Ringkasan siap." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-read-hidden-path-finish",
        threadId: "thread-1",
        idx: 3,
        type: "tool.finished",
        payload: {
          summary: "Read /Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/west-sumatra/.beads/README.md",
          precedingToolUseIds: ["tool-read-path-2"],
        },
        createdAt: "2026-01-01T10:00:03.100Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    expect(timelineText).toContain("Read README.md");
    expect(timelineText).toContain("Read .beads/README.md");
    expect(timelineText).not.toContain("Read /Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/west-sumatra/README.md");
  });

  it("opens single read filename with default OS app via runtime API", async () => {
    const absoluteReadPath = "/tmp/alpha/.worktrees/feature-ui/README.md";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-open-single-read",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "buka readme",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-open-single-read",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Sudah saya baca.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-open-single-read-finish",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          summary: `Read ${absoluteReadPath}`,
          precedingToolUseIds: ["tool-open-single-read-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-open-single-read-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-open-single-read", role: "assistant", delta: "Sudah saya baca." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const readRow = container.querySelector('[data-testid="timeline-explore-activity"]');
    if (!readRow) {
      throw new Error("Expected single read-files row");
    }
    const filenameButton = readRow.querySelector("button");
    if (!filenameButton) {
      throw new Error("Expected clickable filename button");
    }
    expect(filenameButton.textContent).toBe("README.md");
    expect(filenameButton.hasAttribute("title")).toBe(false);

    act(() => {
      click(filenameButton);
    });
    await flushEffects();

    expect(api.openWorktreeFile).toHaveBeenCalledTimes(1);
    expect(api.openWorktreeFile).toHaveBeenCalledWith("wt-1", { path: absoluteReadPath });
  });

  it("opens filename from expanded explored-files list", async () => {
    const primaryPath = "/tmp/alpha/.worktrees/feature-ui/README.md";
    const hiddenPath = "/tmp/alpha/.worktrees/feature-ui/.beads/README.md";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-open-multi-read",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek dua file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-open-multi-read",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Berikut hasilnya.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-open-multi-read-finish-1",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          summary: `Read ${primaryPath}`,
          precedingToolUseIds: ["tool-open-multi-read-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-open-multi-read-finish-2",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: `Read ${hiddenPath}`,
          precedingToolUseIds: ["tool-open-multi-read-2"],
        },
        createdAt: "2026-01-01T10:00:01.100Z",
      },
      {
        id: "evt-open-multi-read-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-open-multi-read", role: "assistant", delta: "Berikut hasilnya." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const readDetails = container.querySelector('[data-testid="timeline-explore-activity"] details') as HTMLDetailsElement | null;
    if (!readDetails) {
      throw new Error("Expected read-files details");
    }

    act(() => {
      readDetails.open = true;
      readDetails.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await flushEffects();

    const buttons = Array.from(container.querySelectorAll('[data-testid="timeline-explore-activity"] button'));
    const hiddenFileButton = buttons.find((button) => button.textContent === ".beads/README.md");
    if (!hiddenFileButton) {
      throw new Error("Expected hidden read filename button");
    }

    act(() => {
      click(hiddenFileButton);
    });
    await flushEffects();

    expect(api.openWorktreeFile).toHaveBeenCalledTimes(1);
    expect(api.openWorktreeFile).toHaveBeenCalledWith("wt-1", { path: hiddenPath });
  });

  it("keeps non-extractable read summary as non-clickable text", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-generic",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "read file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-generic",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Selesai.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-generic-finish",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          summary: "Completed read",
          precedingToolUseIds: ["tool-read-generic-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-generic-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-read-generic", role: "assistant", delta: "Selesai." },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const readRow = container.querySelector('[data-testid="timeline-explore-activity"]');
    if (!readRow) {
      throw new Error("Expected read-files row");
    }

    expect(readRow.textContent).toContain("Read file");
    expect(readRow.querySelector("button")).toBeNull();
    expect(api.openWorktreeFile).not.toHaveBeenCalled();
  });

  it("keeps read-files trace between assistant preamble and final summary after completion reload", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-read-order",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "tolong cari README dan rangkum",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-read-order",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content:
          "I'll help you find and read the README.md file, then provide a summary.\n## Summary of README.md Files\nMain summary.",
        createdAt: "2026-01-01T10:00:00.100Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-read-order-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-read-order",
          role: "assistant",
          delta: "I'll help you find and read the README.md file, then provide a summary.",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-read-order-finish-1",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read /README.md",
          precedingToolUseIds: ["tool-read-order-1"],
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-read-order-finish-2",
        threadId: "thread-1",
        idx: 3,
        type: "tool.finished",
        payload: {
          summary: "Read docs/README.md",
          precedingToolUseIds: ["tool-read-order-2"],
        },
        createdAt: "2026-01-01T10:00:02.100Z",
      },
      {
        id: "evt-read-order-delta-2",
        threadId: "thread-1",
        idx: 4,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-read-order",
          role: "assistant",
          delta: "\n## Summary of README.md Files\nMain summary.",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-read-order-complete",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-read-order" },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const preambleIdx = timelineText.indexOf("I'll help you find and read the README.md file, then provide a summary.");
    const exploredIdx = timelineText.indexOf("Explored 2 files");
    const summaryIdx = timelineText.indexOf("Summary of README.md Files");

    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThan(preambleIdx);
    expect(exploredIdx).toBeLessThan(summaryIdx);
  });

  it("keeps first sentence intact before explore activity when assistant text is split across deltas", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-stream-inline",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek networking flutter",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-stream-inline",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya akan mencari file-file terkait networking dalam proyek Flutter ini. Berikut adalah ringkasan file networking.",
        createdAt: "2026-01-01T10:00:00.100Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-stream-inline-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-stream-inline",
          role: "assistant",
          delta: "Saya",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-stream-inline-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read api_client.dart",
          precedingToolUseIds: ["tool-stream-inline-read-1"],
        },
        createdAt: "2026-01-01T10:00:01.100Z",
      },
      {
        id: "evt-stream-inline-search-start",
        threadId: "thread-1",
        idx: 3,
        type: "tool.started",
        payload: {
          toolName: "Glob",
          toolUseId: "tool-stream-inline-search-1",
          parentToolUseId: null,
          searchParams: "pattern=**/api*.dart",
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-stream-inline-search-finish",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: {
          summary: "Completed Glob",
          precedingToolUseIds: ["tool-stream-inline-search-1"],
        },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-stream-inline-delta-2",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-stream-inline",
          role: "assistant",
          delta: " akan mencari file-file terkait networking dalam proyek Flutter ini. Berikut adalah ringkasan file networking.",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-stream-inline-complete",
        threadId: "thread-1",
        idx: 6,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-stream-inline" },
        createdAt: "2026-01-01T10:00:02.100Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const leadIdx = timelineText.indexOf("Saya");
    const continuationIdx = timelineText.indexOf("akan mencari file-file terkait networking dalam proyek Flutter ini.");
    const exploredIdx = timelineText.indexOf("Explored 1 files, 1 searches");
    const summaryIdx = timelineText.indexOf("Berikut adalah ringkasan file networking.");

    expect(leadIdx).toBeGreaterThanOrEqual(0);
    expect(continuationIdx).toBeGreaterThan(leadIdx);
    expect(exploredIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThan(continuationIdx);
    expect(exploredIdx).toBeLessThan(summaryIdx);
  });

  it("keeps first sentence contiguous before explore activity when boundary has no whitespace", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-stream-nospace",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek networking flutter",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-stream-nospace",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya akan mencari file terkait networking dalam project Flutter ini.Berikut adalah file-file terkait networking dalam project.",
        createdAt: "2026-01-01T10:00:00.100Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-stream-nospace-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-stream-nospace",
          role: "assistant",
          delta: "Saya",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-stream-nospace-search-start",
        threadId: "thread-1",
        idx: 2,
        type: "tool.started",
        payload: {
          toolName: "Glob",
          toolUseId: "tool-stream-nospace-search-1",
          parentToolUseId: null,
          searchParams: "pattern=**/api*.dart",
        },
        createdAt: "2026-01-01T10:00:01.100Z",
      },
      {
        id: "evt-stream-nospace-search-finish",
        threadId: "thread-1",
        idx: 3,
        type: "tool.finished",
        payload: {
          summary: "Completed Glob",
          precedingToolUseIds: ["tool-stream-nospace-search-1"],
        },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-stream-nospace-delta-2",
        threadId: "thread-1",
        idx: 4,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-stream-nospace",
          role: "assistant",
          delta: " akan mencari file terkait networking dalam project Flutter ini.Berikut adalah file-file terkait networking dalam project.",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-stream-nospace-complete",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-stream-nospace" },
        createdAt: "2026-01-01T10:00:02.100Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const firstSentenceIdx = timelineText.indexOf("Saya akan mencari file terkait networking dalam project Flutter ini.");
    const exploredIdx = timelineText.indexOf("Explored 1 searches");
    const secondSentenceIdx = timelineText.indexOf("Berikut adalah file-file terkait networking dalam project.");

    expect(firstSentenceIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThan(firstSentenceIdx);
    expect(secondSentenceIdx).toBeGreaterThan(exploredIdx);
  });

  it("prioritizes idx ordering over timestamps in inline timeline", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-order-idx",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "urutkan berdasarkan idx",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-order-idx",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Urutan idx dulu. Lalu ringkasan.",
        createdAt: "2026-01-01T10:00:00.100Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-order-idx-delta-1",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-order-idx",
          role: "assistant",
          delta: "Urutan idx dulu. ",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-order-idx-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Read README.md",
          precedingToolUseIds: ["tool-order-idx-read-1"],
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-order-idx-delta-2",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-order-idx",
          role: "assistant",
          delta: "Lalu ringkasan.",
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-order-idx-complete",
        threadId: "thread-1",
        idx: 4,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-order-idx" },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const timelineText = container.textContent ?? "";
    const preambleIdx = timelineText.indexOf("Urutan idx dulu.");
    const exploredIdx = timelineText.indexOf("Explored 1 files");
    const summaryIdx = timelineText.indexOf("Lalu ringkasan.");

    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(exploredIdx).toBeGreaterThan(preambleIdx);
    expect(exploredIdx).toBeLessThan(summaryIdx);
  });

  it("marks bash command as success when message already completed", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-completed",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek path",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-completed",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Path sudah saya cek.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-completed-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-completed", parentToolUseId: null, command: "pwd", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-completed-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-bash-completed", role: "assistant", delta: "Path sudah saya cek." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-bash-completed-done",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-bash-completed" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).not.toBeNull();
    expect(container.textContent).toContain("Success");
    expect(container.textContent).not.toContain("Running");
  });

  it("hides orphan permission resolved row while keeping bash card visible", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-allow-hidden",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "jalankan bash",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-allow-hidden",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Selesai.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-allow-hidden-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "bash-allow-hidden-1", command: "pwd", isBash: true },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-allow-hidden-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: { summary: "Ran pwd", precedingToolUseIds: ["bash-allow-hidden-1"], isBash: true },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-bash-allow-hidden-perm-resolved",
        threadId: "thread-1",
        idx: 3,
        type: "permission.resolved",
        payload: {
          requestId: "perm-allow-hidden",
          decision: "allow",
          resolver: "user",
        },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.requested"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.resolved"]')).toBeNull();
    expect(container.textContent).not.toContain("Permission allowed");
  });

  it("shows rejected by user on bash card and hides permission lifecycle rows", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-rejected",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "jalankan beberapa command",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-rejected",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Satu command ditolak.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-rejected-ok-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "bash-ok-1", command: "pwd", isBash: true },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-rejected-ok-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: { summary: "Ran pwd", precedingToolUseIds: ["bash-ok-1"], output: "/tmp/project", isBash: true },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-bash-rejected-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "bash-deny-1",
          toolName: "Bash",
          command: "rm -rf /tmp/project",
        },
        createdAt: "2026-01-01T10:00:01.300Z",
      },
      {
        id: "evt-bash-rejected-perm-resolved",
        threadId: "thread-1",
        idx: 4,
        type: "permission.resolved",
        payload: {
          requestId: "bash-deny-1",
          decision: "deny",
          resolver: "user",
          message: "Tool execution denied by user.",
        },
        createdAt: "2026-01-01T10:00:01.400Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).not.toBeNull();
    expect(container.textContent).toContain("Rejected by user");
    expect(container.querySelector('[data-testid="timeline-permission.requested"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.resolved"]')).toBeNull();
  });

  it("renders orphan tool row without raw JSON details panel", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([]);
    (api.listEvents as Mock).mockResolvedValue([
      {
        id: "evt-orphan-finished",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          toolName: "Read",
          summary: "Read src/main.ts",
          command: "cat src/main.ts",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const toolRow = container.querySelector('[data-testid="timeline-tool.finished"]');
    expect(toolRow).not.toBeNull();
    expect(toolRow?.textContent).not.toContain("Details");
    expect(toolRow?.textContent).not.toContain("\"toolName\"");
    expect(toolRow?.textContent).not.toContain("\"command\"");
  });

  it("logs orphan tool event to chat.sync once per event id", async () => {
    (api.listMessages as Mock).mockResolvedValue([
      {
        id: "msg-user-orphan",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValue([
      {
        id: "evt-orphan-sync",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          toolName: "Read",
          toolUseId: "tool-orphan-sync",
          summary: "Read README.md",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const stream = latestEventSource();
    act(() => {
      stream.emit("chat.completed", {
        id: "evt-chat-complete-orphan-sync",
        threadId: "thread-1",
        idx: 2,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-orphan-sync" },
        createdAt: "2026-01-01T10:00:02.000Z",
      });
    });
    await flushEffects();

    const warnings = logService.getEntries().filter(
      (entry) => entry.source === "chat.sync"
        && typeof entry.data === "object"
        && entry.data != null
        && (entry.data as Record<string, unknown>).eventId === "evt-orphan-sync",
    );
    expect(warnings).toHaveLength(1);
  });

  it("does not log chat.sync warning for tool event attached to assistant timeline", async () => {
    (api.listMessages as Mock).mockResolvedValue([
      {
        id: "msg-user-attached",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "open readme",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-attached",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done.",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValue([
      {
        id: "evt-tool-attached",
        threadId: "thread-1",
        idx: 1,
        type: "tool.finished",
        payload: {
          toolName: "Read",
          toolUseId: "tool-attached",
          summary: "Read README.md",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-msg-attached",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-attached", role: "assistant", delta: "Done." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-complete-attached",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-attached" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const warnings = logService.getEntries().filter(
      (entry) => entry.source === "chat.sync"
        && typeof entry.data === "object"
        && entry.data != null
        && (entry.data as Record<string, unknown>).eventId === "evt-tool-attached",
    );
    expect(warnings).toHaveLength(0);
  });

  it("logs incoming stream tool events to chat.stream", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await flushEffects();

    const stream = latestEventSource();
    act(() => {
      stream.emit("tool.output", {
        id: "evt-stream-tool-log",
        threadId: "thread-1",
        idx: 99,
        type: "tool.output",
        payload: {
          toolName: "Read",
          toolUseId: "tool-stream-log",
          parentToolUseId: null,
          elapsedTimeSeconds: 0.2,
        },
        createdAt: "2026-01-01T10:00:10.000Z",
      });
    });
    await flushEffects();

    const streamEntries = logService.getEntries().filter(
      (entry) => entry.source === "chat.stream"
        && typeof entry.data === "object"
        && entry.data != null
        && (entry.data as Record<string, unknown>).eventId === "evt-stream-tool-log",
    );
    expect(streamEntries).toHaveLength(1);
  });

  it("renders bash command card between assistant text deltas", async () => {
    const longPathCommand = "ls -la /Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/north-sumatra/lib/hello_world.dart";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-late-tools",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek folder sekarang",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-late-tools",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya cek dulu lalu kasih hasil pwd.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-late-msg-start",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-late-tools", role: "assistant", delta: "Saya cek dulu." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-late-tool-start",
        threadId: "thread-1",
        idx: 2,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-1", parentToolUseId: null, command: longPathCommand, isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-late-tool-output",
        threadId: "thread-1",
        idx: 3,
        type: "tool.output",
        payload: { toolName: "Bash", toolUseId: "tool-1", parentToolUseId: null, elapsedTimeSeconds: 2 },
        createdAt: "2026-01-01T10:00:01.800Z",
      },
      {
        id: "evt-late-tool-finish",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: { summary: "Ran ls -la", precedingToolUseIds: ["tool-1"], command: longPathCommand, output: "/tmp/project", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-late-msg-end",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: { messageId: "msg-assistant-late-tools", role: "assistant", delta: " Hasilnya sudah ada." },
        createdAt: "2026-01-01T10:00:02.500Z",
      },
      {
        id: "evt-late-complete",
        threadId: "thread-1",
        idx: 6,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-late-tools" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const bashCard = container.querySelector('[data-testid="timeline-bash-command"]');
    if (!bashCard) {
      throw new Error("Expected bash command card");
    }
    const details = bashCard.querySelector("details") as HTMLDetailsElement | null;
    if (!details) {
      throw new Error("Expected bash command details block");
    }
    const summary = details.querySelector("summary");
    const chevron = summary?.querySelector("span:last-child");
    const summaryClassName = typeof summary?.className === "string" ? summary.className : "";
    const chevronClassName = typeof chevron?.className === "string" ? chevron.className : "";
    const summaryText = summary?.textContent ?? "";

    expect(details.open).toBe(false);
    expect(summaryText).toContain("Ran ls -la hello_world.dart for 2s");
    expect(summaryText).not.toContain("/Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/north-sumatra/lib/hello_world.dart");
    expect(summaryClassName).toContain("inline-flex");
    expect(summaryClassName).not.toContain("justify-between");
    expect(chevronClassName).toContain("opacity-0");
    expect(chevronClassName).toContain("group-hover/bash-summary:opacity-100");
    expect(chevronClassName).not.toContain("border");
    expect(container.textContent).not.toContain("Ran command");
    expect(container.textContent).toContain(`$ ${longPathCommand}`);
    expect(container.textContent).toContain("/tmp/project");
    expect(container.querySelector('[data-testid="timeline-tool.output"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
    const collapsedContent = container.textContent ?? "";
    expect(collapsedContent.indexOf("Saya cek dulu.")).toBeLessThan(collapsedContent.indexOf("Ran ls -la hello_world.dart for 2s"));
    expect(collapsedContent.indexOf("Ran ls -la hello_world.dart for 2s")).toBeLessThan(collapsedContent.indexOf("Hasilnya sudah ada."));

    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });

    await flushEffects();

    expect(container.textContent).toContain("Ran commands for 2s");
    const expandedContent = container.textContent ?? "";
    expect(expandedContent.indexOf("Saya cek dulu.")).toBeLessThan(expandedContent.indexOf("Ran commands for 2s"));
    expect(expandedContent.indexOf("Ran commands for 2s")).toBeLessThan(expandedContent.indexOf("Hasilnya sudah ada."));
  });

  it("shows truncated marker for long bash output", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-truncated",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "jalankan command",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-truncated",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya jalankan command. Selesai.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-msg-before",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-bash-truncated", role: "assistant", delta: "Saya jalankan command." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-start",
        threadId: "thread-1",
        idx: 2,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-trunc", parentToolUseId: null, command: "cat logs.txt", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.100Z",
      },
      {
        id: "evt-bash-finish",
        threadId: "thread-1",
        idx: 3,
        type: "tool.finished",
        payload: {
          summary: "Ran cat logs.txt",
          precedingToolUseIds: ["tool-trunc"],
          command: "cat logs.txt",
          output: "x".repeat(100),
          truncated: true,
          isBash: true,
          shell: "bash",
        },
        createdAt: "2026-01-01T10:00:01.900Z",
      },
      {
        id: "evt-bash-msg-after",
        threadId: "thread-1",
        idx: 4,
        type: "message.delta",
        payload: { messageId: "msg-assistant-bash-truncated", role: "assistant", delta: " Selesai." },
        createdAt: "2026-01-01T10:00:02.200Z",
      },
      {
        id: "evt-bash-complete",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-bash-truncated" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).not.toBeNull();
    expect(container.textContent).toContain("... [output truncated]");
    expect(container.textContent).toContain("$ cat logs.txt");
  });

  it("shows failed status and error output for bash command", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-failed",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "jalankan command error",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-failed",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Command gagal.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-failed-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-failed", parentToolUseId: null, command: "pnpm unknown", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-failed-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          summary: "Command failed",
          precedingToolUseIds: ["tool-failed"],
          command: "pnpm unknown",
          error: "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL",
          isBash: true,
          shell: "bash",
        },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
      {
        id: "evt-bash-failed-msg",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: { messageId: "msg-assistant-bash-failed", role: "assistant", delta: "Command gagal." },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const bashCard = container.querySelector('[data-testid="timeline-bash-command"]');
    expect(bashCard).not.toBeNull();
    const details = bashCard?.querySelector("details") as HTMLDetailsElement | null;
    if (!details) {
      throw new Error("Expected bash command details block");
    }

    expect(details.open).toBe(true);
    act(() => {
      details.open = false;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });
    await flushEffects();
    const detailsAfterToggle = container.querySelector('[data-testid="timeline-bash-command"] details') as HTMLDetailsElement | null;
    if (!detailsAfterToggle) {
      throw new Error("Expected bash command details block after toggle");
    }
    expect(detailsAfterToggle.open).toBe(false);

    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL");
    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
  });

  it("keeps running bash command collapsed by default", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-bash-running",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "cek path sekarang",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-bash-running",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Saya cek path dulu.",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-bash-running-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-running", parentToolUseId: null, command: "pwd", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-bash-running-msg",
        threadId: "thread-1",
        idx: 2,
        type: "message.delta",
        payload: { messageId: "msg-assistant-bash-running", role: "assistant", delta: "Saya cek path dulu." },
        createdAt: "2026-01-01T10:00:01.500Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const bashCard = container.querySelector('[data-testid="timeline-bash-command"]');
    expect(bashCard).not.toBeNull();
    const details = bashCard?.querySelector("details") as HTMLDetailsElement | null;
    if (!details) {
      throw new Error("Expected bash command details block");
    }

    expect(container.textContent).toContain("Running");
    expect(details.open).toBe(false);
  });

  it("creates a new thread via header action", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    act(() => {
      click(findButtonByAriaLabel(container, "Add session"));
    });

    await flushEffects();

    expect(api.createThread).toHaveBeenCalledWith("wt-1", { title: "Thread 2" });
  });

  it("renders session tabs with underline active state and horizontal overflow container", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const tabList = container.querySelector('[role="tablist"][aria-label="Sessions"]');
    if (!tabList) {
      throw new Error("Sessions tablist not found");
    }

    const overflowContainer = container.querySelector('[data-testid="session-tabs-scroll"]');
    if (!overflowContainer) {
      throw new Error("Session tabs overflow container not found");
    }

    const activeTab = tabList.querySelector('button[role="tab"][aria-selected="true"]');
    if (!activeTab) {
      throw new Error("Active session tab not found");
    }

    expect(overflowContainer.className).toContain("overflow-x-auto");
    expect(activeTab.textContent).toContain("Main Thread");
    expect(activeTab.getAttribute("title")).toBe("Main Thread");
    expect(activeTab.className).toContain("max-w-[180px]");
    expect(activeTab.className).toContain("truncate");
    expect(activeTab.parentElement?.className).toContain("border-b-primary");
  });

  it("updates thread tab title and close aria-label from chat.completed threadTitle payload", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const updatedTitle = "Judul thread yang sangat panjang untuk validasi tooltip penuh";
    const stream = latestEventSource();
    act(() => {
      stream.emit("chat.completed", {
        id: "evt-thread-rename",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: {
          messageId: "msg-assistant-renamed",
          threadTitle: updatedTitle,
        },
        createdAt: "2026-01-01T10:00:05.000Z",
      });
    });

    await flushEffects();

    const activeTab = container.querySelector('button[role="tab"][aria-selected="true"]');
    if (!activeTab) {
      throw new Error("Active session tab not found after thread rename");
    }

    expect(activeTab.textContent).toContain(updatedTitle);
    expect(activeTab.getAttribute("title")).toBe(updatedTitle);
    expect(findButtonByAriaLabel(container, `Close session ${updatedTitle}`)).toBeDefined();
  });

  it("closes an existing thread from session tabs", async () => {
    (api.listThreads as Mock).mockResolvedValueOnce(threadFixtureWithSecondary);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("Main Thread");
    expect(container.textContent).toContain("Thread 2");

    act(() => {
      click(findButtonByAriaLabel(container, "Close session Main Thread"));
    });

    await flushEffects();

    expect(api.deleteThread).toHaveBeenCalledWith("thread-1");
    expect(container.textContent).toContain("Thread 2");
  });

  it("shows close button on active tab and hover-state class on inactive tabs", async () => {
    (api.listThreads as Mock).mockResolvedValueOnce(threadFixtureWithSecondary);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const activeCloseButton = findButtonByAriaLabel(container, "Close session Main Thread");
    const inactiveCloseButton = findButtonByAriaLabel(container, "Close session Thread 2");

    expect(activeCloseButton.className).toContain("opacity-100");
    expect(inactiveCloseButton.className).toContain("opacity-0");
    expect(inactiveCloseButton.className).toContain("group-hover:opacity-100");
  });

  it("creates a worktree from workspace add icon without manual input", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    act(() => {
      click(findButtonByAriaLabel(container, "Add worktree for alpha"));
    });

    await flushEffects();

    expect(api.createWorktree).toHaveBeenCalledWith("repo-1");
  });

  it("shows create action when repository has no active worktree yet", async () => {
    (api.listRepositories as Mock).mockResolvedValueOnce([
      {
        ...repositoryFixture[0],
        worktrees: [],
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("No active worktrees yet.");

    act(() => {
      click(findButtonByAriaLabel(container, "Add worktree for alpha"));
    });

    await flushEffects();

    expect(api.createWorktree).toHaveBeenCalledWith("repo-1");
  });

  it("supports multi-expand repositories in the workspace list", async () => {
    (api.listRepositories as Mock).mockResolvedValueOnce(repositoryFixtureMultiExpand);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("feature/ui");
    expect(container.textContent).not.toContain("feature/api");

    const secondRepoRow = container.querySelector('[data-testid="repository-repo-2"]');
    if (!secondRepoRow) {
      throw new Error("Second repository row not found");
    }

    const secondRepoToggle = secondRepoRow.querySelector("button");
    if (!secondRepoToggle) {
      throw new Error("Second repository toggle not found");
    }

    act(() => {
      click(secondRepoToggle);
    });

    await flushEffects();

    expect(container.textContent).toContain("feature/ui");
    expect(container.textContent).toContain("feature/api");
  });

  it("disables run when no thread exists", async () => {
    (api.listRepositories as Mock).mockResolvedValueOnce([
      {
        ...repositoryFixture[0],
        worktrees: [],
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const sendButton = findButtonByAriaLabel(container, "Send message");
    expect(sendButton.disabled).toBe(true);
  });

  it("submits on Enter and does not submit on Shift+Enter", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);

    act(() => {
      changeComposerValue(editor, "first message");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(api.sendMessage).toHaveBeenCalledWith("thread-1", { content: "first message", mode: "default" });

    (api.sendMessage as Mock).mockClear();

    act(() => {
      changeComposerValue(editor, "second message");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });

    await flushEffects();

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("shows stop button while assistant run is active", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);
    act(() => {
      changeComposerValue(editor, "please respond");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    const stopButton = findButtonByAriaLabel(container, "Stop run");
    expect(stopButton.disabled).toBe(false);
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
  });

  it("stops active assistant run when stop button is clicked", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);
    act(() => {
      changeComposerValue(editor, "please stop this");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    const stopButton = findButtonByAriaLabel(container, "Stop run");
    act(() => {
      click(stopButton);
    });

    await flushEffects();

    expect(api.stopRun).toHaveBeenCalledWith("thread-1");
    expect(stopButton.disabled).toBe(true);

    act(() => {
      click(stopButton);
    });

    await flushEffects();

    expect(api.stopRun).toHaveBeenCalledTimes(1);
  });

  it("shows thinking placeholder before first assistant delta, then hides it", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);

    act(() => {
      changeComposerValue(editor, "please respond");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    const thinkingPlaceholder = container.querySelector('[data-testid="thinking-placeholder"]');
    expect(thinkingPlaceholder).not.toBeNull();
    expect(thinkingPlaceholder?.querySelector(".rounded-xl")).toBeNull();
    expect(thinkingPlaceholder?.querySelector(".border")).toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("message.delta", {
        id: "evt-thinking-first-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-thinking",
          role: "assistant",
          delta: "Hello from assistant",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
    expect(container.textContent).toContain("Hello from assistant");
  });

  it("hides thinking placeholder when waiting for permission approval", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);
    act(() => {
      changeComposerValue(editor, "run command please");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("permission.requested", {
        id: "evt-thinking-permission-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-thinking",
          toolName: "Bash",
          command: "cat /etc/hosts",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="permission-prompt-perm-thinking"]')).not.toBeNull();
  });

  it("hides thinking placeholder when waiting for question answer", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);
    act(() => {
      changeComposerValue(editor, "need clarification?");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("question.requested", {
        id: "evt-thinking-question-requested",
        threadId: "thread-1",
        idx: 3,
        type: "question.requested",
        payload: {
          requestId: "question-thinking",
          questions: [{ question: "Target environment?" }],
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="question-card-question-thinking"]')).not.toBeNull();
  });

  it("hides thinking placeholder when waiting for plan decision", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);
    act(() => {
      changeComposerValue(editor, "create plan");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("plan.created", {
        id: "evt-thinking-plan-created",
        threadId: "thread-1",
        idx: 3,
        type: "plan.created",
        payload: {
          messageId: "msg-plan-waiting",
          content: "# Plan\n\n- Step 1",
          filePath: "/tmp/project/.claude/plans/plan-thinking.md",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).not.toBeNull();
  });

  it("hides thinking placeholder on chat.failed and chat.completed", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editor = findComposerEditor(container);

    act(() => {
      changeComposerValue(editor, "first try");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("chat.failed", {
        id: "evt-thinking-failed",
        threadId: "thread-1",
        idx: 3,
        type: "chat.failed",
        payload: { message: "failed early" },
        createdAt: "2026-01-01T10:00:03.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();

    act(() => {
      changeComposerValue(editor, "second try");
    });

    await flushEffects();

    act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    act(() => {
      stream.emit("chat.completed", {
        id: "evt-thinking-completed",
        threadId: "thread-1",
        idx: 4,
        type: "chat.completed",
        payload: { messageId: "msg-thinking-complete" },
        createdAt: "2026-01-01T10:00:04.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
  });

  it("shows permission prompt card from event history and hides composer", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-1",
          toolName: "Bash",
          command: "cat /etc/hosts",
          blockedPath: "/etc/hosts",
          decisionReason: "Path outside project directory",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("Permission Required");
    expect(container.textContent).toContain("cat /etc/hosts");
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
  });

  it("shows question card from event history and hides composer", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-question-requested-history",
        threadId: "thread-1",
        idx: 3,
        type: "question.requested",
        payload: {
          requestId: "question-history",
          questions: [{ question: "Target environment?" }],
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="question-card-question-history"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
  });

  it("uses edit-specific confirmation wording for edit permissions", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-edit-perm-requested-history",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "edit-perm-history",
          toolName: "Edit",
          toolInput: {
            file_path: "/Users/dwirandyh/.codesymphony/worktrees/dws-bssn-cmlonlrm/south-sumatra/README.md",
            old_string: "hello",
            new_string: "hello world",
          },
          decisionReason: "File write requires approval.",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("Do you want Claude to apply this edit to README.md?");
    expect(container.textContent).toContain("Yes, apply edit");
    expect(container.textContent).toContain("No, keep current file");
    expect(container.textContent).not.toContain("Target file:");
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
  });

  it("resolves permission when approve is clicked", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-1",
          toolName: "Bash",
          command: "cat /etc/hosts",
          blockedPath: "/etc/hosts",
          decisionReason: "Path outside project directory",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const approveButton = findButtonByAriaLabel(container, "Allow once perm-1");
    act(() => {
      click(approveButton);
    });

    await flushEffects();

    expect(api.resolvePermission).toHaveBeenCalledWith("thread-1", {
      requestId: "perm-1",
      decision: "allow",
    });
  });

  it("shows thinking again after allowing permission and waits for assistant response", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested-resume",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-resume",
          toolName: "Bash",
          command: "cat /etc/hosts",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();

    const approveButton = findButtonByAriaLabel(container, "Allow once perm-resume");
    act(() => {
      click(approveButton);
    });

    await flushEffects();

    const stream = latestEventSource();
    act(() => {
      stream.emit("permission.resolved", {
        id: "evt-perm-resolved-resume",
        threadId: "thread-1",
        idx: 4,
        type: "permission.resolved",
        payload: {
          requestId: "perm-resume",
          decision: "allow",
          resolver: "user",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    act(() => {
      stream.emit("message.delta", {
        id: "evt-perm-resume-first-delta",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: {
          messageId: "msg-perm-resume",
          role: "assistant",
          delta: "Thanks, proceeding.",
        },
        createdAt: "2026-01-01T10:00:05.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
  });

  it("resolves permission when always allow is clicked", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-2",
          toolName: "Bash",
          command: "flutter analyze",
          blockedPath: null,
          decisionReason: "Tool requires approval",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const alwaysAllowButton = findButtonByAriaLabel(container, "Always allow in workspace perm-2");
    act(() => {
      click(alwaysAllowButton);
    });

    await flushEffects();

    expect(api.resolvePermission).toHaveBeenCalledWith("thread-1", {
      requestId: "perm-2",
      decision: "allow_always",
    });
  });

  it("shows thinking again after answering question and waits for assistant response", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-question-requested-resume",
        threadId: "thread-1",
        idx: 3,
        type: "question.requested",
        payload: {
          requestId: "question-resume",
          questions: [{ question: "Target environment?" }],
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const answerInput = container.querySelector('input[placeholder="Type your answer..."]');
    if (!answerInput) {
      throw new Error("Question answer input not found");
    }

    act(() => {
      changeInputValue(answerInput as HTMLInputElement, "production");
    });

    await flushEffects();

    const submitAnswerButton = findButtonByAriaLabel(container, "Submit answer question-resume");
    act(() => {
      click(submitAnswerButton);
    });

    await flushEffects();

    expect(api.answerQuestion).toHaveBeenCalledWith("thread-1", {
      requestId: "question-resume",
      answers: { "Target environment?": "production" },
    });

    const stream = latestEventSource();
    act(() => {
      stream.emit("question.answered", {
        id: "evt-question-answered-resume",
        threadId: "thread-1",
        idx: 4,
        type: "question.answered",
        payload: {
          requestId: "question-resume",
          answers: { "Target environment?": "production" },
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

    act(() => {
      stream.emit("chat.completed", {
        id: "evt-question-completed-resume",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-question-resume" },
        createdAt: "2026-01-01T10:00:05.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
  });

  it("removes permission prompt card when permission is resolved from stream", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-1",
          toolName: "Bash",
          command: "cat /etc/hosts",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid=\"permission-prompt-perm-1\"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("permission.resolved", {
        id: "evt-perm-resolved",
        threadId: "thread-1",
        idx: 4,
        type: "permission.resolved",
        payload: {
          requestId: "perm-1",
          decision: "deny",
          resolver: "user",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid=\"permission-prompt-perm-1\"]')).toBeNull();
  });

  it("hides permission lifecycle rows without leaking command or path details", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-activity-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-activity",
          toolName: "Read",
          command: "cat /etc/hosts",
          blockedPath: "/etc/hosts",
          decisionReason: "Path outside project directory",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-perm-activity-resolved-1",
        threadId: "thread-1",
        idx: 4,
        type: "permission.resolved",
        payload: {
          requestId: "perm-activity",
          decision: "allow",
          resolver: "user",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
      {
        id: "evt-perm-activity-resolved-2",
        threadId: "thread-1",
        idx: 5,
        type: "permission.resolved",
        payload: {
          requestId: "perm-activity",
          decision: "deny",
          resolver: "user",
        },
        createdAt: "2026-01-01T10:00:05.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.requested"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.resolved"]')).toBeNull();

    expect(container.textContent).not.toContain("Permission requested");
    expect(container.textContent).not.toContain("Permission allowed");
    expect(container.textContent).not.toContain("Permission denied");
    expect(container.textContent).not.toContain("cat /etc/hosts");
    expect(container.textContent).not.toContain("/etc/hosts");
    expect(container.textContent).not.toContain("Path outside project directory");
    expect(container.querySelector('[data-testid="permission-prompt-perm-activity"]')).toBeNull();
  });

  it("renders permission prompts inside chat-width container", async () => {
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-perm-requested",
        threadId: "thread-1",
        idx: 3,
        type: "permission.requested",
        payload: {
          requestId: "perm-width",
          toolName: "Bash",
          command: "cat /etc/hosts",
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const containerElement = container.querySelector('[data-testid="permission-prompts-container"]');
    expect(containerElement).not.toBeNull();
    expect(containerElement?.className).toContain("max-w-3xl");
  });

  it("renders plan inline with bounded height and supports expand/collapse", async () => {
    const planContent = [
      "# Plan",
      "",
      "Ringkasan",
      "",
      ...Array.from({ length: 90 }, (_, index) => `${index + 1}. Langkah implementasi yang cukup panjang untuk menguji overflow plan.`),
    ].join("\n");

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: planContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan",
          role: "assistant",
          mode: "plan",
          delta: planContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-created",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: planContent,
          filePath: "/tmp/project/.claude/plans/plan-1.md",
          messageId: "msg-plan",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="plan-inline-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
    const planTimelineRow = container.querySelector('[data-testid="timeline-plan-file-output"] > div');
    expect(planTimelineRow?.className).toContain("w-full");
    expect(planTimelineRow?.className).not.toContain("max-w-[85%]");

    const planBody = container.querySelector('[data-testid="plan-inline-content"]');
    expect(planBody?.className).toContain("max-h-[45vh]");

    const expandButton = findButtonByAriaLabel(container, "Expand plan");
    act(() => {
      click(expandButton);
    });

    await flushEffects();

    const expandedBody = container.querySelector('[data-testid="plan-inline-content"]');
    expect(expandedBody?.className).not.toContain("max-h-[45vh]");

    const collapseButton = findButtonByAriaLabel(container, "Collapse plan message");
    act(() => {
      click(collapseButton);
    });

    await flushEffects();

    const collapsedBody = container.querySelector('[data-testid="plan-inline-content"]');
    expect(collapsedBody?.className).toContain("max-h-[45vh]");
  });

  it("keeps assistant preamble as markdown and renders plan file output as separate card", async () => {
    const preamble = "I'll help you create a plan for adding a new Hello World page.";
    const planContent = "# Hello World Plan\n\n1. Create page widget\n2. Add route\n3. Verify navigation";

    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-mixed",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: preamble,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-mixed-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-mixed",
          role: "assistant",
          mode: "plan",
          delta: preamble,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-mixed-created",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: planContent,
          filePath: "/tmp/project/.claude/plans/hello-world.md",
          messageId: "msg-plan-mixed",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain(preamble);
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-inline-card"]')).not.toBeNull();
    expect(container.textContent).toContain("Hello World Plan");
  });

  it("replaces composer with plan decision panel and approves plan", async () => {
    const planContent = "# Plan\n\n- Step 1\n- Step 2";
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-delta-approve",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-approve",
          role: "assistant",
          mode: "plan",
          delta: planContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-created-approve",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: planContent,
          filePath: "/tmp/project/.claude/plans/plan-approve.md",
          messageId: "msg-plan-approve",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-approve",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: planContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();

    const submitButton = findButtonByAriaLabel(container, "Submit plan acceptance");
    act(() => {
      click(submitButton);
    });

    await flushEffects();

    expect(api.approvePlan).toHaveBeenCalledWith("thread-1");
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).toBeNull();
    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop run"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("message.delta", {
        id: "evt-plan-approve-first-delta",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-approve-exec",
          role: "assistant",
          delta: "Executing approved plan.",
        },
        createdAt: "2026-01-01T10:00:05.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
  });

  it("submits revise feedback from plan decision panel", async () => {
    const planContent = "# Plan\n\n- Step 1\n- Step 2";
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-delta-revise",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-revise",
          role: "assistant",
          mode: "plan",
          delta: planContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-created-revise",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: planContent,
          filePath: "/tmp/project/.claude/plans/plan-revise.md",
          messageId: "msg-plan-revise",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-revise",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: planContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const reviseOption = container.querySelector('[data-testid="plan-revise-option"]');
    if (!reviseOption) {
      throw new Error("Revise plan option not found");
    }
    act(() => {
      click(reviseOption);
    });

    await flushEffects();

    const feedback = container.querySelector('input[aria-label="Plan revision feedback"]');
    if (!feedback) {
      throw new Error("Plan revision feedback input not found");
    }
    expect(feedback.getAttribute("placeholder")).toBe("Revise this plan");
    expect(feedback.closest('[data-testid="plan-revise-option"]')).not.toBeNull();

    act(() => {
      changeInputValue(feedback as HTMLInputElement, "Mohon tambah detail rollback plan.");
    });

    await flushEffects();

    const submitRevision = findButtonByAriaLabel(container, "Submit plan revision");
    act(() => {
      click(submitRevision);
    });

    await flushEffects();

    expect(api.revisePlan).toHaveBeenCalledWith("thread-1", {
      feedback: "Mohon tambah detail rollback plan.",
    });
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).toBeNull();
    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop run"]')).not.toBeNull();

    const stream = latestEventSource();
    act(() => {
      stream.emit("chat.completed", {
        id: "evt-plan-revise-completed",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-plan-revise-exec" },
        createdAt: "2026-01-01T10:00:05.000Z",
      });
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).toBeNull();
  });

  it("renders plan mode assistant message as markdown when no plan.created event exists", async () => {
    const planLikeContent = "# Draft Plan\n\nIni masih draft, bukan plan file.";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-mode-only",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: planLikeContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-mode-only-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-mode-only",
          role: "assistant",
          mode: "plan",
          delta: planLikeContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="plan-inline-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.textContent).toContain("Draft Plan");
  });

  it("does not render plan card for streaming fallback plan", async () => {
    const fallbackContent = "# Plan\n\nFallback dari output stream.";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-fallback",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: fallbackContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-fallback-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-fallback",
          role: "assistant",
          mode: "plan",
          delta: fallbackContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-fallback-created",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: fallbackContent,
          filePath: "streaming-plan",
          messageId: "msg-plan-fallback",
          source: "streaming_fallback",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="plan-inline-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
  });

  it("keeps compatibility for plan.created without messageId and avoids plan card", async () => {
    const planContent = "# Plan\n\nLegacy event payload tanpa messageId.";
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-plan-legacy",
        threadId: "thread-1",
        seq: 0,
        role: "assistant",
        content: planContent,
        createdAt: "2026-01-01T10:00:00.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-plan-legacy-delta",
        threadId: "thread-1",
        idx: 3,
        type: "message.delta",
        payload: {
          messageId: "msg-plan-legacy",
          role: "assistant",
          mode: "plan",
          delta: planContent,
        },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-plan-legacy-created",
        threadId: "thread-1",
        idx: 4,
        type: "plan.created",
        payload: {
          content: planContent,
          filePath: "/tmp/project/.claude/plans/legacy-plan.md",
          source: "claude_plan_file",
        },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="plan-inline-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plan-decision-composer-container"]')).not.toBeNull();
  });

  it("renders error alert when loading repositories fails", async () => {
    (api.listRepositories as Mock).mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("boom");
  });

  it("falls back to message.content when delta events are incomplete", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-incomplete-delta",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "update the CLAUDE.md file",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-incomplete-delta",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "I'll update the CLAUDE.md file to remove all beads-related sections. Let me apply the changes now.",
        createdAt: "2026-01-01T10:00:05.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-incomplete-delta-partial",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-incomplete-delta", role: "assistant", delta: "I'll update the CLAUDE.md file to remove all beads-related sections." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-incomplete-delta-bash-start",
        threadId: "thread-1",
        idx: 2,
        type: "tool.started",
        payload: { toolName: "Bash", toolUseId: "tool-incomplete-1", parentToolUseId: null, command: "rm -rf .beads", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-incomplete-delta-bash-finish",
        threadId: "thread-1",
        idx: 3,
        type: "tool.finished",
        payload: { summary: "Ran rm -rf .beads", precedingToolUseIds: ["tool-incomplete-1"], command: "rm -rf .beads", output: "", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-incomplete-delta-complete",
        threadId: "thread-1",
        idx: 5,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-incomplete-delta" },
        createdAt: "2026-01-01T10:00:05.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const fullText = container.textContent ?? "";
    expect(fullText).toContain("Let me apply the changes now.");
    expect(fullText).toContain("I'll update the CLAUDE.md file to remove all beads-related sections.");
  });

  it("shows Deleted label for deletion-only edited diff card", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-delete-only",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "remove the beads system",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-delete-only",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Done, I removed the files.",
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-delete-only-msg",
        threadId: "thread-1",
        idx: 1,
        type: "message.delta",
        payload: { messageId: "msg-assistant-delete-only", role: "assistant", delta: "Done, I removed the files." },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-delete-only-worktree",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: {
          source: "worktree.diff",
          summary: "Edited 2 files",
          changedFiles: [".beads/.gitignore", ".beads/config.json"],
          diff: "diff --git a/.beads/.gitignore b/.beads/.gitignore\ndeleted file mode 100644\n--- a/.beads/.gitignore\n+++ /dev/null\n@@ -1,5 +0,0 @@\n-node_modules\n-dist\n-.env\n-*.log\n-coverage\ndiff --git a/.beads/config.json b/.beads/config.json\ndeleted file mode 100644\n--- a/.beads/config.json\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-{\n-  \"version\": 1\n-}",
          diffTruncated: false,
        },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-delete-only-complete",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-delete-only" },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const editedCard = container.querySelector('[data-testid="timeline-edited-diff"]');
    if (!editedCard) {
      throw new Error("Expected edited diff card for deletion");
    }
    const summaryEl = editedCard.querySelector("summary");
    if (!summaryEl) {
      throw new Error("Expected summary element in edited diff card");
    }
    expect(summaryEl.textContent).toContain("Deleted .beads/.gitignore");
    expect(summaryEl.textContent).not.toContain("Edited");
    expect(summaryEl.textContent).toContain("-8");
    expect(summaryEl.textContent).toContain("+0");
    expect(summaryEl.textContent).toContain("(2 files)");
  });

  it("places text before explore-activity when no delta events exist", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-no-deltas",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "delete config.yaml",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-no-deltas",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content: "Let me first read this file to understand what it contains.",
        createdAt: "2026-01-01T10:00:05.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-no-deltas-read-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-1", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-no-deltas-read-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: { summary: "Read .beads/config.yaml", precedingToolUseIds: ["tool-read-1"] },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-no-deltas-complete",
        threadId: "thread-1",
        idx: 3,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-no-deltas" },
        createdAt: "2026-01-01T10:00:05.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const fullText = container.textContent ?? "";
    const textIdx = fullText.indexOf("Let me first read this file");
    const exploreIdx = fullText.indexOf("Explored");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(exploreIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeLessThan(exploreIdx);
  });

  it("splits explore-activity into separate groups when text delta appears between reads", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([
      {
        id: "msg-user-split",
        threadId: "thread-1",
        seq: 0,
        role: "user",
        content: "analyze the storage module",
        createdAt: "2026-01-01T10:00:00.000Z",
      },
      {
        id: "msg-assistant-split",
        threadId: "thread-1",
        seq: 1,
        role: "assistant",
        content:
          "I'll start by exploring the storage directory to understand the current implementation before planning optimizations. Now let me read the actual implementation.",
        createdAt: "2026-01-01T10:00:10.000Z",
      },
    ]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      // First batch: 2 reads
      {
        id: "evt-split-read1-start",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-s1", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
      {
        id: "evt-split-read1-finish",
        threadId: "thread-1",
        idx: 2,
        type: "tool.finished",
        payload: { summary: "Read storage/index.ts", precedingToolUseIds: ["tool-read-s1"] },
        createdAt: "2026-01-01T10:00:02.000Z",
      },
      {
        id: "evt-split-read2-start",
        threadId: "thread-1",
        idx: 3,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-s2", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:03.000Z",
      },
      {
        id: "evt-split-read2-finish",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: { summary: "Read storage/config.ts", precedingToolUseIds: ["tool-read-s2"] },
        createdAt: "2026-01-01T10:00:04.000Z",
      },
      // Text delta between reads
      {
        id: "evt-split-delta1",
        threadId: "thread-1",
        idx: 5,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-split",
          role: "assistant",
          delta:
            "I'll start by exploring the storage directory to understand the current implementation before planning optimizations.",
        },
        createdAt: "2026-01-01T10:00:05.000Z",
      },
      // Another text delta
      {
        id: "evt-split-delta2",
        threadId: "thread-1",
        idx: 6,
        type: "message.delta",
        payload: {
          messageId: "msg-assistant-split",
          role: "assistant",
          delta: " Now let me read the actual implementation.",
        },
        createdAt: "2026-01-01T10:00:06.000Z",
      },
      // Second batch: 1 read
      {
        id: "evt-split-read3-start",
        threadId: "thread-1",
        idx: 7,
        type: "tool.started",
        payload: { toolName: "Read", toolUseId: "tool-read-s3", parentToolUseId: null },
        createdAt: "2026-01-01T10:00:07.000Z",
      },
      {
        id: "evt-split-read3-finish",
        threadId: "thread-1",
        idx: 8,
        type: "tool.finished",
        payload: { summary: "Read storage/impl.ts", precedingToolUseIds: ["tool-read-s3"] },
        createdAt: "2026-01-01T10:00:08.000Z",
      },
      {
        id: "evt-split-complete",
        threadId: "thread-1",
        idx: 9,
        type: "chat.completed",
        payload: { messageId: "msg-assistant-split" },
        createdAt: "2026-01-01T10:00:10.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const exploreRows = container.querySelectorAll('[data-testid="timeline-explore-activity"]');
    expect(exploreRows.length).toBe(2);

    const fullText = container.textContent ?? "";
    const firstExploreIdx = fullText.indexOf("Explored 2 files");
    const secondExploreIdx = fullText.indexOf("Explored 1 files");
    expect(firstExploreIdx).toBeGreaterThanOrEqual(0);
    expect(secondExploreIdx).toBeGreaterThanOrEqual(0);
    expect(firstExploreIdx).toBeLessThan(secondExploreIdx);

    const textIdx = fullText.indexOf("Now let me read the actual implementation");
    expect(textIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(firstExploreIdx);
    expect(textIdx).toBeLessThan(secondExploreIdx);
  });

  it("shows instrumentation panel when render debug mode is enabled", async () => {
    window.localStorage.setItem("cs.debug.render", "1");

    try {
      await act(async () => {
        root.render(<WorkspacePage />);
      });

      await flushEffects();

      expect(container.querySelector('[data-testid="render-debug-panel"]')).not.toBeNull();
      expect(container.textContent).toContain("Instrumentation");
    } finally {
      window.localStorage.removeItem("cs.debug.render");
    }
  });

  // ── Source Control panel integration ──

  it("Source Control toggle has correct aria attributes when panel is closed", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const toggle = container.querySelector('button[aria-label="Source Control"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("source-control-panel");
  });

  it("opens Source Control panel and sets aria-expanded to true", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const toggle = container.querySelector('button[aria-label="Source Control"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    await flushEffects();

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = container.querySelector("#source-control-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-label")).toBe("Source Control panel");
    expect(container.textContent).toContain("Source Control");
  });

  it("renders git entries in Source Control panel when status returns files", async () => {
    (api.getGitStatus as Mock).mockResolvedValue({
      branch: "feature/ui",
      entries: [
        { path: "src/main.ts", status: "modified" },
        { path: "src/new-file.ts", status: "added" },
      ],
    });

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const toggle = container.querySelector('button[aria-label="Source Control"]') as HTMLButtonElement;
    act(() => {
      toggle.click();
    });

    await flushEffects();

    expect(container.textContent).toContain("main.ts");
    expect(container.textContent).toContain("new-file.ts");
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
  });

  it("closes Source Control panel on toggle and resets aria-expanded", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const toggle = container.querySelector('button[aria-label="Source Control"]') as HTMLButtonElement;

    act(() => {
      toggle.click();
    });

    await flushEffects();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      toggle.click();
    });

    await flushEffects();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("#source-control-panel")).toBeNull();
  });
});
