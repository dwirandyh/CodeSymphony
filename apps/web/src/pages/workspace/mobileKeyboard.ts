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
