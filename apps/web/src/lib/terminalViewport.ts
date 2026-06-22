import { isDesktopShell } from "./desktopBridge";
import { getMobileDeviceViewerControlsFlag } from "../components/workspace/deviceViewerEnvironment";

export type TerminalResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
  authoritative: boolean;
};

export function isRemoteMobileTerminalViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (isDesktopShell()) {
    return false;
  }

  return getMobileDeviceViewerControlsFlag();
}

export function shouldControlSharedPtySize(): boolean {
  return !isRemoteMobileTerminalViewport();
}

export function buildTerminalResizeMessage(cols: number, rows: number): TerminalResizeMessage {
  return {
    type: "resize",
    cols,
    rows,
    authoritative: shouldControlSharedPtySize(),
  };
}

export function appendTerminalViewportQuery(params: URLSearchParams): void {
  if (isRemoteMobileTerminalViewport()) {
    params.set("viewport", "remote");
  }
}