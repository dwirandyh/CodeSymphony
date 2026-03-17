import { act, forwardRef, useImperativeHandle, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { ChatTimelineItem } from "./chat-message-list";
import { MarkdownBody, ChatMessageList } from "./chat-message-list";

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn().mockReturnValue([]),
  SPLIT_WITH_NEWLINES: /\r?\n/,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="file-diff">FileDiff</div>,
}));

const { scrollToIndexMock, latestVListPropsRef } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn(),
  latestVListPropsRef: { current: null as Record<string, any> | null },
}));

vi.mock("virtua", () => ({
  VList: forwardRef(({ children, ...props }: any, ref) => {
    latestVListPropsRef.current = props;
    useImperativeHandle(ref, () => ({
      scrollToIndex: scrollToIndexMock,
    }));
    return <div data-testid="vlist">{typeof children === "function" ? null : children}</div>;
  }),
}));

vi.mock("../../lib/renderDebug", () => ({
  isRenderDebugEnabled: () => false,
  pushRenderDebug: vi.fn(),
  copyRenderDebugLog: vi.fn(),
}));


vi.mock("react-markdown", () => ({
  default: ({ children }: any) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("rehype-sanitize", () => ({
  default: {},
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  scrollToIndexMock.mockReset();
  latestVListPropsRef.current = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function makeMessage(id: string, role: "user" | "assistant", content: string, seq: number): ChatMessage {
  return {
    id,
    threadId: "t1",
    seq,
    role,
    content,
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function makeMessageItem(id: string, seq: number, content = `message-${id}`): ChatTimelineItem {
  return {
    kind: "message",
    message: makeMessage(id, seq % 2 === 0 ? "assistant" : "user", content, seq),
  };
}

function getTimelineRowWrappers(): HTMLDivElement[] {
  return Array.from(container.querySelectorAll("[data-testid='vlist'] > div")) as HTMLDivElement[];
}

function expectRowSpacingClass(itemIndex: number, className: "pb-2" | "pb-4") {
  const row = getTimelineRowWrappers()[itemIndex];
  expect(row).toBeTruthy();
  expect(row.className).toContain(className);
}

function mountChatMessageList(
  props: Partial<ComponentProps<typeof ChatMessageList>> = {},
): void {
  flushSync(() => {
    root.render(
      <ChatMessageList
        items={[]}
        {...props}
      />,
    );
  });
}

function setScrollMetrics({ scrollHeight = 1000, clientHeight = 400 }: { scrollHeight?: number; clientHeight?: number } = {}) {
  const wrapper = container.querySelector("[data-testid='chat-scroll']") as HTMLDivElement | null;
  if (!wrapper) {
    throw new Error("chat-scroll wrapper not found");
  }
  Object.defineProperty(wrapper, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(wrapper, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
}

function triggerScroll(offset: number) {
  if (!latestVListPropsRef.current?.onScroll) {
    throw new Error("VList onScroll handler not captured");
  }
  act(() => {
    latestVListPropsRef.current?.onScroll(offset);
  });
}

function triggerScrollEnd() {
  if (!latestVListPropsRef.current?.onScrollEnd) {
    throw new Error("VList onScrollEnd handler not captured");
  }
  act(() => {
    latestVListPropsRef.current?.onScrollEnd();
  });
}

describe("MarkdownBody", () => {
  it("renders markdown content", () => {
    act(() => {
      root.render(<MarkdownBody content="Hello **world**" />);
    });
    expect(container.textContent).toContain("Hello **world**");
  });

  it("renders empty content without crash", () => {
    act(() => {
      root.render(<MarkdownBody content="" />);
    });
    expect(container).toBeTruthy();
  });
});

describe("ChatMessageList", () => {
  const baseProps = {
    items: [] as ChatTimelineItem[],
  };

  it("renders without crash for empty items", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} />);
    });
    expect(container).toBeTruthy();
  });

  it("renders user message", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m1", "user", "Hello there", 1) },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Hello there");
  });

  it("renders assistant message", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m2", "assistant", "Hi back!", 2), renderHint: "markdown" },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Hi back!");
  });

  it("renders error item", () => {
    const items: ChatTimelineItem[] = [
      { kind: "error", id: "err-1", message: "Something went wrong", createdAt: "2026-01-01T00:00:00Z" },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Something went wrong");
  });

  it("renders thinking item", () => {
    const items: ChatTimelineItem[] = [
      { kind: "thinking", id: "th-1", messageId: "m1", content: "Let me think...", isStreaming: false },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Thought process");
  });

  it("renders unified collapsible tool item for bash output", () => {
    const event: ChatEvent = {
      id: "ev-bash",
      threadId: "t1",
      idx: 1,
      type: "tool.finished",
      payload: {
        toolName: "Bash",
        toolUseId: "tu-1",
        summary: "Ran ls -la",
        output: "total 0\ndrwxr-xr-x",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-1",
        event,
        sourceEvents: [event],
        toolUseId: "tu-1",
        toolName: "Bash",
        shell: "bash",
        command: "ls -la",
        output: "total 0\ndrwxr-xr-x",
        truncated: false,
        durationSeconds: 0.5,
        status: "success",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Ran ls -la");
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).not.toContain("tool.finished");
    expect(container.querySelector("[data-testid='timeline-tool']")).toBeTruthy();
    expect(container.querySelector("details")).toBeTruthy();
  });

  it("renders edited-diff item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "diff-1",
        eventId: "ev-1",
        status: "success",
        diffKind: "actual",
        changedFiles: ["src/index.ts"],
        diff: "+hello\n-world",
        diffTruncated: false,
        additions: 1,
        deletions: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("index.ts");
  });

  it("renders explore-activity summary", () => {
    const onOpenReadFile = vi.fn();
    const items: ChatTimelineItem[] = [
      {
        kind: "explore-activity",
        id: "exp-1",
        status: "success",
        fileCount: 1,
        searchCount: 1,
        entries: [
          {
            kind: "read",
            label: "index.ts",
            openPath: "src/index.ts",
            pending: false,
            orderIdx: 1,
          },
          {
            kind: "search",
            label: "Searched Glob (src/**/*.ts)",
            openPath: null,
            pending: false,
            orderIdx: 2,
          },
        ],
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} onOpenReadFile={onOpenReadFile} />);
    });

    expect(container.textContent).toContain("Explored 1 file, 1 search");

    const exploreRoot = container.querySelector("[data-testid='timeline-explore-activity']") as HTMLElement | null;
    expect(exploreRoot).toBeTruthy();
    expect(exploreRoot?.querySelector(".lucide-bot")).toBeNull();

    const entries = container.querySelector("[data-testid='timeline-explore-activity-entries']") as HTMLElement | null;
    expect(entries).toBeTruthy();
    expect(entries?.className).not.toContain("rounded-xl");
    expect(entries?.className).not.toContain("border");

    const readButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "index.ts");
    expect(readButton).toBeTruthy();
    act(() => {
      readButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenReadFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("handles explore-activity items without entries", () => {
    const items = [
      {
        kind: "explore-activity",
        id: "exp-missing-entries",
        status: "success",
        fileCount: 0,
        searchCount: 0,
      },
    ] as unknown as ChatTimelineItem[];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Explored");
    expect(container.textContent).not.toContain("No explore activity");
  });

  it("renders subagent-activity item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-1",
        agentId: "agent-1",
        agentType: "explore",
        toolUseId: "tu-1",
        status: "success",
        description: "Searching codebase",
        lastMessage: "Found 5 files",
        steps: [],
        durationSeconds: 2.5,
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Searching codebase");
  });

  it("handles subagent-activity items without steps", () => {
    const items = [
      {
        kind: "subagent-activity",
        id: "sub-missing-steps",
        agentId: "agent-missing",
        agentType: "explore",
        toolUseId: "tu-missing",
        status: "success",
        description: "Searching codebase",
        lastMessage: "Found something",
        durationSeconds: 1.2,
      },
    ] as unknown as ChatTimelineItem[];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Searching codebase");
    expect(container.textContent).toContain("Found something");
  });

  it("renders subagent explore steps even when prompt text is missing", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-no-prompt",
        agentId: "agent-no-prompt",
        agentType: "explore",
        toolUseId: "tu-no-prompt",
        status: "success",
        description: "",
        lastMessage: "Recovered from transcript",
        steps: [
          {
            toolUseId: "read-step",
            toolName: "Read",
            label: "app.ts",
            openPath: "src/app.ts",
            status: "success",
          },
        ],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Explored 1 file");
    expect(container.textContent).toContain("Recovered from transcript");
    expect(container.textContent).not.toContain("Prompt");
  });

  it("keeps mixed Bash subagent steps out of explore summary", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-mixed-bash",
        agentId: "agent-2",
        agentType: "explore",
        toolUseId: "tu-2",
        status: "success",
        description: "Run mixed commands",
        lastMessage: null,
        steps: [
          {
            toolUseId: "step-1",
            toolName: "Bash",
            label: "Ran ls && rm && ls",
            openPath: null,
            status: "success",
          },
        ],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Ran ls && rm && ls");
    expect(container.textContent).not.toContain("Explored 1 search");
  });

  it("keeps pure explore Bash subagent steps in explore summary", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-explore-bash",
        agentId: "agent-3",
        agentType: "explore",
        toolUseId: "tu-3",
        status: "success",
        description: "Run explore commands",
        lastMessage: null,
        steps: [
          {
            toolUseId: "step-1",
            toolName: "Bash",
            label: "Ran ls | grep src",
            openPath: null,
            status: "success",
          },
        ],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Explored 1 search");
  });

  it("filters legacy activity items from the rendered list", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "activity",
        messageId: "m1",
        durationSeconds: 5,
        introText: "Working on it",
        steps: [{ id: "s1", label: "Step 1", detail: "Reading file" }],
        defaultExpanded: false,
      },
      { kind: "thinking", id: "th-activity-gap", messageId: "m2", content: "Thinking", isStreaming: false },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    const rows = getTimelineRowWrappers();
    expect(rows).toHaveLength(1);
    expect(container.querySelector("[data-testid='timeline-thinking']")).toBeTruthy();
  });

  it("renders plan-file-output item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "plan-file-output",
        id: "plan-1",
        messageId: "m1",
        content: "# Plan\n\nStep 1: Do thing",
        filePath: ".claude/plan.md",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Plan");
  });

  it("shows streaming indicator when thinking placeholder is enabled", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} showThinkingPlaceholder={true} />);
    });
  });

  it("uses denser spacing for compact running timeline rows", () => {
    const runningToolEvent: ChatEvent = {
      id: "ev-running-tool",
      threadId: "t1",
      idx: 1,
      type: "tool.started",
      payload: {
        toolName: "Bash",
        toolUseId: "tu-running",
        summary: "Running ls",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      { kind: "thinking", id: "th-stream", messageId: "m1", content: "Thinking", isStreaming: true },
      {
        kind: "explore-activity",
        id: "exp-running",
        status: "running",
        fileCount: 0,
        searchCount: 1,
        entries: [
          {
            kind: "search",
            label: "Searching Glob (src/**/*.ts)",
            openPath: null,
            pending: true,
            orderIdx: 1,
          },
        ],
      },
      {
        kind: "subagent-activity",
        id: "sub-running",
        agentId: "agent-1",
        agentType: "explore",
        toolUseId: "tu-sub",
        status: "running",
        description: "Searching codebase",
        lastMessage: "Still looking",
        steps: [],
        durationSeconds: null,
      },
      {
        kind: "tool",
        id: "tool-running",
        event: runningToolEvent,
        sourceEvents: [runningToolEvent],
        toolUseId: "tu-running",
        toolName: "Bash",
        shell: "bash",
        command: "ls",
        summary: "Running ls",
        output: null,
        error: null,
        truncated: false,
        durationSeconds: null,
        status: "running",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expectRowSpacingClass(0, "pb-2");
    expectRowSpacingClass(1, "pb-2");
    expectRowSpacingClass(2, "pb-2");
    expectRowSpacingClass(3, "pb-2");
  });

  it("keeps default spacing for non-running timeline rows and messages", () => {
    const finishedToolEvent: ChatEvent = {
      id: "ev-finished-tool",
      threadId: "t1",
      idx: 2,
      type: "tool.finished",
      payload: {
        toolName: "Bash",
        toolUseId: "tu-finished",
        summary: "Ran pwd",
        output: "/tmp",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      makeMessageItem("m1", 1, "Hello"),
      { kind: "thinking", id: "th-done", messageId: "m2", content: "Done thinking", isStreaming: false },
      {
        kind: "explore-activity",
        id: "exp-done",
        status: "success",
        fileCount: 1,
        searchCount: 0,
        entries: [
          {
            kind: "read",
            label: "index.ts",
            openPath: "src/index.ts",
            pending: false,
            orderIdx: 1,
          },
        ],
      },
      {
        kind: "subagent-activity",
        id: "sub-done",
        agentId: "agent-2",
        agentType: "explore",
        toolUseId: "tu-sub-done",
        status: "success",
        description: "Finished searching",
        lastMessage: "Found results",
        steps: [],
        durationSeconds: 1.2,
      },
      {
        kind: "tool",
        id: "tool-done",
        event: finishedToolEvent,
        sourceEvents: [finishedToolEvent],
        toolUseId: "tu-finished",
        toolName: "Bash",
        shell: "bash",
        command: "pwd",
        summary: "Ran pwd",
        output: "/tmp",
        error: null,
        truncated: false,
        durationSeconds: 0.2,
        status: "success",
      },
      makeMessageItem("m2", 2, "World"),
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expectRowSpacingClass(0, "pb-4");
    expectRowSpacingClass(1, "pb-4");
    expectRowSpacingClass(2, "pb-4");
    expectRowSpacingClass(3, "pb-4");
    expectRowSpacingClass(4, "pb-4");
    expectRowSpacingClass(5, "pb-4");
  });

  it("handles multiple mixed items", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m1", "user", "Hi", 1) },
      { kind: "thinking", id: "th1", messageId: "m2", content: "hmm", isStreaming: false },
      { kind: "message", message: makeMessage("m2", "assistant", "Hello!", 2) },
      { kind: "error", id: "err1", message: "Oops", createdAt: "2026-01-01T00:00:00Z" },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Hi");
    expect(container.textContent).toContain("Hello!");
  });

  it("does not force-scroll when new items arrive after user scrolls up", () => {
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)] });
    setScrollMetrics();
    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);

    triggerScroll(560);
    triggerScroll(520);
    scrollToIndexMock.mockClear();

    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)] });

    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it("auto-follows when user remains at bottom and new items arrive", () => {
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)] });
    setScrollMetrics();
    scrollToIndexMock.mockClear();

    triggerScroll(560);
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)] });

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
  });

  it("does not snap to bottom on scroll end after user scrolls up", () => {
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)] });
    setScrollMetrics();
    scrollToIndexMock.mockClear();

    triggerScroll(560);
    triggerScroll(520);
    triggerScrollEnd();

    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it("does not auto-follow when thinking placeholder toggles while user is away from bottom", () => {
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)] });
    setScrollMetrics();
    triggerScroll(560);
    triggerScroll(520);
    scrollToIndexMock.mockClear();

    mountChatMessageList({
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      showThinkingPlaceholder: true,
    });

    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it("auto-follows when the last message content grows without adding items", () => {
    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        { kind: "message", message: makeMessage("m2", "assistant", "Start", 2), renderHint: "markdown" },
      ],
    });
    setScrollMetrics();
    scrollToIndexMock.mockClear();

    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        {
          kind: "message",
          message: makeMessage("m2", "assistant", "Start\n\n> quote\n\n```ts\nconst x = 1;\n```", 2),
          renderHint: "markdown",
        },
      ],
    });

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(1, { align: "end" });
  });

  it("does not auto-follow same-item markdown growth after user scrolls up", () => {
    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        { kind: "message", message: makeMessage("m2", "assistant", "Start", 2), renderHint: "markdown" },
      ],
    });
    setScrollMetrics();
    triggerScroll(560);
    triggerScroll(520);
    scrollToIndexMock.mockClear();

    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        {
          kind: "message",
          message: makeMessage("m2", "assistant", "Start\n\n> quote\n\n```ts\nconst x = 1;\n```", 2),
          renderHint: "markdown",
        },
      ],
    });

    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });
});
