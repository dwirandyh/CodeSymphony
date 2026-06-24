import { useLayoutEffect, type RefObject } from "react";

export const MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR = "--cs-mobile-composer-scroll-padding";

export function publishMobileComposerScrollPadding(heightPx: number): void {
  if (typeof document === "undefined" || !Number.isFinite(heightPx) || heightPx <= 0) {
    return;
  }

  document.documentElement.style.setProperty(
    MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR,
    `${Math.ceil(heightPx)}px`,
  );
}

export function clearMobileComposerScrollPadding(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.style.removeProperty(MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR);
}

/** Publishes measured fixed bottom-surface height for mobile chat viewport inset. */
export function useMobileBottomSurfaceScrollPadding(
  enabled: boolean,
  nodeRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }

    const node = nodeRef.current;
    if (!node) {
      return;
    }

    const publishHeight = () => {
      publishMobileComposerScrollPadding(node.offsetHeight);
    };

    publishHeight();

    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
        publishHeight();
      })
      : null;
    observer?.observe(node);

    return () => {
      observer?.disconnect();
      clearMobileComposerScrollPadding();
    };
  }, [enabled, nodeRef]);
}