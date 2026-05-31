export type ResolveIosKeyboardUiStateArgs = {
  keyboardBridgeEnabled?: boolean;
  keyboardBridgeFocused: boolean;
  keyboardSyncAvailable: boolean;
  showMobileViewerControls: boolean;
  softwareKeyboardVisible: boolean;
};

export function resolveIosKeyboardUiState(args: ResolveIosKeyboardUiStateArgs): {
  keyboardButtonActive: boolean;
  showMobileKeyboardBridge: boolean;
  usesSimulatorKeyboardSync: boolean;
} {
  const { keyboardBridgeFocused, keyboardSyncAvailable, showMobileViewerControls, softwareKeyboardVisible } = args;
  const keyboardBridgeEnabled = args.keyboardBridgeEnabled ?? true;
  const usesSimulatorKeyboardSync = keyboardBridgeEnabled && showMobileViewerControls && keyboardSyncAvailable;
  const keyboardButtonActive = keyboardBridgeEnabled && (usesSimulatorKeyboardSync ? softwareKeyboardVisible : keyboardBridgeFocused);
  const showMobileKeyboardBridge = keyboardBridgeEnabled && showMobileViewerControls && (
    usesSimulatorKeyboardSync ? softwareKeyboardVisible : keyboardBridgeFocused
  );

  return {
    keyboardButtonActive,
    showMobileKeyboardBridge,
    usesSimulatorKeyboardSync,
  };
}

export function shouldFocusIosKeyboardBridgeOnSurfacePointerDown(args: ResolveIosKeyboardUiStateArgs): boolean {
  const { keyboardBridgeFocused, keyboardSyncAvailable, showMobileViewerControls, softwareKeyboardVisible } = args;
  if (args.keyboardBridgeEnabled === false) {
    return false;
  }

  if (!showMobileViewerControls) {
    return true;
  }

  if (keyboardSyncAvailable) {
    return softwareKeyboardVisible;
  }

  return keyboardBridgeFocused;
}

export function shouldMaintainIosKeyboardBridgeFocusOnBlur(args: {
  keyboardBridgeEnabled?: boolean;
  keyboardSyncAvailable: boolean;
  showMobileViewerControls: boolean;
  softwareKeyboardVisible: boolean;
}): boolean {
  if (args.keyboardBridgeEnabled === false) {
    return false;
  }

  return args.showMobileViewerControls && args.keyboardSyncAvailable && args.softwareKeyboardVisible;
}
