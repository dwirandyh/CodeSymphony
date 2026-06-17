import { describe, expect, it } from "vitest";
import { resolveThreadPaneMessageListEmptyState } from "./threadPaneEmptyState";

const idleSnapshot = { isLoading: false, isFetching: false, data: { ok: true } };
const loadingSnapshot = { isLoading: true, isFetching: true, data: null };
const refetchSnapshot = { isLoading: false, isFetching: true, data: { ok: true } };

describe("resolveThreadPaneMessageListEmptyState", () => {
  it("keeps empty thread visible while snapshot refetches with cached data", () => {
    const state = resolveThreadPaneMessageListEmptyState({
      timelineItemCount: 0,
      isOptimisticThread: false,
      messageCount: 0,
      eventCount: 0,
      statusSnapshot: refetchSnapshot,
      timelineSnapshot: refetchSnapshot,
    });

    expect(state).toBe("existing-thread-empty");
  });

  it("shows loading shimmer only before first timeline snapshot arrives", () => {
    const state = resolveThreadPaneMessageListEmptyState({
      timelineItemCount: 0,
      isOptimisticThread: false,
      messageCount: 0,
      eventCount: 0,
      statusSnapshot: idleSnapshot,
      timelineSnapshot: loadingSnapshot,
    });

    expect(state).toBe("loading-thread");
  });

  it("keeps empty thread visible when status refetches but timeline snapshot is cached", () => {
    const state = resolveThreadPaneMessageListEmptyState({
      timelineItemCount: 0,
      isOptimisticThread: false,
      messageCount: 0,
      eventCount: 0,
      statusSnapshot: loadingSnapshot,
      timelineSnapshot: refetchSnapshot,
    });

    expect(state).toBe("existing-thread-empty");
  });
});
