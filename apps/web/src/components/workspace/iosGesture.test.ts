import { describe, expect, it } from "vitest";
import {
  buildIosDragPayload,
  detectIosGestureEdge,
  IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX,
  IOS_GESTURE_PATH_POINT_MIN_INTERVAL_MS,
  resolveIosBottomEdgeReleaseAction,
  resolveIosGestureAxis,
  shouldAppendIosGesturePathPoint,
} from "./iosGesture";

describe("iosGesture", () => {
  it("detects edge gestures using the configured device margins", () => {
    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 12,
      startY: 400,
    })).toBe("left");

    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 381,
      startY: 400,
    })).toBe("right");

    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 180,
      startY: 24,
    })).toBe("top");

    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 180,
      startY: 810,
    })).toBeNull();

    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 180,
      startY: 840,
    })).toBe("bottom");

    expect(detectIosGestureEdge({
      deviceHeight: 852,
      deviceWidth: 393,
      startX: 180,
      startY: 400,
    })).toBeNull();
  });

  it("waits for a clear dominant axis unless an edge gesture already biases the direction", () => {
    expect(resolveIosGestureAxis({
      clientDx: 8,
      clientDy: 8,
      edge: null,
      lockedAxis: null,
    })).toBeNull();

    expect(resolveIosGestureAxis({
      clientDx: 6,
      clientDy: 18,
      edge: null,
      lockedAxis: null,
    })).toBe("vertical");

    expect(resolveIosGestureAxis({
      clientDx: 18,
      clientDy: 6,
      edge: null,
      lockedAxis: null,
    })).toBe("horizontal");

    expect(resolveIosGestureAxis({
      clientDx: 7,
      clientDy: 5,
      edge: "left",
      lockedAxis: null,
    })).toBe("horizontal");

    expect(resolveIosGestureAxis({
      clientDx: 4,
      clientDy: 7,
      edge: "bottom",
      lockedAxis: null,
    })).toBe("vertical");

    expect(resolveIosGestureAxis({
      clientDx: 4,
      clientDy: 40,
      edge: null,
      lockedAxis: "horizontal",
    })).toBe("horizontal");
  });

  it("keeps bottom-edge upward swipes from locking horizontal too early", () => {
    expect(resolveIosGestureAxis({
      clientDx: 16,
      clientDy: -14,
      edge: "bottom",
      lockedAxis: null,
    })).toBe("vertical");

    expect(resolveIosGestureAxis({
      clientDx: 18,
      clientDy: -14,
      edge: "bottom",
      lockedAxis: null,
    })).toBeNull();

    expect(resolveIosGestureAxis({
      clientDx: 24,
      clientDy: -8,
      edge: "bottom",
      lockedAxis: null,
    })).toBe("horizontal");
  });

  it("allows a bottom-edge upward swipe to recover from an early horizontal lock", () => {
    expect(resolveIosGestureAxis({
      clientDx: 22,
      clientDy: -26,
      edge: "bottom",
      lockedAxis: "horizontal",
    })).toBe("vertical");

    expect(resolveIosGestureAxis({
      clientDx: 26,
      clientDy: -10,
      edge: "bottom",
      lockedAxis: "horizontal",
    })).toBe("horizontal");
  });

  it("appends path points only after enough movement or elapsed time", () => {
    expect(shouldAppendIosGesturePathPoint({
      clientDx: IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX - 1,
      clientDy: 0,
      elapsedMs: IOS_GESTURE_PATH_POINT_MIN_INTERVAL_MS - 1,
    })).toBe(false);

    expect(shouldAppendIosGesturePathPoint({
      clientDx: IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX,
      clientDy: 0,
      elapsedMs: 0,
    })).toBe(true);

    expect(shouldAppendIosGesturePathPoint({
      clientDx: 0,
      clientDy: 0,
      elapsedMs: IOS_GESTURE_PATH_POINT_MIN_INTERVAL_MS,
    })).toBe(true);
  });

  it("falls back to taps for bottom-edge touches that are not system swipes", () => {
    expect(resolveIosBottomEdgeReleaseAction({
      clientDx: 2,
      clientDy: -1,
      clientDistance: Math.hypot(2, -1),
      deviceHeight: 852,
      endY: 838,
      elapsedMs: 120,
      startY: 840,
    })).toBe("tap");

    expect(resolveIosBottomEdgeReleaseAction({
      clientDx: 0,
      clientDy: -220,
      clientDistance: 220,
      deviceHeight: 852,
      endY: 600,
      elapsedMs: 160,
      startY: 820,
    })).toBe("swipe_home");

    expect(resolveIosBottomEdgeReleaseAction({
      clientDx: 0,
      clientDy: -220,
      clientDistance: 220,
      deviceHeight: 852,
      endY: 520,
      elapsedMs: 500,
      startY: 820,
    })).toBe("app_switcher");

    expect(resolveIosBottomEdgeReleaseAction({
      clientDx: 0,
      clientDy: -24,
      clientDistance: 24,
      deviceHeight: 852,
      endY: 796,
      elapsedMs: 160,
      startY: 820,
    })).toBeNull();
  });

  it("serializes drag payload points with per-step delays capped for live streaming", () => {
    expect(buildIosDragPayload({
      phase: "move",
      points: [
        {
          atMs: 10,
          x: 120,
          y: 600,
        },
        {
          atMs: 23,
          x: 120,
          y: 552,
        },
        {
          atMs: 72,
          x: 120,
          y: 500,
        },
      ],
    })).toEqual({
      phase: "move",
      points: [
        {
          delay_ms: 0,
          x: 120,
          y: 600,
        },
        {
          delay_ms: 13,
          x: 120,
          y: 552,
        },
        {
          delay_ms: 20,
          x: 120,
          y: 500,
        },
      ],
      t: "drag",
    });
  });

  it("preserves a longer dwell when the pointer intentionally pauses on the same point", () => {
    expect(buildIosDragPayload({
      phase: "end",
      points: [
        {
          atMs: 10,
          x: 180,
          y: 760,
        },
        {
          atMs: 245,
          x: 180,
          y: 760,
        },
      ],
    })).toEqual({
      phase: "end",
      points: [
        {
          delay_ms: 0,
          x: 180,
          y: 760,
        },
        {
          delay_ms: 235,
          x: 180,
          y: 760,
        },
      ],
      t: "drag",
    });
  });
});
