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
const IOS_GESTURE_BOTTOM_EDGE_MARGIN_RATIO = 0.04;
const IOS_GESTURE_EDGE_MIN_MARGIN_PT = 18;
const IOS_GESTURE_BOTTOM_EDGE_MAX_MARGIN_PT = 32;
const IOS_GESTURE_PATH_DWELL_DELAY_MAX_MS = 320;
// Preserve more of the original swipe cadence so mobile browser gestures do
// not get replayed as overly fast simulator scrolls.
const IOS_GESTURE_PATH_STEP_DELAY_MAX_MS = 80;
const IOS_GESTURE_TOUCH_REPLAY_STEP_DELAY_MAX_MS = 180;
const IOS_BOTTOM_EDGE_HORIZONTAL_AXIS_COMMIT_RATIO = 1.45;
const IOS_BOTTOM_EDGE_VERTICAL_AXIS_BIAS_RATIO = 1.28;
const IOS_BOTTOM_EDGE_HOME_MIN_DISTANCE_RATIO = 0.22;
const IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_DISTANCE_RATIO = 0.16;
const IOS_BOTTOM_EDGE_SYSTEM_GESTURE_MIN_DISTANCE_PT = 56;
const IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_HOLD_MS = 420;
const IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_END_RATIO = 0.4;
const IOS_BOTTOM_EDGE_APP_SWITCHER_MAX_END_RATIO = 0.72;

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
  const bottomMargin = clamp(
    Math.round(deviceHeight * IOS_GESTURE_BOTTOM_EDGE_MARGIN_RATIO),
    IOS_GESTURE_EDGE_MIN_MARGIN_PT,
    IOS_GESTURE_BOTTOM_EDGE_MAX_MARGIN_PT,
  );

  if (startX <= horizontalMargin) {
    return "left";
  }
  if (startX >= deviceWidth - horizontalMargin) {
    return "right";
  }
  if (startY <= verticalMargin) {
    return "top";
  }
  if (startY >= deviceHeight - bottomMargin) {
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

function resolveBottomEdgeSystemGesture(args: {
  clientDx: number;
  clientDy: number;
  deviceHeight: number;
  endY: number;
  elapsedMs: number;
  startY: number;
}): "app_switcher" | "swipe_home" | null {
  const { clientDx, clientDy, deviceHeight, endY, elapsedMs, startY } = args;
  if (deviceHeight <= 0 || clientDy >= -IOS_GESTURE_TAP_SLOP_CSS_PX) {
    return null;
  }

  const upwardDistance = startY - endY;
  const minDistance = Math.max(
    deviceHeight * IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_DISTANCE_RATIO,
    IOS_BOTTOM_EDGE_SYSTEM_GESTURE_MIN_DISTANCE_PT,
  );
  if (upwardDistance < minDistance) {
    return null;
  }

  const verticalBias = Math.abs(clientDy) >= Math.abs(clientDx) * 1.1;
  if (!verticalBias) {
    return null;
  }

  const endRatio = endY / deviceHeight;
  const heldLongEnough = elapsedMs >= IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_HOLD_MS;
  const endedInSwitcherBand = endRatio >= IOS_BOTTOM_EDGE_APP_SWITCHER_MIN_END_RATIO
    && endRatio <= IOS_BOTTOM_EDGE_APP_SWITCHER_MAX_END_RATIO;
  if (heldLongEnough && endedInSwitcherBand) {
    return "app_switcher";
  }

  const homeDistance = Math.max(
    deviceHeight * IOS_BOTTOM_EDGE_HOME_MIN_DISTANCE_RATIO,
    IOS_BOTTOM_EDGE_SYSTEM_GESTURE_MIN_DISTANCE_PT,
  );
  if (upwardDistance >= homeDistance) {
    return "swipe_home";
  }

  return heldLongEnough ? "app_switcher" : null;
}

export function resolveIosBottomEdgeReleaseAction(args: {
  clientDx: number;
  clientDy: number;
  clientDistance: number;
  deviceHeight: number;
  endY: number;
  elapsedMs: number;
  startY: number;
}): "app_switcher" | "swipe_home" | "tap" | null {
  const systemGesture = resolveBottomEdgeSystemGesture(args);
  if (systemGesture) {
    return systemGesture;
  }

  return args.clientDistance <= IOS_GESTURE_TAP_SLOP_CSS_PX ? "tap" : null;
}

export function buildIosDragPayload(args: {
  maxStepDelayMs?: number;
  phase: "end" | "move" | "start";
  points: IosGesturePathPoint[];
}) {
  const stepDelayMaxMs = clamp(
    Math.round(args.maxStepDelayMs ?? IOS_GESTURE_PATH_STEP_DELAY_MAX_MS),
    IOS_GESTURE_PATH_STEP_DELAY_MAX_MS,
    IOS_GESTURE_PATH_DWELL_DELAY_MAX_MS,
  );
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
        preservesDwell ? IOS_GESTURE_PATH_DWELL_DELAY_MAX_MS : stepDelayMaxMs,
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

export {
  IOS_GESTURE_TOUCH_REPLAY_STEP_DELAY_MAX_MS,
};
