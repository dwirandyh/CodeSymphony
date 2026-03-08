import { act, createElement } from "react";
import { debugLog } from "../../lib/debugLog";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("virtua", () => ({
  VList: vi.fn(({ children }: any) => {
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

const timelineItemRenderSpy = vi.fn();

vi.mock("react-markdown", () => ({
  default: ({ children }: any) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("rehype-sanitize", () => ({
  default: {},
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("./chat-message-list/TimelineItem", async () => {
  const actual = await vi.importActual<typeof import("./chat-message-list/TimelineItem")>("./chat-message-list/TimelineItem");
  return {
    ...actual,
    TimelineItem: (props: any) => {
      timelineItemRenderSpy(props.item);
      return createElement(actual.TimelineItem, props);
    },
  };
});

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  timelineItemRenderSpy.mockClear();
  vi.mocked(debugLog).mockClear();
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
    timelineSummary: undefined,
    showThinkingPlaceholder: false,
    sendingMessage: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    topPaginationInteractionReady: false,
    onOpenReadFile: vi.fn(),
    onLoadOlderHistory: vi.fn(),
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

  it("renders bash-command item", () => {
    const items: ChatTimelineItem[] = [
      {
        kind: "bash-command",
        id: "bash-1",
        toolUseId: "tu-1",
        shell: "bash",
        command: "ls -la",
        summary: null,
        output: "total 0\ndrwxr-xr-x",
        error: null,
        truncated: false,
        durationSeconds: 0.5,
        status: "success",
      },
    ];
    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} />);
    });
    expect(container.textContent).toContain("ls");
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

  it("renders thinking placeholder when requested", () => {
    act(() => {
      root.render(<ChatMessageList {...baseProps} showThinkingPlaceholder={true} />);
    });
    expect(container.textContent).toContain("Thinking...");
  });

  it("skips rerender when props stay referentially stable", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m2", "assistant", "Stable", 2), renderHint: "markdown" },
    ];
    const timelineSummary = {
      oldestRenderableKey: "stable-key",
      oldestRenderableKind: "message" as const,
      oldestRenderableMessageId: "m2",
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    };

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} timelineSummary={timelineSummary} />);
    });
    expect(timelineItemRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<ChatMessageList {...baseProps} items={items} timelineSummary={timelineSummary} />);
    });

    expect(timelineItemRenderSpy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(debugLog).mock.calls.filter(([, event]) => event === "lifecycle.mount")).toHaveLength(1);
  });

  it("keeps timeline rows stable across shell-only rerenders", () => {
    const items: ChatTimelineItem[] = [
      { kind: "message", message: makeMessage("m2", "assistant", "Stable", 2), renderHint: "markdown" },
    ];
    const timelineSummary = {
      oldestRenderableKey: "stable-key",
      oldestRenderableKind: "message" as const,
      oldestRenderableMessageId: "m2",
      oldestRenderableHydrationPending: false,
      headIdentityStable: true,
    };

    act(() => {
      root.render(
        <ChatMessageList
          {...baseProps}
          items={items}
          timelineSummary={timelineSummary}
          hasOlderHistory={true}
          loadingOlderHistory={false}
        />,
      );
    });
    expect(timelineItemRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <ChatMessageList
          {...baseProps}
          items={items}
          timelineSummary={timelineSummary}
          hasOlderHistory={true}
          loadingOlderHistory={true}
        />,
      );
    });

    expect(timelineItemRenderSpy).toHaveBeenCalledTimes(1);
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
});
