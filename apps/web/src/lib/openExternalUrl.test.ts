import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isElectronDesktop, openExternalUrl, shouldOpenInExternalApp } from "./openExternalUrl";

const { electronOpenExternalMock, logMock } = vi.hoisted(() => ({
  electronOpenExternalMock: vi.fn(),
  logMock: vi.fn(),
}));

vi.mock("./logService", () => ({
  logService: {
    log: logMock,
  },
}));

describe("openExternalUrl", () => {
  type DesktopTestWindow = Window & {
    __CS_ELECTRON?: boolean;
    __CS_ELECTRON__?: boolean;
    __CS_ELECTRON_BRIDGE__?: {
      openExternalUrl: (href: string) => Promise<void>;
    };
  };
  const originalLegacyElectron = (window as DesktopTestWindow).__CS_ELECTRON;
  const originalElectron = (window as DesktopTestWindow).__CS_ELECTRON__;
  const originalElectronBridge = (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;

  beforeEach(() => {
    electronOpenExternalMock.mockReset();
    logMock.mockReset();
    vi.spyOn(window, "open").mockImplementation(() => null);
    delete (window as DesktopTestWindow).__CS_ELECTRON;
    delete (window as DesktopTestWindow).__CS_ELECTRON__;
    delete (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
    window.history.replaceState({}, "", "/workspace");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof originalLegacyElectron === "undefined") {
      delete (window as DesktopTestWindow).__CS_ELECTRON;
    } else {
      (window as DesktopTestWindow).__CS_ELECTRON = originalLegacyElectron;
    }
    if (typeof originalElectron === "undefined") {
      delete (window as DesktopTestWindow).__CS_ELECTRON__;
    } else {
      (window as DesktopTestWindow).__CS_ELECTRON__ = originalElectron;
    }
    if (typeof originalElectronBridge === "undefined") {
      delete (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
    } else {
      (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__ = originalElectronBridge;
    }
  });

  it("detects electron desktop when bridge globals are injected", () => {
    (window as DesktopTestWindow).__CS_ELECTRON__ = true;
    expect(isElectronDesktop()).toBe(true);
  });

  it("detects electron desktop from the legacy preload flag", () => {
    (window as DesktopTestWindow).__CS_ELECTRON = true;
    expect(isElectronDesktop()).toBe(true);
  });

  it("opens links via browser tabs outside desktop", async () => {
    await openExternalUrl("https://example.com");

    expect(window.open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(electronOpenExternalMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opening external URL", {
      href: "https://example.com",
      environment: "browser",
    });
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opened external URL", {
      href: "https://example.com",
      environment: "browser",
    });
  });

  it("opens links via electron bridge inside desktop", async () => {
    (window as DesktopTestWindow).__CS_ELECTRON__ = true;
    (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__ = {
      openExternalUrl: electronOpenExternalMock,
    };

    await openExternalUrl("https://example.com");

    expect(electronOpenExternalMock).toHaveBeenCalledWith("https://example.com");
    expect(window.open).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opening external URL", {
      href: "https://example.com",
      environment: "electron",
    });
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opened external URL", {
      href: "https://example.com",
      environment: "electron",
    });
  });

  it("logs opener failures and rethrows", async () => {
    (window as DesktopTestWindow).__CS_ELECTRON__ = true;
    (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__ = {
      openExternalUrl: electronOpenExternalMock,
    };
    electronOpenExternalMock.mockRejectedValueOnce(new Error("open failed"));

    await expect(openExternalUrl("https://example.com")).rejects.toThrow("open failed");

    expect(logMock).toHaveBeenCalledWith("error", "external-link", "Failed to open external URL", {
      href: "https://example.com",
      environment: "electron",
      error: "open failed",
    });
  });
});

describe("shouldOpenInExternalApp", () => {
  it("opens external http urls outside the current origin", () => {
    window.history.replaceState({}, "", "/workspace");

    expect(shouldOpenInExternalApp("https://github.com/electron/electron")).toBe(true);
  });

  it("keeps same-origin app links internal", () => {
    window.history.replaceState({}, "", "/workspace");

    expect(shouldOpenInExternalApp("/settings")).toBe(false);
    expect(shouldOpenInExternalApp(`${window.location.origin}/repositories`)).toBe(false);
  });

  it("treats mailto links as external", () => {
    expect(shouldOpenInExternalApp("mailto:test@example.com")).toBe(true);
  });
});
