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