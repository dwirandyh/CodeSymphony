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

vi.mock("../../lib/debugLog", () => ({
  debugLog: vi.fn(),
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
      messageId: "m2",
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

  it("renders explore-activity item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "explore-activity",
        id: "exp-1",
        status: "success",
        fileCount: 3,
        searchCount: 1,
        entries: [
          { kind: "read", label: "src/index.ts", openPath: "src/index.ts", pending: false, orderIdx: 0 },
        ],
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("index.ts");
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

  it("renders activity item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "activity",
        messageId: "m1",
        durationSeconds: 5,
        introText: "Working on it",
        steps: [{ id: "s1", label: "Step 1", detail: "Reading file" }],
        defaultExpanded: false,
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container).toBeTruthy();
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

  it("shows streaming indicator when isStreaming", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} isStreaming={true} />);
    });
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
