import { act, forwardRef, useImperativeHandle, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { parsePatchFiles } from "@pierre/diffs";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { ChatTimelineItem } from "./chat-message-list";
import { MarkdownBody, ChatMessageList } from "./chat-message-list";
import { AssistantContent } from "./chat-message-list/AssistantContent";
import { TimelineItem } from "./chat-message-list/TimelineItem";
import type { TimelineCtx } from "./chat-message-list/ChatMessageList.types";
import { getTimelineItemKey } from "./chat-message-list/toolEventUtils";

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn().mockReturnValue([]),
  SPLIT_WITH_NEWLINES: /\r?\n/,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="file-diff">FileDiff</div>,
}));

const { scrollToIndexMock, scrollToMock, latestVListPropsRef, latestScrollStateRef, latestVListMountIdRef, vlistMountCounterRef } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn(),
  scrollToMock: vi.fn(),
  latestVListPropsRef: { current: null as Record<string, any> | null },
  latestScrollStateRef: {
    current: {
      cache: { key: "default-cache" },
      scrollOffset: 0,
      scrollSize: 0,
      viewportSize: 0,
    },
  },
  latestVListMountIdRef: { current: 0 },
  vlistMountCounterRef: { current: 0 },
}));

class MockResizeObserver {
  disconnected = false;
  observe = vi.fn();
  disconnect = vi.fn(() => {
    this.disconnected = true;
  });
  unobserve = vi.fn();

  constructor(public callback: ResizeObserverCallback) {}
}

const resizeObserverInstances: MockResizeObserver[] = [];

vi.mock("virtua", () => ({
  VList: forwardRef(({ children, data, ...props }: any, ref) => {
    const [mountId] = useState(() => {
      vlistMountCounterRef.current += 1;
      latestScrollStateRef.current.scrollOffset = 0;
      return vlistMountCounterRef.current;
    });
    latestVListPropsRef.current = props;
    latestVListMountIdRef.current = mountId;
    useImperativeHandle(ref, () => ({
      scrollToIndex: scrollToIndexMock,
      scrollTo(offset: number) {
        latestScrollStateRef.current.scrollOffset = offset;
        scrollToMock(offset);
      },
      get cache() {
        return latestScrollStateRef.current.cache;
      },
      get scrollOffset() {
        return latestScrollStateRef.current.scrollOffset;
      },
      get scrollSize() {
        return latestScrollStateRef.current.scrollSize;
      },
      get viewportSize() {
        return latestScrollStateRef.current.viewportSize;
      },
    }));
    const renderedChildren = typeof children === "function"
      ? Array.from(data ?? []).map((entry, index) => children(entry, index))
      : children;
    return <div data-testid="vlist">{renderedChildren}</div>;
  }),
}));

vi.mock("../../lib/renderDebug", () => ({
  isRenderDebugEnabled: () => false,
  pushRenderDebug: vi.fn(),
  copyRenderDebugLog: vi.fn(),
}));


vi.mock("react-markdown", () => ({
  default: ({ children, components }: any) => {
    const content = typeof children === "string" ? children : String(children ?? "");
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const nodes: any[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = linkPattern.exec(content)) !== null) {
      if (match.index > lastIndex) {
        nodes.push(content.slice(lastIndex, match.index));
      }

      const Anchor = components?.a ?? "a";
      nodes.push(
        <Anchor key={`link-${match.index}`} href={match[2]}>
          {match[1]}
        </Anchor>,
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      nodes.push(content.slice(lastIndex));
    }

    return <div data-testid="markdown">{nodes.length > 0 ? nodes : children}</div>;
  },
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
  vi.mocked(parsePatchFiles).mockReset();
  vi.mocked(parsePatchFiles).mockReturnValue([]);
  scrollToIndexMock.mockReset();
  scrollToMock.mockReset();
  latestVListPropsRef.current = null;
  latestVListMountIdRef.current = 0;
  vlistMountCounterRef.current = 0;
  resizeObserverInstances.length = 0;
  latestScrollStateRef.current = {
    cache: { key: "default-cache" },
    scrollOffset: 0,
    scrollSize: 0,
    viewportSize: 0,
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
    const observer = new MockResizeObserver(callback);
    resizeObserverInstances.push(observer);
    return observer;
  }));
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

function makeToolItem(id: string, summary = "summary", output = "output"): ChatTimelineItem {
  return {
    kind: "tool",
    id,
    event: null,
    summary,
    output,
    status: "running",
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

function expectRowPaddingClass(itemIndex: number, className: "pt-3") {
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
  latestScrollStateRef.current.scrollSize = scrollHeight;
  latestScrollStateRef.current.viewportSize = clientHeight;
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
  latestScrollStateRef.current.scrollOffset = offset;
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

function triggerResizeObservers() {
  act(() => {
    resizeObserverInstances.forEach((observer) => {
      if (observer.disconnected) {
        return;
      }
      observer.callback([], observer as unknown as ResizeObserver);
    });
  });
}

function triggerWheel(deltaY: number) {
  const wrapper = container.querySelector("[data-testid='chat-scroll']");
  if (!(wrapper instanceof HTMLDivElement)) {
    throw new Error("chat-scroll wrapper not found");
  }

  act(() => {
    wrapper.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY }));
  });
}

function clickFirstSummary() {
  const summary = container.querySelector("summary");
  if (!(summary instanceof HTMLElement)) {
    throw new Error("summary element not found");
  }

  act(() => {
    summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function makeTimelineCtx(overrides: Partial<TimelineCtx> = {}): TimelineCtx {
  return {
    rawOutputMessageIds: new Set(),
    copiedMessageId: null,
    copiedDebug: false,
    renderDebugEnabled: false,
    toggleRawOutput: vi.fn(),
    copyOutput: vi.fn(),
    copyDebugLog: vi.fn(),
    onOpenReadFile: vi.fn(),
    worktreePath: "/repo",
    toolExpandedById: new Map(),
    setToolExpandedById: vi.fn(),
    editedExpandedById: new Map(),
    setEditedExpandedById: vi.fn(),
    exploreActivityExpandedById: new Map(),
    setExploreActivityExpandedById: vi.fn(),
    subagentExpandedById: new Map(),
    setSubagentExpandedById: vi.fn(),
    subagentPromptExpandedById: new Map(),
    setSubagentPromptExpandedById: vi.fn(),
    subagentExploreExpandedById: new Map(),
    setSubagentExploreExpandedById: vi.fn(),
    lastRenderSignatureByMessageIdRef: { current: new Map() },
    ...overrides,
  };
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

describe("AssistantContent", () => {
  it("collapses trailing incomplete markdown links while streaming", () => {
    act(() => {
      root.render(
        <AssistantContent
          content={"Referensi:\n[plan.md](/repo/.claude/plans/rede"}
          renderHint="markdown"
          isCompleted={false}
        />,
      );
    });

    expect(container.textContent).toContain("Referensi:\nplan.md");
    expect(container.textContent).not.toContain("[plan.md]");
    expect(container.textContent).not.toContain("](/repo");
  });

  it("preserves completed markdown links", () => {
    act(() => {
      root.render(
        <AssistantContent
          content={"Referensi:\n[plan.md](/repo/.claude/plans/redeem-plan.md)"}
          renderHint="markdown"
          isCompleted={true}
        />,
      );
    });

    const completedLink = container.querySelector("a");
    expect(completedLink?.textContent).toBe("plan.md");
    expect(completedLink?.getAttribute("href")).toBe("/repo/.claude/plans/redeem-plan.md");
  });

  it("opens worktree file links in the internal editor flow", () => {
    const onOpenFilePath = vi.fn();

    act(() => {
      root.render(
        <AssistantContent
          content={"Lihat file ini: [Shopkeeper2025RedeemShopkeeperFragment.java](/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android/app/src/main/java/com/algostudio/marketingprogram/module/shopkeeper/view/fragment/shopkeeper_side/shopkeeper_tab/Shopkeeper2025RedeemShopkeeperFragment.java#L407)"}
          renderHint="markdown"
          isCompleted={true}
          onOpenFilePath={onOpenFilePath}
          worktreePath="/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android"
        />,
      );
    });

    const fileLink = container.querySelector("a") as HTMLAnchorElement | null;
    expect(fileLink).toBeTruthy();

    act(() => {
      fileLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onOpenFilePath).toHaveBeenCalledWith(
      "app/src/main/java/com/algostudio/marketingprogram/module/shopkeeper/view/fragment/shopkeeper_side/shopkeeper_tab/Shopkeeper2025RedeemShopkeeperFragment.java#L407",
    );
  });

  it("keeps absolute file-system links inside the internal editor flow even when the root path differs", () => {
    const onOpenFilePath = vi.fn();
    const sameOriginUrl = `${window.location.origin}/Users/dwirandyh/Work/algostudio/marketing-2019-android/app/src/main/java/com/algostudio/marketingprogram/module/shopkeeper/presenter/SummaryRedeemShopkeeperPresenter.java#L53`;

    act(() => {
      root.render(
        <AssistantContent
          content={`Buka ini: [SummaryRedeemShopkeeperPresenter.java](${sameOriginUrl})`}
          renderHint="markdown"
          isCompleted={true}
          onOpenFilePath={onOpenFilePath}
          worktreePath="/Users/dwirandyh/Work/algostudio/philips-marketing-2019-android"
        />,
      );
    });

    const fileLink = container.querySelector("a") as HTMLAnchorElement | null;
    expect(fileLink).toBeTruthy();

    act(() => {
      fileLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onOpenFilePath).toHaveBeenCalledWith(
      "/Users/dwirandyh/Work/algostudio/marketing-2019-android/app/src/main/java/com/algostudio/marketingprogram/module/shopkeeper/presenter/SummaryRedeemShopkeeperPresenter.java#L53",
    );
  });
});

describe("ChatMessageList", () => {
  it("keeps timeline keys stable while message content streams", () => {
    const item: Extract<ChatTimelineItem, { kind: "message" }> = {
      kind: "message",
      message: makeMessage("msg-1", "user", "hello", 1),
      isCompleted: false,
    };

    const streamed: Extract<ChatTimelineItem, { kind: "message" }> = {
      ...item,
      message: { ...item.message, content: "hello world" },
      isCompleted: true,
    };

    expect(getTimelineItemKey(item)).toBe(getTimelineItemKey(streamed));
  });

  it("keeps tool timeline keys stable while output changes", () => {
    const item: Extract<ChatTimelineItem, { kind: "tool" }> = {
      kind: "tool",
      id: "tool-1",
      event: null,
      summary: "summary",
      output: "one",
      status: "running",
    };
    const updated: Extract<ChatTimelineItem, { kind: "tool" }> = {
      ...item,
      summary: "summary expanded",
      output: "output expanded",
      status: "success",
    };

    expect(getTimelineItemKey(item)).toBe(getTimelineItemKey(updated));
  });

  const baseProps = {
    items: [] as ChatTimelineItem[],
  };

  it("renders without crash for empty items", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} />);
    });
    expect(container).toBeTruthy();
  });

  it("clears rendered timeline rows when items transition from non-empty to empty", () => {
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
    expect(container.querySelector("[data-testid='timeline-edited-diff']")).toBeTruthy();

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={[]} />);
    });

    expect(container.querySelector("[data-testid='timeline-edited-diff']")).toBeNull();
    expect(container.textContent).toContain("This thread is empty");
  });

  it("renders a loading state for existing threads while history is fetching", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} emptyState="loading-thread" />);
    });

    expect(container.querySelector("[data-testid='loading-thread-skeleton']")).toBeTruthy();
  });

  it("renders a distinct empty state for a newly created thread", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} emptyState="new-thread-empty" />);
    });

    expect(container.textContent).toContain("New thread ready");
    expect(container.textContent).toContain("Start with a task, bug, or question");
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

  it("applies top padding only to the first rendered row so the spacing scrolls with content", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m1", "user", "First", 1) },
      { kind: "message", message: makeMessage("m2", "assistant", "Second", 2), renderHint: "markdown" },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    const rows = getTimelineRowWrappers();
    expect(rows).toHaveLength(2);
    expectRowPaddingClass(0, "pt-3");
    expect(rows[1]?.className).not.toContain("pt-3");
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

  it("keeps the render key stable when an assistant message grows in place", () => {
    const initialKey = getTimelineItemKey({
      kind: "message",
      message: makeMessage("m2", "assistant", "Start", 2),
      renderHint: "markdown",
      isCompleted: false,
    });
    const updatedKey = getTimelineItemKey({
      kind: "message",
      message: makeMessage("m2", "assistant", "Start\n\n- item", 2),
      renderHint: "markdown",
      isCompleted: false,
    });

    expect(updatedKey).toBe(initialKey);
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

  it("shows only the shimmer placeholder when enabled", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} showThinkingPlaceholder={true} />);
    });
    expect(container.querySelector("[data-testid='thinking-placeholder']")).toBeTruthy();
    expect(container.textContent).toContain("Thinking...");
  });

  it("keeps post-plan activity visible when thinking placeholder is enabled", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "plan-file-output",
        id: "plan-1",
        messageId: "m-plan",
        content: "# Plan\n\nStep 1: Update src/app.ts",
        filePath: ".claude/plans/my-plan.md",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        kind: "edited-diff",
        id: "diff-1",
        eventId: "ev-edit-1",
        status: "running",
        diffKind: "actual",
        changedFiles: ["src/app.ts"],
        diff: "+const value = 2;\n-const value = 1;",
        diffTruncated: false,
        additions: 1,
        deletions: 1,
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} showThinkingPlaceholder={true} />);
    });

    const rows = getTimelineRowWrappers();
    expect(rows).toHaveLength(3);
    expect(container.textContent).toContain("Plan");
    expect(container.textContent).toContain("app.ts");
    expect(container.querySelector("[data-testid='timeline-plan-file-output']")).toBeTruthy();
    expect(container.querySelector("[data-testid='timeline-edited-diff']")).toBeTruthy();
    expect(container.querySelector("[data-testid='thinking-placeholder']")).toBeTruthy();
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
    expect(container.textContent).not.toContain("tool.finished");
    expect(container.querySelector("[data-testid='timeline-tool']")).toBeTruthy();
    expect(container.querySelector("details")).toBeTruthy();
  });

  it("renders collapsible MCP tool item with output", () => {
    const event: ChatEvent = {
      id: "ev-mcp",
      threadId: "t1",
      idx: 1,
      type: "tool.finished",
      payload: {
        toolName: "mcp__filesystem__read_file",
        toolUseId: "mcp-1",
        summary: "Completed mcp__filesystem__read_file",
        output: "# README",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-mcp-1",
        event,
        sourceEvents: [event],
        toolUseId: "mcp-1",
        toolName: "mcp__filesystem__read_file",
        output: "# README",
        truncated: false,
        durationSeconds: 0.4,
        status: "success",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Ran mcp__filesystem__read_file");
    expect(container.textContent).not.toContain("Ran mcp__filesystem__read_file · Completed mcp__filesystem__read_file");
    expect(container.textContent).not.toContain("# README");
    expect(container.textContent).not.toContain("tool.finished");
    expect(container.textContent).not.toContain("Raw payload");
    expect(container.querySelector("[data-testid='timeline-tool-payload-details']")).toBeNull();
    expect(container.querySelector("[data-testid='timeline-tool']")).toBeTruthy();
    expect(container.querySelector("details")).toBeTruthy();

    clickFirstSummary();
    expect(container.textContent).toContain("# README");
  });

  it("renders running MCP tool item with running label", () => {
    const event: ChatEvent = {
      id: "ev-mcp-running",
      threadId: "t1",
      idx: 1,
      type: "tool.started",
      payload: {
        toolName: "mcp__filesystem__read_file",
        toolUseId: "mcp-run-1",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-mcp-run-1",
        event,
        sourceEvents: [event],
        toolUseId: "mcp-run-1",
        toolName: "mcp__filesystem__read_file",
        durationSeconds: 0.2,
        status: "running",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Running mcp__filesystem__read_file");
    expect(container.textContent).not.toContain("tool.started");
    expect(container.textContent).not.toContain("Raw payload");
    expect(container.querySelector("[data-testid='timeline-tool-payload-details']")).toBeNull();
  });

  it("renders failed MCP tool item like failed command cards", () => {
    const event: ChatEvent = {
      id: "ev-mcp-failed",
      threadId: "t1",
      idx: 1,
      type: "tool.finished",
      payload: {
        toolName: "mcp__filesystem__read_file",
        toolUseId: "mcp-failed-1",
        summary: "Failed mcp__filesystem__read_file",
        error: "Exit code 1\n\nMCP request failed",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-mcp-failed-1",
        event,
        sourceEvents: [event],
        toolUseId: "mcp-failed-1",
        toolName: "mcp__filesystem__read_file",
        error: "Exit code 1\n\nMCP request failed",
        truncated: false,
        durationSeconds: 1,
        status: "failed",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Failed mcp__filesystem__read_file");
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Failed mcp__filesystem__read_file");
    expect(container.textContent).not.toContain("Exit code 1");
    expect(container.textContent).not.toContain("MCP request failed");
    expect(container.querySelector("[data-testid='timeline-tool']")).toBeTruthy();
    expect(container.querySelector("svg.lucide-circle-x")).toBeTruthy();
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

  it("strips truncated diff markers before parsing edited-diff items", () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
      "... [diff truncated]",
    ].join("\n");

    const items: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "diff-truncated",
        eventId: "ev-truncated",
        status: "success",
        diffKind: "actual",
        changedFiles: ["src/index.ts"],
        diff,
        diffTruncated: true,
        additions: 1,
        deletions: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(vi.mocked(parsePatchFiles)).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("... [diff truncated]");

    clickFirstSummary();
    expect(vi.mocked(parsePatchFiles)).toHaveBeenCalledWith([
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n"));
    expect(container.textContent).toContain("... [diff truncated]");
  });

  it("renders worktree diff items as command changes instead of manual edits", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "diff-2",
        eventId: "ev-2",
        changeSource: "worktree-diff",
        status: "success",
        diffKind: "actual",
        changedFiles: ["app/build.gradle.kts"],
        diff: "+versionCode = 272\n-versionCode = 271",
        diffTruncated: false,
        additions: 1,
        deletions: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("Command changed build.gradle.kts");
    expect(container.textContent).not.toContain("Edited build.gradle.kts");
  });

  it("keeps delete-only line removals labeled as edited changes", () => {
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "SharedRewardPackageAdapter.java",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "deletion", additions: [], deletions: [{ lineNumber: 1, content: "-line" }] }] }],
      }],
    }] as never);

    const items: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "diff-delete-line",
        eventId: "ev-delete-line",
        status: "success",
        diffKind: "actual",
        changedFiles: ["SharedRewardPackageAdapter.java"],
        diff: [
          "diff --git a/SharedRewardPackageAdapter.java b/SharedRewardPackageAdapter.java",
          "--- a/SharedRewardPackageAdapter.java",
          "+++ b/SharedRewardPackageAdapter.java",
          "@@ -1 +0,0 @@",
          "-line",
        ].join("\n"),
        diffTruncated: false,
        additions: 0,
        deletions: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Edited SharedRewardPackageAdapter.java");
    expect(container.textContent).not.toContain("Deleted SharedRewardPackageAdapter.java");
  });

  it("labels actual file deletions as deleted", () => {
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "SharedRewardPackageAdapter.java",
        type: "deleted",
        hunks: [{ hunkContent: [{ type: "deletion", additions: [], deletions: [{ lineNumber: 1, content: "-line" }] }] }],
      }],
    }] as never);

    const items: ChatTimelineItem[] = [
      {
        kind: "edited-diff",
        id: "diff-delete-file",
        eventId: "ev-delete-file",
        status: "success",
        diffKind: "actual",
        changedFiles: ["SharedRewardPackageAdapter.java"],
        diff: [
          "diff --git a/SharedRewardPackageAdapter.java b/SharedRewardPackageAdapter.java",
          "deleted file mode 100644",
          "--- a/SharedRewardPackageAdapter.java",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-line",
        ].join("\n"),
        diffTruncated: false,
        additions: 0,
        deletions: 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Deleted SharedRewardPackageAdapter.java");
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
    expect(container.querySelector("[data-testid='timeline-explore-activity-entries']")).toBeNull();
    expect(onOpenReadFile).not.toHaveBeenCalled();
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
    expect(container.textContent).not.toContain("Found something");
  });

  it("renders skill subagent items with skill-style header and body", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "skill-1",
        agentId: "agent-skill",
        agentType: "Task",
        toolUseId: "tu-skill",
        status: "success",
        description: "Load browser-verification skill for the current task",
        lastMessage: "Successfully loaded skill\n1 tool allowed",
        steps: [],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Skill(browser-verification)");
    expect(container.textContent).not.toContain("Successfully loaded skill");
    expect(container.textContent).not.toContain("1 tool allowed");
    expect(container.textContent).not.toContain("Prompt");
  });

  it("hides skill tool count when it is unavailable", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "skill-2",
        agentId: "agent-skill-2",
        agentType: "Task",
        toolUseId: "tu-skill-2",
        status: "success",
        description: "Load browser-verification skill for the current task",
        lastMessage: "Successfully loaded skill",
        steps: [],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Skill(browser-verification)");
    expect(container.textContent).not.toContain("tool allowed");
    expect(container.textContent).not.toContain("tools allowed");
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

    expect(container.textContent).toContain("Done");
    expect(container.textContent).not.toContain("Prompt");
    expect(container.textContent).not.toContain("Recovered from transcript");
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

    expect(container.textContent).not.toContain("Ran ls && rm && ls");
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

    expect(container.textContent).toContain("Done");
  });

  it("renders successful non-explore subagent steps without a status icon", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-success-step",
        agentId: "agent-4",
        agentType: "Task",
        toolUseId: "tu-4",
        status: "success",
        description: "Check repository state",
        lastMessage: null,
        steps: [
          {
            toolUseId: "step-success",
            toolName: "Bash",
            label: "Ran git status",
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

    expect(container.textContent).not.toContain("Ran git status");
    expect(container.querySelector(".lucide-circle-check")).toBeNull();
    expect(container.querySelector(".lucide-loader-2")).toBeNull();
    expect(container.querySelector(".lucide-circle-x")).toBeNull();
  });

  it("renders failed non-explore subagent steps with the same failure icon style as main tools", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "subagent-activity",
        id: "sub-failed-step",
        agentId: "agent-5",
        agentType: "Task",
        toolUseId: "tu-5",
        status: "success",
        description: "Check repository state",
        lastMessage: null,
        steps: [
          {
            toolUseId: "step-failed",
            toolName: "Bash",
            label: "Ran git status",
            openPath: null,
            status: "failed",
          },
        ],
        durationSeconds: 1,
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).not.toContain("Ran git status");
    expect(container.querySelector(".lucide-circle-x")).toBeNull();
    expect(container.querySelector(".lucide-loader-2")).toBeNull();
  });

  it("renders activity items in the timeline", () => {
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

    const rows = getTimelineRowWrappers();
    expect(rows).toHaveLength(1);
    expect(container.querySelector("[data-testid='timeline-activity']")).toBeTruthy();
    expect(container.textContent).toContain("Working on it");
    expect(container.textContent).not.toContain("Step 1");
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

  it("renders footer content after the timeline items", () => {
    const items: ChatTimelineItem[] = [
      makeMessageItem("m1", 1),
      {
        kind: "plan-file-output",
        id: "plan-1",
        messageId: "m2",
        content: "# Plan\n\nStep 1",
        filePath: ".claude/plans/my-plan.md",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];

    act(() => {
      root.render(
        <ChatMessageList
          {...baseProps}
          items={items}
          footer={<div data-testid="plan-footer">Plan decision footer</div>}
        />,
      );
    });

    const rows = getTimelineRowWrappers();
    expect(rows).toHaveLength(3);
    expect(rows[rows.length - 1]?.querySelector("[data-testid='plan-footer']")).toBeTruthy();
  });

  it("shows streaming indicator when thinking placeholder is enabled", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} showThinkingPlaceholder={true} />);
    });
  });

  it("renders skill tool items with skill-style header and body", () => {
    const skillStartedEvent: ChatEvent = {
      id: "ev-skill-started",
      threadId: "t1",
      idx: 1,
      type: "tool.started",
      payload: {
        toolName: "Skill",
        toolUseId: "tu-skill-running",
        skillName: "finly-architecture",
        summary: "Running skill",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const skillFinishedEvent: ChatEvent = {
      id: "ev-skill-finished",
      threadId: "t1",
      idx: 2,
      type: "tool.finished",
      payload: {
        toolName: "Skill",
        toolUseId: "tu-skill-running",
        skillName: "finly-architecture",
        summary: "Completed Skill",
        output: "Successfully loaded skill\n1 tool allowed",
      },
      createdAt: "2026-01-01T00:00:01Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-skill",
        event: skillFinishedEvent,
        sourceEvents: [skillStartedEvent, skillFinishedEvent],
        toolUseId: "tu-skill-running",
        toolName: "Skill",
        summary: "Completed Skill",
        output: "Successfully loaded skill\n1 tool allowed",
        error: null,
        truncated: false,
        durationSeconds: 1,
        status: "success",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Skill(finly-architecture)");
    expect(container.textContent).not.toContain("Successfully loaded skill");
    expect(container.textContent).not.toContain("1 tool allowed");
    expect(container.textContent).not.toContain("tool.finished · Completed Skill");
    expect(container.textContent).not.toContain("Raw payload");
    expect(container.querySelector("[data-testid='timeline-tool-payload-details']")).toBeNull();
  });

  it("renders AskUserQuestion tool items with paired question and answer content", () => {
    const askStartedEvent: ChatEvent = {
      id: "ev-ask-started",
      threadId: "t1",
      idx: 1,
      type: "tool.started",
      payload: {
        toolName: "AskUserQuestion",
        toolUseId: "ask-1",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const questionRequestedEvent: ChatEvent = {
      id: "ev-question-requested",
      threadId: "t1",
      idx: 2,
      type: "question.requested",
      payload: {
        requestId: "ask-1",
        questions: [
          { question: "Avatar URL?" },
          { question: "Retry upload?" },
        ],
      },
      createdAt: "2026-01-01T00:00:01Z",
    };
    const questionAnsweredEvent: ChatEvent = {
      id: "ev-question-answered",
      threadId: "t1",
      idx: 3,
      type: "question.answered",
      payload: {
        requestId: "ask-1",
        answers: {
          "Avatar URL?": "Use upload_url",
          "Retry upload?": "No retry",
        },
      },
      createdAt: "2026-01-01T00:00:02Z",
    };
    const askFinishedEvent: ChatEvent = {
      id: "ev-ask-finished",
      threadId: "t1",
      idx: 4,
      type: "tool.finished",
      payload: {
        toolName: "AskUserQuestion",
        toolUseId: "ask-1",
        summary: "Asked 2 Questions",
      },
      createdAt: "2026-01-01T00:00:03Z",
    };
    const items: ChatTimelineItem[] = [
      {
        kind: "tool",
        id: "tool-ask",
        event: askFinishedEvent,
        sourceEvents: [askStartedEvent, questionRequestedEvent, questionAnsweredEvent, askFinishedEvent],
        toolUseId: "ask-1",
        toolName: "AskUserQuestion",
        summary: "Asked 2 Questions",
        output: null,
        error: null,
        truncated: false,
        durationSeconds: 1,
        status: "success",
      },
    ];

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });

    expect(container.textContent).toContain("Asked 2 Questions");
    expect(container.textContent).not.toContain("Avatar URL?");
    expect(container.textContent).not.toContain("Use upload_url");
    expect(container.textContent).not.toContain("Retry upload?");
    expect(container.textContent).not.toContain("No retry");
    expect(container.textContent).not.toContain("AskUserQuestion · Completed AskUserQuestion");

    clickFirstSummary();
    expect(container.textContent).toContain("Avatar URL?");
    expect(container.textContent).toContain("Use upload_url");
    expect(container.textContent).toContain("Retry upload?");
    expect(container.textContent).toContain("No retry");
  });

  it("renders expanded tool details only when the tool is marked open in context", () => {
    const event: ChatEvent = {
      id: "ev-tool-expanded",
      threadId: "t1",
      idx: 1,
      type: "tool.finished",
      payload: {
        toolName: "mcp__filesystem__read_file",
        toolUseId: "tool-expanded",
        summary: "Completed mcp__filesystem__read_file",
        output: "# README",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const item: ChatTimelineItem = {
      kind: "tool",
      id: "tool-expanded",
      event,
      sourceEvents: [event],
      toolUseId: "tool-expanded",
      toolName: "mcp__filesystem__read_file",
      output: "# README",
      truncated: false,
      durationSeconds: 0.4,
      status: "success",
    };

    act(() => {
      root.render(<TimelineItem item={item} ctx={makeTimelineCtx()} />);
    });
    expect(container.textContent).not.toContain("# README");

    act(() => {
      root.render(
        <TimelineItem
          item={item}
          ctx={makeTimelineCtx({ toolExpandedById: new Map([["tool-expanded", true]]) })}
        />,
      );
    });
    expect(container.textContent).toContain("# README");
  });

  it("parses edited diffs only when the diff card is expanded", () => {
    const diff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
      "... [diff truncated]",
    ].join("\n");
    const item: ChatTimelineItem = {
      kind: "edited-diff",
      id: "diff-expanded",
      eventId: "ev-diff-expanded",
      status: "success",
      diffKind: "actual",
      changedFiles: ["src/index.ts"],
      diff,
      diffTruncated: true,
      additions: 1,
      deletions: 1,
      createdAt: "2026-01-01T00:00:00Z",
    };

    act(() => {
      root.render(<TimelineItem item={item} ctx={makeTimelineCtx()} />);
    });
    expect(vi.mocked(parsePatchFiles)).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("... [diff truncated]");

    act(() => {
      root.render(
        <TimelineItem
          item={item}
          ctx={makeTimelineCtx({ editedExpandedById: new Map([["diff-expanded", true]]) })}
        />,
      );
    });

    expect(vi.mocked(parsePatchFiles)).toHaveBeenCalledWith([
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n"));
    expect(container.textContent).toContain("... [diff truncated]");
  });

  it("renders expanded AskUserQuestion content only when the tool is open", () => {
    const askStartedEvent: ChatEvent = {
      id: "ev-ask-open-started",
      threadId: "t1",
      idx: 1,
      type: "tool.started",
      payload: {
        toolName: "AskUserQuestion",
        toolUseId: "ask-open-1",
      },
      createdAt: "2026-01-01T00:00:00Z",
    };
    const questionRequestedEvent: ChatEvent = {
      id: "ev-ask-open-requested",
      threadId: "t1",
      idx: 2,
      type: "question.requested",
      payload: {
        requestId: "ask-open-1",
        questions: [{ question: "Avatar URL?" }],
      },
      createdAt: "2026-01-01T00:00:01Z",
    };
    const questionAnsweredEvent: ChatEvent = {
      id: "ev-ask-open-answered",
      threadId: "t1",
      idx: 3,
      type: "question.answered",
      payload: {
        requestId: "ask-open-1",
        answers: {
          "Avatar URL?": "Use upload_url",
        },
      },
      createdAt: "2026-01-01T00:00:02Z",
    };
    const askFinishedEvent: ChatEvent = {
      id: "ev-ask-open-finished",
      threadId: "t1",
      idx: 4,
      type: "tool.finished",
      payload: {
        toolName: "AskUserQuestion",
        toolUseId: "ask-open-1",
        summary: "Asked 1 Question",
      },
      createdAt: "2026-01-01T00:00:03Z",
    };
    const item: ChatTimelineItem = {
      kind: "tool",
      id: "tool-ask-open",
      event: askFinishedEvent,
      sourceEvents: [askStartedEvent, questionRequestedEvent, questionAnsweredEvent, askFinishedEvent],
      toolUseId: "ask-open-1",
      toolName: "AskUserQuestion",
      summary: "Asked 1 Question",
      output: null,
      error: null,
      truncated: false,
      durationSeconds: 1,
      status: "success",
    };

    act(() => {
      root.render(<TimelineItem item={item} ctx={makeTimelineCtx()} />);
    });
    expect(container.textContent).toContain("Asked 1 Question");
    expect(container.textContent).not.toContain("Avatar URL?");

    act(() => {
      root.render(
        <TimelineItem
          item={item}
          ctx={makeTimelineCtx({ toolExpandedById: new Map([["tool-ask-open", true]]) })}
        />,
      );
    });
    expect(container.textContent).toContain("Avatar URL?");
    expect(container.textContent).toContain("Use upload_url");
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
  });

  it("handles multiple mixed items", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m1", "user", "Hi", 1) },
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

  it("keeps bottom-follow active when a fresh mount emits an initial top scroll before hydration completes", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
    });
    setScrollMetrics();
    scrollToIndexMock.mockClear();

    triggerScroll(0);

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
  });

  it("enables virtualizer shift mode so prepended history keeps the viewport stable", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      hasOlderHistory: true,
    });

    expect(latestVListPropsRef.current?.shift).toBe(true);
  });

  it("keeps virtualizer shift mode off until older-history pagination is active", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
    });

    expect(latestVListPropsRef.current?.shift).toBe(false);
  });

  it("keeps head and tail rows mounted and expands overscan while older history is active", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: Array.from({ length: 14 }, (_, index) => makeMessageItem(`m${index + 1}`, index + 1)),
      hasOlderHistory: true,
    });

    expect(latestVListPropsRef.current?.bufferSize).toBe(720);
    expect(latestVListPropsRef.current?.keepMounted).toEqual([0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13]);
  });

  it("bottom-aligns short threads so the newest message remains the first visible content", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
    });

    expect(latestVListPropsRef.current?.style).toMatchObject({
      display: "flex",
      flexDirection: "column",
      justifyContent: "flex-end",
    });
  });

  it("requests older history when the user scrolls back near the top", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("requests older history before the viewport fully reaches the hard top threshold while the user keeps scrolling upward", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(720);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("requests older history when the user wheels upward from a short bottom-anchored thread", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 400, clientHeight: 900 });

    triggerWheel(-48);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("does not ignore the first real upward scroll to the top after a fresh refresh-style mount", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    latestScrollStateRef.current.scrollOffset = 960;
    triggerWheel(-48);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(0);

    triggerScroll(0);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("re-arms near-top pagination immediately when the older-history handler skips starting a request", async () => {
    const onLoadOlderHistory = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined);
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);

    await act(async () => {
      await Promise.resolve();
    });

    triggerWheel(-48);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("does not immediately request another older page until the user scrolls away from the top threshold", async () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);
    triggerScroll(100);
    triggerScrollEnd();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });

    triggerScroll(960);
    triggerScroll(80);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("re-arms near-top pagination after a page load completes without requiring a downward reset scroll", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: true,
      onLoadOlderHistory,
    });

    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: false,
      onLoadOlderHistory,
    });

    triggerScroll(72);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("re-arms the next older-page request when prepend settles between the top threshold and rearm threshold", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    latestScrollStateRef.current.scrollOffset = 640;
    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: true,
      onLoadOlderHistory,
    });

    latestScrollStateRef.current.scrollOffset = 640;
    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: false,
      onLoadOlderHistory,
    });

    triggerScroll(480);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("retries older-history pagination immediately after prepend when the viewport remains pinned near the top", () => {
    const onLoadOlderHistory = vi.fn();
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });

    triggerScroll(1560);
    triggerScroll(80);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    latestScrollStateRef.current.scrollOffset = 72;
    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: true,
      onLoadOlderHistory,
    });

    latestScrollStateRef.current.scrollOffset = 72;
    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m-1", -1),
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: false,
      onLoadOlderHistory,
    });

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(2);
  });

  it("shows a loading badge while older history pagination is in flight", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      loadingOlderHistory: true,
    });

    expect(container.textContent).toContain("Loading older messages");
    expect(container.querySelector("[data-testid='older-history-loading-row']")).toBeTruthy();
  });

  it("does not auto-follow while older history is being prepended", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1560);
    triggerScroll(80);
    scrollToIndexMock.mockClear();

    mountChatMessageList({
      threadId: "thread-a",
      items: [
        makeMessageItem("m0", 0),
        makeMessageItem("m1", 1),
        makeMessageItem("m2", 2),
        makeMessageItem("m3", 3),
      ],
      hasOlderHistory: true,
      loadingOlderHistory: true,
    });
    triggerScrollEnd();

    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it("auto-follows to the footer when footer content is present", () => {
    mountChatMessageList({
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      footer: <div data-testid="plan-footer">Plan decision footer</div>,
    });

    setScrollMetrics();

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
  });

  it("re-aligns to the bottom when virtualized content height grows after the initial mount", () => {
    latestScrollStateRef.current.scrollSize = 700;
    latestScrollStateRef.current.viewportSize = 700;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      footer: <div data-testid="plan-footer">Plan decision footer</div>,
    });

    scrollToIndexMock.mockClear();
    latestScrollStateRef.current.scrollSize = 1800;
    latestScrollStateRef.current.viewportSize = 900;

    triggerResizeObservers();

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
  });

  it("keeps sticky-bottom active during near-bottom measurement jitter after auto-follow", () => {
    latestScrollStateRef.current.scrollSize = 860;
    latestScrollStateRef.current.viewportSize = 860;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
      footer: <div data-testid="plan-footer">Plan decision footer</div>,
    });

    scrollToIndexMock.mockClear();
    latestScrollStateRef.current.scrollSize = 1160;
    latestScrollStateRef.current.viewportSize = 860;
    setScrollMetrics({ scrollHeight: 1160, clientHeight: 860 });

    triggerScroll(212);
    triggerScrollEnd();

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
  });

  it("does not restore cached virtualization state when the previous visit ended at the bottom", () => {
    const savedBottomCache = { key: "thread-a-bottom-cache" };
    latestScrollStateRef.current.cache = savedBottomCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1560);

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(latestVListPropsRef.current?.cache).toBeUndefined();
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("restores cached virtualization state when the previous visit ended away from the bottom", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    scrollToMock.mockClear();

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("does not auto-request older history after restoring a near-top cached thread until a real user gesture occurs", () => {
    const savedNearTopCache = { key: "thread-a-near-top-cache" };
    const onLoadOlderHistory = vi.fn();
    latestScrollStateRef.current.cache = savedNearTopCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(80);
    triggerScrollEnd();
    scrollToMock.mockClear();

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
      hasOlderHistory: true,
      onLoadOlderHistory,
    });

    expect(latestVListPropsRef.current?.cache).toBe(savedNearTopCache);
    expect(scrollToMock).toHaveBeenCalledWith(80);

    triggerScroll(80);
    triggerScrollEnd();

    expect(onLoadOlderHistory).not.toHaveBeenCalled();

    latestScrollStateRef.current.scrollOffset = 80;
    triggerWheel(-48);

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("restores cached virtualization state after thread switch even when cleanup loses the live handle cache", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache-missing-handle" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    triggerScrollEnd();
    scrollToMock.mockClear();

    latestScrollStateRef.current.cache = undefined as unknown as { key: string };

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("preserves cached virtualization state when cleanup sees an invalid viewport on thread switch", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache-invalid-viewport" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    triggerScrollEnd();
    scrollToMock.mockClear();

    latestScrollStateRef.current.viewportSize = 0;

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    latestScrollStateRef.current.viewportSize = 400;
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("restores cached scroll offset after remount once the viewport is measured by resize observation", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache-resize-restore" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    triggerScrollEnd();

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });

    latestScrollStateRef.current.viewportSize = 0;
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    scrollToMock.mockClear();
    latestScrollStateRef.current.viewportSize = 400;
    triggerResizeObservers();

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("waits until the measured scroll range can reach the cached offset before restoring", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache-range-restore" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    triggerScrollEnd();

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });

    latestScrollStateRef.current.scrollSize = 400;
    latestScrollStateRef.current.viewportSize = 400;
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    scrollToMock.mockClear();
    triggerResizeObservers();
    expect(scrollToMock).not.toHaveBeenCalled();

    latestScrollStateRef.current.scrollSize = 2000;
    latestScrollStateRef.current.viewportSize = 400;
    triggerResizeObservers();

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("persists cached virtualization state during active scroll so quick thread switches restore mid-thread position", () => {
    const savedMidThreadCache = { key: "thread-a-mid-cache-active-scroll" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);
    scrollToMock.mockClear();

    latestScrollStateRef.current.cache = undefined as unknown as { key: string };

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });

    expect(latestVListPropsRef.current?.cache).toBe(savedMidThreadCache);
    expect(scrollToMock).toHaveBeenCalledWith(1000);
  });

  it("remounts the virtualizer when the selected thread changes", () => {
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)],
    });
    const firstMountId = latestVListMountIdRef.current;

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });

    expect(latestVListMountIdRef.current).toBeGreaterThan(firstMountId);
  });

  it("does not restore cached virtualization state when the thread content signature changes", () => {
    const savedMidThreadCache = { key: "thread-a-stale-cache" };
    latestScrollStateRef.current.cache = savedMidThreadCache;

    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m3", 3)],
    });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    triggerScroll(1000);

    mountChatMessageList({
      threadId: "thread-b",
      items: [makeMessageItem("n1", 1), makeMessageItem("n2", 2)],
    });
    mountChatMessageList({
      threadId: "thread-a",
      items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2), makeMessageItem("m4", 4)],
    });

    expect(latestVListPropsRef.current?.cache).toBeUndefined();
  });

  it("does not render a footer-only virtual list when thread content is still empty", () => {
    mountChatMessageList({
      items: [],
      emptyState: "existing-thread-empty",
      footer: <div data-testid="plan-footer">Plan decision footer</div>,
    });

    expect(container.textContent).toContain("This thread is empty");
    expect(container.querySelector("[data-testid='plan-footer']")).toBeNull();
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

  it("does not snap to bottom when user scrolls down but remains away from bottom", () => {
    mountChatMessageList({ items: [makeMessageItem("m1", 1), makeMessageItem("m2", 2)] });
    setScrollMetrics({ scrollHeight: 2000, clientHeight: 400 });
    scrollToIndexMock.mockClear();

    triggerScroll(1560);
    triggerScroll(1200);
    triggerScroll(1305);
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

  it("keeps the latest user bubble in view when thinking placeholder appears", () => {
    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        {
          kind: "message",
          message: makeMessage("m2", "user", "Follow up", 2),
        },
      ],
      showThinkingPlaceholder: true,
    });
    setScrollMetrics();

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(1, { align: "end" });
  });

  it("keeps the placeholder in view when scroll ends at the bottom", () => {
    mountChatMessageList({
      items: [
        makeMessageItem("m1", 1),
        {
          kind: "message",
          message: makeMessage("m2", "user", "Follow up", 2),
        },
      ],
      showThinkingPlaceholder: true,
    });
    setScrollMetrics();
    scrollToIndexMock.mockClear();

    triggerScroll(560);
    triggerScrollEnd();

    expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
    expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: "end" });
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
