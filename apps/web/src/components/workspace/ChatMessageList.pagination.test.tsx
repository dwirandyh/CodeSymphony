import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@codesymphony/shared-types";
import { ChatMessageList, type ChatTimelineItem } from "./ChatMessageList";

type LoadOlderMetadata = { cycleId: number; requestId: string };
type LoadOlderResult = {
  cycleId?: number | null;
  requestId?: string;
  completionReason?: string;
  messagesAdded?: number;
  eventsAdded?: number;
  estimatedRenderableGrowth?: boolean;
};

const vlistMock = vi.hoisted(() => {
  let lastOnScroll: ((offset: number) => void) | null = null;
  let scrollSize = 2000;
  let viewportSize = 600;
  let scrollOffset = 0;
  let lastShift: boolean | undefined;

  return {
    setScrollSize(value: number) { scrollSize = value; },
    setViewportSize(value: number) { viewportSize = value; },
    emitScroll(offset: number) {
      scrollOffset = offset;
      lastOnScroll?.(offset);
    },
    emitAtTop() {
      // Normal scroll: offset 0 = at top (oldest)
      scrollOffset = 0;
      lastOnScroll?.(0);
    },
    emitAtBottom() {
      // Normal scroll: max offset = at bottom (newest)
      const maxScroll = scrollSize - viewportSize;
      scrollOffset = maxScroll;
      lastOnScroll?.(maxScroll);
    },
    reset() {
      lastOnScroll = null;
      scrollSize = 2000;
      viewportSize = 600;
      scrollOffset = 0;
      lastShift = undefined;
    },
    setOnScroll(fn: ((offset: number) => void) | null) { lastOnScroll = fn; },
    setLastShift(value: boolean | undefined) { lastShift = value; },
    getLastShift() { return lastShift; },
    getScrollSize() { return scrollSize; },
    getViewportSize() { return viewportSize; },
    getScrollOffset() { return scrollOffset; },
    scrollTo(offset: number) { scrollOffset = offset; },
    scrollToIndex(_index: number, opts?: { align?: "start" | "center" | "end" }) {
      if (opts?.align === "end") {
        scrollOffset = Math.max(scrollSize - viewportSize, 0);
      }
    },
  };
});

vi.mock("virtua", async () => {
  const React = await import("react");

  const VList = React.forwardRef<unknown, Record<string, unknown>>(function VListMock(props, ref) {
    const onScroll = props.onScroll as ((offset: number) => void) | undefined;
    const shift = props.shift as boolean | undefined;

    React.useEffect(() => {
      if (onScroll) vlistMock.setOnScroll(onScroll);
      return () => vlistMock.setOnScroll(null);
    }, [onScroll]);

    React.useEffect(() => {
      vlistMock.setLastShift(shift);
    }, [shift]);

    React.useImperativeHandle(ref, () => ({
      scrollTo: (offset: number) => {
        vlistMock.scrollTo(offset);
      },
      scrollToIndex: (index: number, opts?: { align?: "start" | "center" | "end" }) => {
        vlistMock.scrollToIndex(index, opts);
      },
      scrollBy: () => {},
      findItemIndex: () => 0,
      get scrollOffset() { return vlistMock.getScrollOffset(); },
      get scrollSize() { return vlistMock.getScrollSize(); },
      get viewportSize() { return vlistMock.getViewportSize(); },
    }));

    return <div data-testid="vlist-mock">{props.children as React.ReactNode}</div>;
  });

  return { VList };
});

function makeMessageItem(id: string, seq: number): ChatTimelineItem {
  return {
    kind: "message",
    message: {
      id,
      threadId: "thread-1",
      seq,
      role: "assistant",
      content: id,
      attachments: [],
      createdAt: "2026-03-01T00:00:00.000Z",
    },
    isCompleted: true,
  };
}

function makeThinkingItem(id: string, messageId: string): ChatTimelineItem {
  return {
    kind: "thinking",
    id,
    messageId,
    content: "thinking",
    isStreaming: false,
  };
}

function makeToolItem(id: string, messageId: string | null = null): ChatTimelineItem {
  const payload: ChatEvent["payload"] = messageId ? { messageId } : { toolName: "Read" };
  return {
    kind: "tool",
    event: {
      id,
      threadId: "thread-1",
      idx: Number(id.replace(/\D+/g, "")) || 1,
      type: "tool.started",
      payload,
      createdAt: "2026-03-01T00:00:00.000Z",
    },
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushTimers(ms = 260) {
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });
  });
}

describe("ChatMessageList pagination with virtua", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vlistMock.reset();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
    vlistMock.reset();
  });

  it("triggers loadOlderHistory when user scrolls to top", async () => {
    const onLoadOlderHistory = vi.fn<
      (metadata?: LoadOlderMetadata) => Promise<LoadOlderResult>
    >().mockResolvedValue({
      completionReason: "applied",
      estimatedRenderableGrowth: true,
      messagesAdded: 2,
      eventsAdded: 0,
    });

    const initialItems = [
      makeMessageItem("m-10", 10),
      makeMessageItem("m-11", 11),
      makeMessageItem("m-12", 12),
      makeMessageItem("m-13", 13),
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={initialItems}
          hasOlderHistory
          loadingOlderHistory={false}
          onLoadOlderHistory={onLoadOlderHistory}
        />,
      );
    });

    // Scroll to top (offset 0 in normal scroll = oldest messages)
    act(() => {
      vlistMock.emitAtTop();
    });
    await flushMicrotasks();

    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    const metadata = onLoadOlderHistory.mock.calls[0]?.[0] as LoadOlderMetadata;
    expect(metadata.cycleId).toBe(1);
    expect(metadata.requestId).toBe("older-1");
  });

  it("renders prepended items after load (shift prop handles scroll anchoring)", async () => {
    let resolveLoad: ((result: LoadOlderResult) => void) | null = null;
    const loadPromise = new Promise<LoadOlderResult>((resolve) => {
      resolveLoad = resolve;
    });
    const onLoadOlderHistory = vi.fn<
      (metadata?: LoadOlderMetadata) => Promise<LoadOlderResult>
    >(() => loadPromise);

    const initialItems = [
      makeMessageItem("m-10", 10),
      makeMessageItem("m-11", 11),
      makeMessageItem("m-12", 12),
      makeMessageItem("m-13", 13),
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={initialItems}
          hasOlderHistory
          loadingOlderHistory={false}
          onLoadOlderHistory={onLoadOlderHistory}
        />,
      );
    });

    act(() => {
      vlistMock.emitAtTop();
    });
    await flushMicrotasks();

    expect(vlistMock.getLastShift()).toBe(true);

    const withOlderItems = [
      makeMessageItem("m-8", 8),
      makeMessageItem("m-9", 9),
      ...initialItems,
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={withOlderItems}
          hasOlderHistory
          loadingOlderHistory={false}
          onLoadOlderHistory={onLoadOlderHistory}
        />,
      );
    });

    // Shift should remain active until the load promise resolves
    expect(vlistMock.getLastShift()).toBe(true);

    await act(async () => {
      resolveLoad?.({
        completionReason: "applied",
        estimatedRenderableGrowth: true,
        messagesAdded: 2,
        eventsAdded: 0,
      });
      await loadPromise;
    });

    await flushMicrotasks();
    await flushMicrotasks();
    await flushTimers();

    const vlistEl = container.querySelector("[data-testid='vlist-mock']");
    expect(vlistEl).toBeTruthy();
    expect(vlistEl!.children.length).toBe(6);
    expect(vlistMock.getLastShift()).toBe(false);
  });

  it("suppresses top-trigger re-entrance during active load", async () => {
    let resolveLoad: ((result: LoadOlderResult) => void) | null = null;
    const loadPromise = new Promise<LoadOlderResult>((resolve) => {
      resolveLoad = resolve;
    });

    const onLoadOlderHistory = vi.fn<(metadata?: LoadOlderMetadata) => Promise<LoadOlderResult>>(() => loadPromise);

    const initialItems = [
      makeMessageItem("m-10", 10),
      makeMessageItem("m-11", 11),
      makeMessageItem("m-12", 12),
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={initialItems}
          hasOlderHistory
          loadingOlderHistory={false}
          onLoadOlderHistory={onLoadOlderHistory}
        />,
      );
    });

    act(() => {
      vlistMock.emitAtTop();
    });
    await flushMicrotasks();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    // Simulate scroll away and back to top while load is in flight
    act(() => {
      vlistMock.emitAtBottom();
      vlistMock.emitAtTop();
    });
    await flushMicrotasks();
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.({
        completionReason: "applied",
        estimatedRenderableGrowth: true,
        messagesAdded: 2,
        eventsAdded: 0,
      });
      await loadPromise;
    });
  });

  it("does not trigger load when hasOlderHistory is false", async () => {
    const onLoadOlderHistory = vi.fn<
      (metadata?: LoadOlderMetadata) => Promise<LoadOlderResult>
    >().mockResolvedValue({
      completionReason: "empty-cursors",
      estimatedRenderableGrowth: false,
      messagesAdded: 0,
      eventsAdded: 0,
    });

    const initialItems = [
      makeMessageItem("m-10", 10),
      makeMessageItem("m-11", 11),
      makeMessageItem("m-12", 12),
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={initialItems}
          hasOlderHistory={false}
          loadingOlderHistory={false}
          onLoadOlderHistory={onLoadOlderHistory}
        />,
      );
    });

    act(() => {
      vlistMock.emitAtTop();
    });
    await flushMicrotasks();

    expect(onLoadOlderHistory).not.toHaveBeenCalled();
  });

  it("renders thinking placeholder at the end of the list", async () => {
    const items = [
      makeMessageItem("m-1", 1),
      makeMessageItem("m-2", 2),
    ];

    act(() => {
      root.render(
        <ChatMessageList
          items={items}
          showThinkingPlaceholder
        />,
      );
    });

    await flushMicrotasks();

    const thinkingEl = container.querySelector("[data-testid='thinking-placeholder']");
    expect(thinkingEl).toBeTruthy();
  });

  it("renders all timeline item kinds correctly", async () => {
    const items: ChatTimelineItem[] = [
      makeMessageItem("m-1", 1),
      makeThinkingItem("t-1", "m-2"),
      makeToolItem("tool-1", "m-2"),
      makeMessageItem("m-2", 2),
    ];

    act(() => {
      root.render(
        <ChatMessageList items={items} />,
      );
    });

    await flushMicrotasks();

    const vlistEl = container.querySelector("[data-testid='vlist-mock']");
    expect(vlistEl).toBeTruthy();
    // 4 renderable items (activity kind is filtered out, all these pass)
    expect(vlistEl!.children.length).toBe(4);

    // Verify specific item types rendered
    expect(container.querySelector("[data-testid='message-assistant']")).toBeTruthy();
    expect(container.querySelector("[data-testid='timeline-thinking']")).toBeTruthy();
    expect(container.querySelector("[data-testid='timeline-tool.started']")).toBeTruthy();
  });
});
