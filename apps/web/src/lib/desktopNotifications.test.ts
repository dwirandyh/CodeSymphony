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
  isPermissionGrantedMock,
  invokeMock,
  openUrlMock,
  requestPermissionMock,
  sendNotificationMock,
} = vi.hoisted(() => ({
  isPermissionGrantedMock: vi.fn(),
  invokeMock: vi.fn(),
  openUrlMock: vi.fn(),
  requestPermissionMock: vi.fn(),
  sendNotificationMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: requestPermissionMock,
  sendNotification: sendNotificationMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

describe("desktopNotifications", () => {
  const originalTauriInternals = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const originalNotification = window.Notification;

  beforeEach(() => {
    isPermissionGrantedMock.mockReset();
    invokeMock.mockReset();
    openUrlMock.mockReset();
    requestPermissionMock.mockReset();
    sendNotificationMock.mockReset();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (typeof originalTauriInternals === "undefined") {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    } else {
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalTauriInternals;
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

  it("requests permission through the browser Notification API outside tauri", async () => {
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

  it("uses the tauri notification plugin inside the desktop shell", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await expect(requestDesktopNotificationPermission()).resolves.toBe("granted");
    expect(requestPermissionMock).not.toHaveBeenCalled();
  });

  it("reads tauri permission state without prompting", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await expect(getDesktopNotificationPermission()).resolves.toBe("granted");
    expect(requestPermissionMock).not.toHaveBeenCalled();
  });

  it("treats tauri desktop notification permissions as system-managed", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    expect(usesSystemManagedDesktopNotificationPermissions()).toBe(true);
  });

  it("sends native notifications through tauri on desktop", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);

    await expect(sendDesktopNotification({
      title: "AI finished working",
      body: "Background chat is ready.",
    })).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledWith("send_native_desktop_notification", {
      title: "AI finished working",
      body: "Background chat is ready.",
    });
  });

  it("falls back to the tauri notification plugin if the native command fails", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("invoke failed"));
    sendNotificationMock.mockResolvedValue(undefined);

    await expect(sendDesktopNotification({
      title: "AI finished working",
      body: "Background chat is ready.",
    })).resolves.toBe(true);

    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "AI finished working",
      body: "Background chat is ready.",
    });
  });

  it("opens macOS notification settings through the native tauri command", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);

    await expect(openDesktopNotificationSettings()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("open_native_notification_settings");
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("falls back to the opener deep links when the native tauri command fails", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("invoke failed"));
    openUrlMock
      .mockRejectedValueOnce(new Error("specific failed"))
      .mockResolvedValueOnce(undefined);

    await expect(openDesktopNotificationSettings()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("open_native_notification_settings");
    expect(openUrlMock).toHaveBeenNthCalledWith(
      1,
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.codesymphony.app",
    );
    expect(openUrlMock).toHaveBeenNthCalledWith(
      2,
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
  });

  it("returns false when both native and opener fallbacks fail", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockRejectedValue(new Error("invoke failed"));
    openUrlMock.mockRejectedValue(new Error("open failed"));

    await expect(openDesktopNotificationSettings()).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("open_native_notification_settings");
  });
});
