import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleWindowIdleTask } from "./idleTask";

type TestWindow = Window & {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

describe("scheduleWindowIdleTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, "requestIdleCallback");
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, "cancelIdleCallback");
  });

  it("falls back to a timeout when requestIdleCallback never runs", () => {
    const callback = vi.fn();
    const cancelIdleCallback = vi.fn();

    (window as TestWindow).requestIdleCallback = vi.fn(() => 17);
    (window as TestWindow).cancelIdleCallback = cancelIdleCallback;

    scheduleWindowIdleTask(callback, {
      timeout: 500,
      fallbackDelayMs: 1,
    });

    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
  });

  it("runs only once when idle callback wins before the timeout fallback", () => {
    const state: { idleCallback: (() => void) | null } = {
      idleCallback: null,
    };
    const callback = vi.fn();
    const cancelIdleCallback = vi.fn();

    (window as TestWindow).requestIdleCallback = vi.fn((cb) => {
      state.idleCallback = cb;
      return 23;
    });
    (window as TestWindow).cancelIdleCallback = cancelIdleCallback;

    scheduleWindowIdleTask(callback, {
      timeout: 500,
      fallbackDelayMs: 1,
    });

    const runIdleCallback = state.idleCallback;
    if (runIdleCallback == null) {
      throw new Error("Expected requestIdleCallback to capture the scheduled callback");
    }
    runIdleCallback();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(cancelIdleCallback).toHaveBeenCalledWith(23);

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
