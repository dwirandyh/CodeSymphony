import { describe, expect, it } from "vitest";
import {
  MOBILE_COMPOSER_Z_CLASS,
  MOBILE_CONTEXT_Z_CLASS,
  MOBILE_ELEVATED_Z_CLASS,
  MOBILE_OVERLAY_Z_CLASS,
  mobileOverlayStacksAboveComposer,
  resolveMobileChatScrollRegionClass,
  resolveMobileChatContentScrollPadding,
  resolveMobileChatViewportInset,
  shouldLockMobileChatSurface,
} from "./mobileStacking";

describe("mobileStacking", () => {
  it("keeps overlay layers above the fixed mobile composer", () => {
    expect(mobileOverlayStacksAboveComposer()).toBe(true);
    expect(MOBILE_COMPOSER_Z_CLASS).toBe("z-[60]");
    expect(MOBILE_OVERLAY_Z_CLASS).toBe("z-[70]");
    expect(MOBILE_CONTEXT_Z_CLASS).toBe("z-[80]");
    expect(MOBILE_ELEVATED_Z_CLASS).toBe("z-[90]");
  });

  it("locks the document only for active mobile chat threads", () => {
    expect(shouldLockMobileChatSurface({
      desktopLayout: false,
      activeView: "chat",
      mobileInlinePanel: false,
      chatThreadId: "thread-1",
      mobileReposDrawerOpen: false,
    })).toBe(true);
    expect(shouldLockMobileChatSurface({
      desktopLayout: true,
      activeView: "chat",
      mobileInlinePanel: false,
      chatThreadId: "thread-1",
      mobileReposDrawerOpen: false,
    })).toBe(false);
    expect(shouldLockMobileChatSurface({
      desktopLayout: false,
      activeView: "chat",
      mobileInlinePanel: true,
      chatThreadId: "thread-1",
      mobileReposDrawerOpen: false,
    })).toBe(false);
  });

  it("keeps the mobile chat scroll region bounded instead of page scroll", () => {
    expect(resolveMobileChatScrollRegionClass(false)).toBe("min-h-0 min-w-0 flex-1");
    expect(resolveMobileChatScrollRegionClass(true)).toContain("overflow-hidden");
    expect(resolveMobileChatScrollRegionClass(true)).toContain("overscroll-none");
  });

  it("reserves gate surface height in the chat viewport while a user gate owns the mobile surface", () => {
    expect(resolveMobileChatViewportInset({
      mobileComposerPinned: true,
      mobileBottomOffset: 0,
    })).toBe("var(--cs-mobile-composer-scroll-padding, 7.5rem)");
    expect(resolveMobileChatViewportInset({
      mobileComposerPinned: true,
      mobileBottomOffset: 280,
    })).toBe("calc(var(--cs-mobile-keyboard-offset, 0px) + var(--cs-mobile-composer-scroll-padding, 7.5rem))");
  });

  it("reserves composer height in the chat viewport so messages do not sit behind it", () => {
    expect(resolveMobileChatViewportInset({
      mobileComposerPinned: true,
      mobileBottomOffset: 0,
    })).toBe("var(--cs-mobile-composer-scroll-padding, 7.5rem)");
    expect(resolveMobileChatContentScrollPadding({
      mobileComposerPinned: true,
    })).toBeUndefined();
  });

  it("adds keyboard shrink on top of composer reserve while the keyboard is open", () => {
    expect(resolveMobileChatViewportInset({
      mobileComposerPinned: true,
      mobileBottomOffset: 280,
    })).toBe("calc(var(--cs-mobile-keyboard-offset, 0px) + var(--cs-mobile-composer-scroll-padding, 7.5rem))");
    expect(resolveMobileChatViewportInset({
      mobileComposerPinned: false,
      mobileBottomOffset: 280,
    })).toBeUndefined();
  });
});