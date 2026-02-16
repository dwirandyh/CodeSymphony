import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatEvent, ChatMessage, ChatThread, Repository } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { WorkspacePage } from "./WorkspacePage";
import { api } from "../lib/api";

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
    resolvePermission: vi.fn(),
    listEvents: vi.fn(),
    runtimeBaseUrl: "http://127.0.0.1:4321",
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
    MockEventSource.instances = [];

    (api.pickDirectory as Mock).mockResolvedValue({ path: "/tmp/alpha" });
    (api.listRepositories as Mock).mockResolvedValue(repositoryFixture);
    (api.createRepository as Mock).mockResolvedValue(repositoryFixture[0]);
    (api.listThreads as Mock).mockResolvedValue(threadFixture);
    (api.listMessages as Mock).mockResolvedValue(messageFixture);
    (api.listEvents as Mock).mockResolvedValue(eventFixture);
    (api.resolvePermission as Mock).mockResolvedValue(undefined);
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

    expect(container.textContent).toContain("Activity for");
    expect(container.textContent).toContain("git status");
    expect(container.querySelector('[data-testid="timeline-activity"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-tool.output"]')).toBeNull();
  });

  it("renders any read-file response in raw file mode and infers language", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();
    expect(container.textContent).toContain("export const main = () => 42;");
    expect(container.textContent).toContain("ts");
    expect(container.textContent).toContain("Analyzed");
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

  it("keeps full raw-file content verbatim when text includes fenced blocks", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();
    expect(container.textContent).toContain("START");
    expect(container.textContent).toContain("TAIL_MARKER");
    expect(container.textContent).toContain("```json");
  });

  it("renders assistant narration around raw-file card in hybrid mode", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();
    expect(container.textContent).toContain("Saya sudah buka filenya, berikut isi lengkap:");
    expect(container.textContent).toContain("export function sum(a: number, b: number) {");
    expect(container.textContent).toContain("Perlu saya jelaskan baris per baris?");
    expect(container.textContent).toContain("ts");
  });

  it("shows narration progressively while raw-file fence is still incomplete", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();
    expect(container.textContent).toContain("Saya sedang baca file ini:");
    expect(container.textContent).toContain("export const inProgress = true;");
  });

  it("keeps streaming raw-file stable when content has internal fenced sections", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file-stream"]')).not.toBeNull();
    expect(container.textContent).toContain("Siap, saya ulangi lagi isi lengkap `README.md`:");
    expect(container.textContent).toContain("## Main Dependencies");
  });

  it("toggles between beauty view and raw claude output", async () => {
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
  });

  it("copies raw assistant output with one click from copy button", async () => {
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

  it("keeps raw-file mode sticky across transient thread reloads", async () => {
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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();

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

    expect(container.querySelector('[data-testid="assistant-render-raw-file"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-render-markdown"]')).toBeNull();
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

    expect(container.textContent).toContain("Activity for");
    expect(container.textContent).toContain("Edited 1 file");
    expect(container.textContent).not.toContain("Edited files");
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

    const toolRow = container.querySelector('[data-testid="timeline-activity"]');
    const assistantRow = container.querySelector('[data-testid="message-assistant"]');
    if (!toolRow || !assistantRow) {
      throw new Error("Expected inline activity row and assistant row");
    }

    const relation = toolRow.compareDocumentPosition(assistantRow);
    expect((relation & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    expect(container.textContent).toContain("Analyzed");
  });

  it("does not render tool.started events in timeline", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([]);
    (api.listEvents as Mock).mockResolvedValueOnce([
      {
        id: "evt-started-only",
        threadId: "thread-1",
        idx: 1,
        type: "tool.started",
        payload: {
          toolName: "Bash",
          toolUseId: "tool-started-only",
          parentToolUseId: null,
          command: "pwd",
        },
        createdAt: "2026-01-01T10:00:01.000Z",
      },
    ]);

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="timeline-tool.started"]')).toBeNull();
    expect(container.textContent).not.toContain("tool.started");
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

  it("renders orphan tool row without raw JSON details panel", async () => {
    (api.listMessages as Mock).mockResolvedValueOnce([]);
    (api.listEvents as Mock).mockResolvedValueOnce([
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

  it("renders bash command card between assistant text deltas", async () => {
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
        payload: { toolName: "Bash", toolUseId: "tool-1", parentToolUseId: null, command: "pwd", isBash: true, shell: "bash" },
        createdAt: "2026-01-01T10:00:01.200Z",
      },
      {
        id: "evt-late-tool-output",
        threadId: "thread-1",
        idx: 3,
        type: "tool.output",
        payload: { toolName: "Bash", toolUseId: "tool-1", parentToolUseId: null, elapsedTimeSeconds: 0.6 },
        createdAt: "2026-01-01T10:00:01.800Z",
      },
      {
        id: "evt-late-tool-finish",
        threadId: "thread-1",
        idx: 4,
        type: "tool.finished",
        payload: { summary: "Ran pwd", precedingToolUseIds: ["tool-1"], command: "pwd", output: "/tmp/project", isBash: true, shell: "bash" },
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

    expect(details.open).toBe(false);
    expect(container.textContent).toContain("Ran pwd");
    expect(container.textContent).not.toContain("Ran command");
    expect(container.textContent).toContain("$ pwd");
    expect(container.textContent).toContain("/tmp/project");
    expect(container.querySelector('[data-testid="timeline-tool.output"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
    const collapsedContent = container.textContent ?? "";
    expect(collapsedContent.indexOf("Saya cek dulu.")).toBeLessThan(collapsedContent.indexOf("Ran pwd"));
    expect(collapsedContent.indexOf("Ran pwd")).toBeLessThan(collapsedContent.indexOf("Hasilnya sudah ada."));

    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    });

    await flushEffects();

    expect(container.textContent).toContain("Ran command");
    const expandedContent = container.textContent ?? "";
    expect(expandedContent.indexOf("Saya cek dulu.")).toBeLessThan(expandedContent.indexOf("Ran command"));
    expect(expandedContent.indexOf("Ran command")).toBeLessThan(expandedContent.indexOf("Hasilnya sudah ada."));
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

    expect(container.querySelector('[data-testid="timeline-bash-command"]')).not.toBeNull();
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL");
    expect(container.querySelector('[data-testid="timeline-activity"]')).toBeNull();
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
    expect(activeTab.parentElement?.className).toContain("border-b-primary");
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
      click(findButtonByAriaLabel(container, "Create first worktree for alpha"));
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

    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("Composer textarea not found");
    }

    act(() => {
      changeTextareaValue(textarea as HTMLTextAreaElement, "first message");
    });

    await flushEffects();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(api.sendMessage).toHaveBeenCalledWith("thread-1", { content: "first message" });

    (api.sendMessage as Mock).mockClear();

    act(() => {
      changeTextareaValue(textarea as HTMLTextAreaElement, "second message");
    });

    await flushEffects();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });

    await flushEffects();

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("shows thinking placeholder before first assistant delta, then hides it", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("Composer textarea not found");
    }

    act(() => {
      changeTextareaValue(textarea as HTMLTextAreaElement, "please respond");
    });

    await flushEffects();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await flushEffects();

    expect(container.querySelector('[data-testid="thinking-placeholder"]')).not.toBeNull();

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

  it("hides thinking placeholder on chat.failed and chat.completed", async () => {
    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    const textarea = container.querySelector("textarea");
    if (!textarea) {
      throw new Error("Composer textarea not found");
    }

    act(() => {
      changeTextareaValue(textarea as HTMLTextAreaElement, "first try");
    });

    await flushEffects();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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
      changeTextareaValue(textarea as HTMLTextAreaElement, "second try");
    });

    await flushEffects();

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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

  it("shows permission prompt card from event history and disables composer", async () => {
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

    const sendButton = findButtonByAriaLabel(container, "Send message");
    expect(sendButton.disabled).toBe(true);
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

  it("shows only one final permission activity line without command or path details", async () => {
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

    expect(container.querySelector('[data-testid="timeline-activity"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.requested"]')).toBeNull();
    expect(container.querySelector('[data-testid="timeline-permission.resolved"]')).toBeNull();
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).not.toContain("Permission requested");
    expect(container.textContent).not.toContain("Permission allowed");
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

  it("renders error alert when loading repositories fails", async () => {
    (api.listRepositories as Mock).mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      root.render(<WorkspacePage />);
    });

    await flushEffects();

    expect(container.textContent).toContain("boom");
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
});
