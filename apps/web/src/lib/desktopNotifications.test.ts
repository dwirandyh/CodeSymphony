import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDesktopNotificationPermission,
  openDesktopNotificationSettings,
  requestDesktopNotificationPermission,
  sendDesktopNotification,
  supportsDesktopNotifications,
  usesSystemManagedDesktopNotificationPermissions,
} from "./desktopNotifications";

const {
  openNativeNotificationSettingsMock,
  sendNativeDesktopNotificationMock,
} = vi.hoisted(() => ({
  openNativeNotificationSettingsMock: vi.fn(),
  sendNativeDesktopNotificationMock: vi.fn(),
}));

describe("desktopNotifications", () => {
  type DesktopTestWindow = Window & {
    __CS_ELECTRON__?: boolean;
    __CS_ELECTRON_BRIDGE__?: {
      openNativeNotificationSettings?: () => Promise<boolean>;
      sendNativeDesktopNotification?: (payload: { title: string; body: string }) => Promise<boolean>;
    };
  };

  const originalElectron = (window as DesktopTestWindow).__CS_ELECTRON__;
  const originalElectronBridge = (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
  const originalNotification = window.Notification;

  beforeEach(() => {
    openNativeNotificationSettingsMock.mockReset();
    sendNativeDesktopNotificationMock.mockReset();
    delete (window as DesktopTestWindow).__CS_ELECTRON__;
    delete (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__;
  });

  afterEach(() => {
    vi.restoreAllMocks();

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

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: originalNotification,
    });
  });

  it("detects browser notification support", () => {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: Object.assign(function BrowserNotification() {}, {
        permission: "default" satisfies NotificationPermission,
        requestPermission: vi.fn<() => Promise<NotificationPermission>>().mockResolvedValue("default"),
      }),
    });

    expect(supportsDesktopNotifications()).toBe(true);
  });

  it("requests permission through the browser Notification API outside desktop", async () => {
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>().mockResolvedValue("granted");

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: Object.assign(function BrowserNotification() {}, {
        permission: "default" satisfies NotificationPermission,
        requestPermission,
      }),
    });

    await expect(requestDesktopNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  function installElectronBridge() {
    (window as DesktopTestWindow).__CS_ELECTRON__ = true;
    (window as DesktopTestWindow).__CS_ELECTRON_BRIDGE__ = {
      openNativeNotificationSettings: openNativeNotificationSettingsMock,
      sendNativeDesktopNotification: sendNativeDesktopNotificationMock,
    };
  }

  it("treats Electron desktop permissions as granted", async () => {
    installElectronBridge();

    await expect(requestDesktopNotificationPermission()).resolves.toBe("granted");
  });

  it("reads Electron permission state without prompting", async () => {
    installElectronBridge();

    await expect(getDesktopNotificationPermission()).resolves.toBe("granted");
  });

  it("treats Electron desktop notification permissions as system-managed", () => {
    installElectronBridge();

    expect(usesSystemManagedDesktopNotificationPermissions()).toBe(true);
  });

  it("sends native notifications through Electron on desktop", async () => {
    installElectronBridge();
    sendNativeDesktopNotificationMock.mockResolvedValue(true);

    await expect(sendDesktopNotification({
      title: "AI finished working",
      body: "Background chat is ready.",
    })).resolves.toBe(true);

    expect(sendNativeDesktopNotificationMock).toHaveBeenCalledWith({
      title: "AI finished working",
      body: "Background chat is ready.",
    });
  });

  it("returns false when the Electron notification bridge fails", async () => {
    installElectronBridge();
    sendNativeDesktopNotificationMock.mockResolvedValue(false);

    await expect(sendDesktopNotification({
      title: "AI finished working",
      body: "Background chat is ready.",
    })).resolves.toBe(false);
  });

  it("opens macOS notification settings through the Electron bridge", async () => {
    installElectronBridge();
    openNativeNotificationSettingsMock.mockResolvedValue(true);

    await expect(openDesktopNotificationSettings()).resolves.toBe(true);
    expect(openNativeNotificationSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when the Electron settings bridge fails", async () => {
    installElectronBridge();
    openNativeNotificationSettingsMock.mockResolvedValue(false);

    await expect(openDesktopNotificationSettings()).resolves.toBe(false);
    expect(openNativeNotificationSettingsMock).toHaveBeenCalledTimes(1);
  });
});
