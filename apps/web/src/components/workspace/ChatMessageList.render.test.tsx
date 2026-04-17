import { act, forwardRef, useImperativeHandle, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import type { ChatEvent, ChatMessage } from "@codesymphony/shared-types";
import type { ChatTimelineItem } from "./chat-message-list";
import { MarkdownBody, ChatMessageList } from "./chat-message-list";
import { getTimelineItemKey } from "./chat-message-list/toolEventUtils";

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn().mockReturnValue([]),
  SPLIT_WITH_NEWLINES: /\r?\n/,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => <div data-testid="file-diff">FileDiff</div>,
}));

const { scrollToIndexMock, latestVListPropsRef, latestScrollStateRef } = vi.hoisted(() => ({
  scrollToIndexMock: vi.fn(),
  latestVListPropsRef: { current: null as Record<string, any> | null },
  latestScrollStateRef: {
    current: {
      scrollOffset: 0,
      scrollSize: 0,
      viewportSize: 0,
    },
  },
}));

vi.mock("virtua", () => ({
  VList: forwardRef(({ children, ...props }: any, ref) => {
    latestVListPropsRef.current = props;
    useImperativeHandle(ref, () => ({
      scrollToIndex: scrollToIndexMock,
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
  latestScrollStateRef.current = {
    scrollOffset: 0,
    scrollSize: 0,
    viewportSize: 0,
  };
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
    expect(container.textContent).toContain("# README");
    expect(container.textContent).not.toContain("tool.finished");
    expect(container.textContent).not.toContain("Raw payload");
    expect(container.querySelector("[data-testid='timeline-tool-payload-details']")).toBeNull();
    expect(container.querySelector("[data-testid='timeline-tool']")).toBeTruthy();
    expect(container.querySelector("details")).toBeTruthy();
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
    expect(container.textContent).toContain("Exit code 1");
    expect(container.textContent).toContain("MCP request failed");
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
    expect(container.textContent).toContain("Successfully loaded skill");
    expect(container.textContent).toContain("1 tool allowed");
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
    expect(container.textContent).toContain("Successfully loaded skill");
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

    expect(container.textContent).toContain("Ran git status");
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

    expect(container.textContent).toContain("Ran git status");
    expect(container.querySelector(".lucide-circle-x")).toBeTruthy();
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
    expect(container.textContent).toContain("Step 1");
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
    expect(container.textContent).toContain("Successfully loaded skill");
    expect(container.textContent).toContain("1 tool allowed");
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
    expect(container.textContent).toContain("Avatar URL?");
    expect(container.textContent).toContain("Use upload_url");
    expect(container.textContent).toContain("Retry upload?");
    expect(container.textContent).toContain("No retry");
    expect(container.textContent).not.toContain("AskUserQuestion · Completed AskUserQuestion");
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
