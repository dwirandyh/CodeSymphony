export type MobileKeyboardBaseline = {
  layoutHeight: number;
  visualHeight: number;
  visualWidth: number;
};

export type MobileKeyboardSnapshot = {
  activeElement: Element | null;
  layoutHeight: number;
  layoutWidth: number;
  virtualKeyboardHeight?: number;
  visualHeight: number;
  visualOffsetTop: number;
  visualWidth: number;
};

export type MobileKeyboardState = {
  activeIsEditable: boolean;
  baseline: MobileKeyboardBaseline;
  bottomInsetPx: number;
  measuredVisible: boolean;
  offsetPx: number;
};

function clampPx(value: number): number {
  return Math.max(0, Math.round(value));
}

export function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return (
    element.tagName === "INPUT"
    || element.tagName === "TEXTAREA"
    || element.isContentEditable === true
    || element.contentEditable === "true"
  );
}

export function createMobileKeyboardBaseline(snapshot: MobileKeyboardSnapshot): MobileKeyboardBaseline {
  return {
    layoutHeight: snapshot.layoutHeight,
    visualHeight: snapshot.visualHeight,
    visualWidth: snapshot.visualWidth,
  };
}

export function computeMobileKeyboardState(args: {
  baseline: MobileKeyboardBaseline;
  snapshot: MobileKeyboardSnapshot;
}): MobileKeyboardState {
  const { snapshot } = args;
  if (snapshot.layoutWidth >= 1024) {
    return {
      activeIsEditable: false,
      baseline: createMobileKeyboardBaseline(snapshot),
      bottomInsetPx: 0,
      measuredVisible: false,
      offsetPx: 0,
    };
  }

  const activeIsEditable = isEditableElement(snapshot.activeElement);
  const currentVisualHeight = snapshot.visualHeight;
  let nextBaseline = { ...args.baseline };

  if (!activeIsEditable && Math.abs(snapshot.visualWidth - nextBaseline.visualWidth) > 80) {
    nextBaseline = createMobileKeyboardBaseline(snapshot);
  }

  if (!activeIsEditable) {
    nextBaseline.visualWidth = snapshot.visualWidth;
    if (currentVisualHeight > nextBaseline.visualHeight) {
      nextBaseline.visualHeight = currentVisualHeight;
    }
    if (snapshot.layoutHeight > nextBaseline.layoutHeight) {
      nextBaseline.layoutHeight = snapshot.layoutHeight;
    }
  }

  const measuredKeyboardHeight = Math.max(
    clampPx(nextBaseline.visualHeight - currentVisualHeight),
    clampPx(nextBaseline.layoutHeight - snapshot.layoutHeight),
    clampPx(snapshot.virtualKeyboardHeight ?? 0),
  );

  const measuredKeyboardVisible = activeIsEditable && measuredKeyboardHeight > 100;
  const bottomInsetPx = Math.max(0, measuredKeyboardHeight - clampPx(snapshot.visualOffsetTop));

  return {
    activeIsEditable,
    baseline: nextBaseline,
    bottomInsetPx,
    measuredVisible: measuredKeyboardVisible,
    offsetPx: measuredKeyboardHeight,
  };
}

export function shouldAllowMobileKeyboardFocusFallback(args: {
  sawMeasuredKeyboard: boolean;
  offsetPx: number;
}): boolean {
  return !args.sawMeasuredKeyboard && args.offsetPx > 0;
}

/** Lift + chrome hide only when editable is focused and keyboard geometry is meaningful. */
export function resolveMobileKeyboardChromeVisible(
  state: Pick<MobileKeyboardState, "activeIsEditable" | "measuredVisible" | "offsetPx">,
  peakOffsetPx: number,
): boolean {
  if (!state.activeIsEditable) {
    return false;
  }
  return state.measuredVisible || Math.max(state.offsetPx, peakOffsetPx) > 150;
}

/** Reserved scroll padding (stable height while keyboard open). */
export function resolveMobileComposerLiftInsetPx(
  state: Pick<MobileKeyboardState, "activeIsEditable" | "bottomInsetPx" | "measuredVisible" | "offsetPx">,
  peakOffsetPx = 0,
): number {
  const effectiveOffsetPx = Math.max(state.offsetPx, peakOffsetPx);
  if (!resolveMobileKeyboardChromeVisible(state, peakOffsetPx)) {
    return 0;
  }
  return Math.max(state.bottomInsetPx, effectiveOffsetPx);
}

/**
 * `bottom` for layout-fixed composer: distance from layout viewport bottom to visual viewport bottom.
 * Pinning to keyboard height (offsetPx) leaves the composer below the visible band on iOS
 * (layout height stays large while visual height shrinks).
 */
export function resolveMobileComposerBottomPx(
  state: Pick<MobileKeyboardState, "activeIsEditable" | "measuredVisible" | "offsetPx">,
  peakOffsetPx: number,
  layoutHeight: number,
  visualHeight: number,
  visualOffsetTop: number,
): number {
  if (!resolveMobileKeyboardChromeVisible(state, peakOffsetPx)) {
    return 0;
  }
  return clampPx(layoutHeight - visualOffsetTop - visualHeight);
}

export function shouldClearPeakKeyboardOffset(args: {
  activeIsEditable: boolean;
  baselineVisualHeight: number;
  measuredVisible: boolean;
  offsetPx: number;
  peakOffsetPx: number;
  reason: "init" | "focusin" | "focusout" | "viewport";
  visualHeight: number;
}): boolean {
  if (!args.activeIsEditable || args.reason === "focusout") {
    return true;
  }
  if (args.measuredVisible || args.offsetPx > 100) {
    return false;
  }
  const visualRecovered = args.visualHeight >= args.baselineVisualHeight - 50;
  return args.peakOffsetPx > 0 && args.offsetPx < 50 && visualRecovered;
}
