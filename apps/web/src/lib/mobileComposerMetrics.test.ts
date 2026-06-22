import { afterEach, describe, expect, it } from "vitest";
import {
  clearMobileComposerScrollPadding,
  MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR,
  publishMobileComposerScrollPadding,
} from "./mobileComposerMetrics";

describe("mobileComposerMetrics", () => {
  afterEach(() => {
    clearMobileComposerScrollPadding();
  });

  it("publishes the measured composer height to the root CSS variable", () => {
    publishMobileComposerScrollPadding(138.2);
    expect(
      document.documentElement.style.getPropertyValue(MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR),
    ).toBe("139px");
  });

  it("clears the published composer height", () => {
    publishMobileComposerScrollPadding(120);
    clearMobileComposerScrollPadding();
    expect(
      document.documentElement.style.getPropertyValue(MOBILE_COMPOSER_SCROLL_PADDING_CSS_VAR),
    ).toBe("");
  });
});