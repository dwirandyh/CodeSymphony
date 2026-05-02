import { describe, expect, it } from "vitest";
import {
  resolveIosKeyboardUiState,
  shouldFocusIosKeyboardBridgeOnSurfacePointerDown,
  shouldMaintainIosKeyboardBridgeFocusOnBlur,
} from "./iosKeyboardSync";

describe("iosKeyboardSync", () => {
  it("uses simulator keyboard visibility as the source of truth on mobile when sync is available", () => {
    expect(resolveIosKeyboardUiState({
      keyboardBridgeFocused: false,
      keyboardSyncAvailable: true,
      showMobileViewerControls: true,
      softwareKeyboardVisible: true,
    })).toEqual({
      keyboardButtonActive: true,
      showMobileKeyboardBridge: true,
      usesSimulatorKeyboardSync: true,
    });
  });

  it("falls back to textarea focus state when simulator sync is unavailable", () => {
    expect(resolveIosKeyboardUiState({
      keyboardBridgeFocused: true,
      keyboardSyncAvailable: false,
      showMobileViewerControls: true,
      softwareKeyboardVisible: false,
    })).toEqual({
      keyboardButtonActive: true,
      showMobileKeyboardBridge: true,
      usesSimulatorKeyboardSync: false,
    });
  });

  it("does not auto-focus the bridge on mobile while the simulator keyboard is hidden", () => {
    expect(shouldFocusIosKeyboardBridgeOnSurfacePointerDown({
      keyboardBridgeFocused: false,
      keyboardSyncAvailable: true,
      showMobileViewerControls: true,
      softwareKeyboardVisible: false,
    })).toBe(false);
  });

  it("keeps bridge focus behavior on desktop viewers", () => {
    expect(shouldFocusIosKeyboardBridgeOnSurfacePointerDown({
      keyboardBridgeFocused: false,
      keyboardSyncAvailable: false,
      showMobileViewerControls: false,
      softwareKeyboardVisible: false,
    })).toBe(true);
  });

  it("re-focuses the bridge on blur only while mobile simulator sync still expects a keyboard", () => {
    expect(shouldMaintainIosKeyboardBridgeFocusOnBlur({
      keyboardSyncAvailable: true,
      showMobileViewerControls: true,
      softwareKeyboardVisible: true,
    })).toBe(true);

    expect(shouldMaintainIosKeyboardBridgeFocusOnBlur({
      keyboardSyncAvailable: false,
      showMobileViewerControls: true,
      softwareKeyboardVisible: true,
    })).toBe(false);
  });
});
