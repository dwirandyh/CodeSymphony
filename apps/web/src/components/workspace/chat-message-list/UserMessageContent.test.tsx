import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanInlineMessage } from "./UserMessageContent";

vi.mock("./AssistantContent", () => ({
  MarkdownBody: ({ content, testId }: { content: string; testId?: string }) => (
    <div data-testid={testId}>{content}</div>
  ),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(public callback: ResizeObserverCallback) {}
}

const resizeObserverInstances: MockResizeObserver[] = [];
const rafQueue = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
  const observer = new MockResizeObserver(callback);
  resizeObserverInstances.push(observer);
  return observer;
}));

let container: HTMLDivElement;
let root: Root;
let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>;
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>;

function flushAnimationFrame(frameId: number) {
  const callback = rafQueue.get(frameId);
  if (!callback) {
    return;
  }
  rafQueue.delete(frameId);
  callback(performance.now());
}

function getLatestFrameId(): number | null {
  const frameIds = [...rafQueue.keys()];
  return frameIds.length > 0 ? frameIds[frameIds.length - 1] : null;
}

describe("PlanInlineMessage", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resizeObserverInstances.length = 0;
    rafQueue.clear();
    nextRafId = 1;
    requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
      const frameId = nextRafId++;
      rafQueue.set(frameId, callback);
      return frameId;
    });
    cancelAnimationFrameSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId: number) => {
      rafQueue.delete(frameId);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("coalesces repeated resize callbacks into a single pending animation frame", () => {
    act(() => {
      root.render(
        <PlanInlineMessage
          id="plan-1"
          content="Plan content"
          filePath="/tmp/plan.md"
          copied={false}
          onCopy={() => {}}
        />,
      );
    });

    const contentEl = container.querySelector("[data-testid='plan-inline-content']") as HTMLDivElement;
    expect(contentEl).toBeTruthy();
    Object.defineProperty(contentEl, "clientHeight", {
      configurable: true,
      value: 100,
    });
    Object.defineProperty(contentEl, "scrollHeight", {
      configurable: true,
      value: 220,
    });

    const observer = resizeObserverInstances.at(-1);
    expect(observer).toBeTruthy();

    act(() => {
      observer?.callback([], observer as unknown as ResizeObserver);
      observer?.callback([], observer as unknown as ResizeObserver);
      observer?.callback([], observer as unknown as ResizeObserver);
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(3);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(rafQueue.size).toBe(1);

    const latestFrameId = getLatestFrameId();
    expect(latestFrameId).not.toBeNull();
    act(() => {
      flushAnimationFrame(latestFrameId as number);
    });

    expect(rafQueue.size).toBe(0);
    expect(container.textContent).toContain("Expand plan");
  });

  it("disconnects the observer and cancels pending animation frames on cleanup", () => {
    act(() => {
      root.render(
        <PlanInlineMessage
          id="plan-2"
          content="Cleanup plan"
          filePath="/tmp/cleanup-plan.md"
          copied={false}
          onCopy={() => {}}
        />,
      );
    });

    const observer = resizeObserverInstances.at(-1);
    expect(observer).toBeTruthy();

    act(() => {
      observer?.callback([], observer as unknown as ResizeObserver);
    });

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });

    expect(observer?.disconnect).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);

    root = createRoot(container);
  });
});
