export type IosGestureAxis = "horizontal" | "vertical";
export type IosGestureEdge = "bottom" | "left" | "right" | "top";

export type IosGesturePathPoint = {
  atMs: number;
  x: number;
  y: number;
};

export const IOS_GESTURE_TAP_SLOP_CSS_PX = 10;
export const IOS_GESTURE_TOUCH_CANCEL_DISTANCE_CSS_PX = 6;
export const IOS_GESTURE_SCROLL_INTENT_DISTANCE_CSS_PX = 10;
export const IOS_GESTURE_PATH_FLUSH_INTERVAL_MS = 12;
export const IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX = 4;
export const IOS_GESTURE_PATH_POINT_MIN_INTERVAL_MS = 4;
export const IOS_TOUCH_DOWN_DELAY_LIVE_MS = 220;

const IOS_GESTURE_AXIS_LOCK_RATIO = 1.12;
const IOS_GESTURE_EDGE_DIRECTION_DISTANCE_CSS_PX = 6;
const IOS_GESTURE_EDGE_MARGIN_RATIO = 0.08;
const IOS_GESTURE_EDGE_MIN_MARGIN_PT = 18;
const IOS_GESTURE_PATH_DWELL_DELAY_MAX_MS = 320;
const IOS_GESTURE_PATH_STEP_DELAY_MAX_MS = 20;
const IOS_BOTTOM_EDGE_HORIZONTAL_AXIS_COMMIT_RATIO = 1.45;
const IOS_BOTTOM_EDGE_VERTICAL_AXIS_BIAS_RATIO = 1.28;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function detectIosGestureEdge(args: {
  deviceHeight: number;
  deviceWidth: number;
  startX: number;
  startY: number;
}): IosGestureEdge | null {
  const { deviceHeight, deviceWidth, startX, startY } = args;
  const horizontalMargin = Math.max(Math.round(deviceWidth * IOS_GESTURE_EDGE_MARGIN_RATIO), IOS_GESTURE_EDGE_MIN_MARGIN_PT);
  const verticalMargin = Math.max(Math.round(deviceHeight * IOS_GESTURE_EDGE_MARGIN_RATIO), IOS_GESTURE_EDGE_MIN_MARGIN_PT);

  if (startX <= horizontalMargin) {
    return "left";
  }
  if (startX >= deviceWidth - horizontalMargin) {
    return "right";
  }
  if (startY <= verticalMargin) {
    return "top";
  }
  if (startY >= deviceHeight - verticalMargin) {
    return "bottom";
  }
  return null;
}

export function resolveIosGestureAxis(args: {
  clientDx: number;
  clientDy: number;
  edge: IosGestureEdge | null;
  lockedAxis: IosGestureAxis | null;
}): IosGestureAxis | null {
  const { clientDx, clientDy, edge, lockedAxis } = args;
  const absX = Math.abs(clientDx);
  const absY = Math.abs(clientDy);
  const dominantDistance = Math.max(absX, absY);
  const minorDistance = Math.min(absX, absY);
  const isBottomEdgeUpwardSwipe = edge === "bottom" && clientDy < 0;

  if (lockedAxis === "vertical") {
    return "vertical";
  }

  if (isBottomEdgeUpwardSwipe && lockedAxis === "horizontal") {
    if (
      absY >= IOS_GESTURE_EDGE_DIRECTION_DISTANCE_CSS_PX
      && absY * IOS_BOTTOM_EDGE_VERTICAL_AXIS_BIAS_RATIO >= absX
    ) {
      return "vertical";
    }
    return "horizontal";
  }

  if (lockedAxis) {
    return lockedAxis;
  }

  if ((edge === "left" || edge === "right") && absX >= IOS_GESTURE_EDGE_DIRECTION_DISTANCE_CSS_PX && absX >= absY) {
    return "horizontal";
  }

  if ((edge === "top" || edge === "bottom") && absY >= IOS_GESTURE_EDGE_DIRECTION_DISTANCE_CSS_PX && absY >= absX) {
    return "vertical";
  }

  if (isBottomEdgeUpwardSwipe) {
    if (
      absY >= IOS_GESTURE_EDGE_DIRECTION_DISTANCE_CSS_PX
      && absY * IOS_BOTTOM_EDGE_VERTICAL_AXIS_BIAS_RATIO >= absX
    ) {
      return "vertical";
    }

    if (dominantDistance < IOS_GESTURE_SCROLL_INTENT_DISTANCE_CSS_PX) {
      return null;
    }

    if (absX < absY * IOS_BOTTOM_EDGE_HORIZONTAL_AXIS_COMMIT_RATIO) {
      return null;
    }

    return "horizontal";
  }

  if (dominantDistance < IOS_GESTURE_SCROLL_INTENT_DISTANCE_CSS_PX) {
    return null;
  }

  if (minorDistance > 0 && dominantDistance / minorDistance < IOS_GESTURE_AXIS_LOCK_RATIO) {
    return null;
  }

  return absY >= absX ? "vertical" : "horizontal";
}

export function shouldAppendIosGesturePathPoint(args: {
  clientDx: number;
  clientDy: number;
  elapsedMs: number;
}): boolean {
  const { clientDx, clientDy, elapsedMs } = args;
  return Math.hypot(clientDx, clientDy) >= IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX
    || elapsedMs >= IOS_GESTURE_PATH_POINT_MIN_INTERVAL_MS;
}

export function buildIosDragPayload(args: {
  phase: "end" | "move" | "start";
  points: IosGesturePathPoint[];
}) {
  const serializedPoints = args.points.map((point, index, points) => {
    const previousPoint = index > 0 ? points[index - 1] : null;
    const previousAt = previousPoint ? previousPoint.atMs : point.atMs;
    const preservesDwell = previousPoint != null
      && previousPoint.x === point.x
      && previousPoint.y === point.y;
    const delayMs = index > 0
      ? clamp(
        Math.round(point.atMs - previousAt),
        0,
        preservesDwell ? IOS_GESTURE_PATH_DWELL_DELAY_MAX_MS : IOS_GESTURE_PATH_STEP_DELAY_MAX_MS,
      )
      : 0;

    return {
      delay_ms: delayMs,
      x: point.x,
      y: point.y,
    };
  });

  return {
    phase: args.phase,
    points: serializedPoints,
    t: "drag",
  };
}
