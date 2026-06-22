import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTerminalViewportQuery,
  buildTerminalResizeMessage,
  isRemoteMobileTerminalViewport,
  shouldControlSharedPtySize,
} from "./terminalViewport";

vi.mock("./desktopBridge", () => ({
  isDesktopShell: vi.fn(() => false),
}));

vi.mock("../components/workspace/deviceViewerEnvironment", () => ({
  getMobileDeviceViewerControlsFlag: vi.fn(() => false),
}));

import { isDesktopShell } from "./desktopBridge";
import { getMobileDeviceViewerControlsFlag } from "../components/workspace/deviceViewerEnvironment";

describe("terminalViewport", () => {
  afterEach(() => {
    vi.mocked(isDesktopShell).mockReturnValue(false);
    vi.mocked(getMobileDeviceViewerControlsFlag).mockReturnValue(false);
  });

  it("treats desktop shell as authoritative viewport", () => {
    vi.mocked(isDesktopShell).mockReturnValue(true);
    vi.mocked(getMobileDeviceViewerControlsFlag).mockReturnValue(true);

    expect(isRemoteMobileTerminalViewport()).toBe(false);
    expect(shouldControlSharedPtySize()).toBe(true);
    expect(buildTerminalResizeMessage(120, 40)).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
      authoritative: true,
    });
  });

  it("treats mobile browser workspace as remote viewport", () => {
    vi.mocked(getMobileDeviceViewerControlsFlag).mockReturnValue(true);

    expect(isRemoteMobileTerminalViewport()).toBe(true);
    expect(shouldControlSharedPtySize()).toBe(false);
    expect(buildTerminalResizeMessage(42, 18)).toEqual({
      type: "resize",
      cols: 42,
      rows: 18,
      authoritative: false,
    });
  });

  it("adds viewport=remote query for remote mobile viewers", () => {
    vi.mocked(getMobileDeviceViewerControlsFlag).mockReturnValue(true);
    const params = new URLSearchParams({ sessionId: "wt1:terminal:1" });

    appendTerminalViewportQuery(params);

    expect(params.get("viewport")).toBe("remote");
  });

  it("does not add viewport query for authoritative desktop browsers", () => {
    const params = new URLSearchParams({ sessionId: "wt1:terminal:1" });

    appendTerminalViewportQuery(params);

    expect(params.get("viewport")).toBeNull();
  });
});