import { debugLog } from "./debugLog";

type ElectronBridge = {
  collectResourceMonitorDesktopMetrics?: (runtimePid: number | null) => Promise<unknown>;
  getFilePaths?: (files: File[]) => string[];
  isFullscreen?: () => Promise<boolean>;
  onWindowStateChanged?: (handler: (state: { fullscreen?: boolean; maximized?: boolean }) => void) => () => void;
  openExternalUrl?: (href: string) => Promise<void>;
  openNativeNotificationSettings?: () => Promise<boolean>;
  sendNativeDesktopNotification?: (payload: { title: string; body: string }) => Promise<boolean>;
  startDragging?: () => Promise<void>;
  toggleMaximize?: () => Promise<boolean>;
};

type ElectronWindow = Window & {
  __CS_DESKTOP?: boolean;
  __CS_DESKTOP__?: boolean;
  __CS_ELECTRON?: boolean;
  __CS_ELECTRON__?: boolean;
  __CS_ELECTRON_BRIDGE__?: ElectronBridge;
};

export function isElectronDesktop(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const electronWindow = window as ElectronWindow;
  return electronWindow.__CS_ELECTRON__ === true || electronWindow.__CS_ELECTRON === true;
}

export function isDesktopShell(): boolean {
  return isElectronDesktop();
}

export function getElectronBridge(): ElectronBridge | null {
  if (!isElectronDesktop()) {
    return null;
  }

  return (window as ElectronWindow).__CS_ELECTRON_BRIDGE__ ?? null;
}

export function getElectronFilePaths(files: File[]): string[] {
  try {
    return getElectronBridge()?.getFilePaths?.(files) ?? [];
  } catch (error) {
    debugLog("desktop.bridge", "file_paths.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
