export type ResolveIosKeyboardUiStateArgs = {
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
  const usesSimulatorKeyboardSync = showMobileViewerControls && keyboardSyncAvailable;
  const keyboardButtonActive = usesSimulatorKeyboardSync ? softwareKeyboardVisible : keyboardBridgeFocused;
  const showMobileKeyboardBridge = showMobileViewerControls && (
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
  if (!showMobileViewerControls) {
    return true;
  }

  if (keyboardSyncAvailable) {
    return softwareKeyboardVisible;
  }

  return keyboardBridgeFocused;
}

export function shouldMaintainIosKeyboardBridgeFocusOnBlur(args: {
  keyboardSyncAvailable: boolean;
  showMobileViewerControls: boolean;
  softwareKeyboardVisible: boolean;
}): boolean {
  return args.showMobileViewerControls && args.keyboardSyncAvailable && args.softwareKeyboardVisible;
}
