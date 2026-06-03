import { getElectronBridge, isDesktopShell } from "./desktopBridge";

export type DesktopNotificationPayload = {
  title: string;
  body: string;
  onClick?: () => void;
};

function supportsBrowserNotifications(): boolean {
  return typeof Notification !== "undefined";
}

export function supportsDesktopNotifications(): boolean {
  return isDesktopShell() || supportsBrowserNotifications();
}

export function usesSystemManagedDesktopNotificationPermissions(): boolean {
  return isDesktopShell();
}

export async function getDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (isDesktopShell()) {
    return "granted";
  }

  if (!supportsBrowserNotifications()) {
    return "denied";
  }

  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (isDesktopShell()) {
    return "granted";
  }

  if (!supportsBrowserNotifications()) {
    return "denied";
  }

  if (Notification.permission !== "default") {
    return Notification.permission;
  }

  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export async function sendDesktopNotification(payload: DesktopNotificationPayload): Promise<boolean> {
  if (isDesktopShell()) {
    return await getElectronBridge()?.sendNativeDesktopNotification?.({
      title: payload.title,
      body: payload.body,
    }) ?? false;
  }

  if (!supportsBrowserNotifications() || Notification.permission !== "granted") {
    return false;
  }

  try {
    const notification = new Notification(payload.title, {
      body: payload.body,
      silent: true,
    });

    if (payload.onClick) {
      notification.onclick = payload.onClick;
    }

    return true;
  } catch {
    return false;
  }
}

export async function openDesktopNotificationSettings(): Promise<boolean> {
  if (!isDesktopShell()) {
    return false;
  }

  return await getElectronBridge()?.openNativeNotificationSettings?.() ?? false;
}
