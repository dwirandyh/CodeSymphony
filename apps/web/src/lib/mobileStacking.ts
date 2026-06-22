/** Fixed mobile composer sits above the action bar and in-flow chat content. */
export const MOBILE_COMPOSER_Z_CLASS = "z-[60]";

/** Drawers, sheets, dialogs, and toasts that must cover the fixed mobile composer. */
export const MOBILE_OVERLAY_Z_CLASS = "z-[70]";

/** Portaled menus anchored to workspace controls that must cover overlays. */
export const MOBILE_CONTEXT_Z_CLASS = "z-[80]";

/** Popovers and immersive viewers that must cover mobile overlays. */
export const MOBILE_ELEVATED_Z_CLASS = "z-[90]";

export function shouldLockMobileChatSurface(args: {
  desktopLayout: boolean;
  activeView: string;
  mobileInlinePanel: boolean;
  chatThreadId: string | null;
  mobileReposDrawerOpen: boolean;
}): boolean {
  return !args.desktopLayout
    && args.activeView === "chat"
    && !args.mobileInlinePanel
    && args.chatThreadId != null
    && !args.mobileReposDrawerOpen;
}

export function mobileOverlayStacksAboveComposer(): boolean {
  const composerZ = Number(MOBILE_COMPOSER_Z_CLASS.match(/\d+/)?.[0] ?? 0);
  const overlayZ = Number(MOBILE_OVERLAY_Z_CLASS.match(/\d+/)?.[0] ?? 0);
  return overlayZ > composerZ;
}

/** Scroll region that owns chat timeline scroll on mobile web. */
export function resolveMobileChatScrollRegionClass(mobileComposerPinned: boolean): string {
  if (!mobileComposerPinned) {
    return "min-h-0 min-w-0 flex-1";
  }

  return "min-h-0 min-w-0 flex-1 overflow-hidden overscroll-none";
}

export const MOBILE_KEYBOARD_OFFSET_CSS_VAR = "--cs-mobile-keyboard-offset";

const MOBILE_COMPOSER_SCROLL_PADDING = "var(--cs-mobile-composer-scroll-padding, 7.5rem)";
const MOBILE_KEYBOARD_OFFSET = `var(${MOBILE_KEYBOARD_OFFSET_CSS_VAR}, 0px)`;

/** Bottom inset for the bounded chat viewport (composer reserve + keyboard shrink). */
export function resolveMobileChatViewportInset(args: {
  mobileComposerPinned: boolean;
  mobileBottomOffset: number;
  isWaitingForUserGate?: boolean;
}): string | undefined {
  if (!args.mobileComposerPinned || args.isWaitingForUserGate) {
    return undefined;
  }

  if (args.mobileBottomOffset > 0) {
    return `calc(${MOBILE_KEYBOARD_OFFSET} + ${MOBILE_COMPOSER_SCROLL_PADDING})`;
  }

  return MOBILE_COMPOSER_SCROLL_PADDING;
}

/** Fixed bottom slot for mobile user gates that replace the composer. */
export function resolveMobileGateSurfaceStyle(mobileBottomOffset: number): {
  bottom: string;
  left: string;
  width: string;
  right: string;
} {
  return {
    bottom: mobileBottomOffset > 0
      ? MOBILE_KEYBOARD_OFFSET
      : "var(--cs-mobile-composer-rest-offset, 0px)",
    left: "var(--cs-mobile-keyboard-visual-left, 0px)",
    width: "var(--cs-mobile-keyboard-visual-width, 100%)",
    right: "auto",
  };
}

/** Optional extra scroll padding inside the list (viewport already reserves composer height). */
export function resolveMobileChatContentScrollPadding(_args: {
  mobileComposerPinned: boolean;
}): string | undefined {
  return undefined;
}