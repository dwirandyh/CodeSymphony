import { isTauriDesktop } from "./openExternalUrl";

export type DesktopNotificationPayload = {
  title: string;
  body: string;
  onClick?: () => void;
};

const MACOS_NOTIFICATION_SETTINGS_URLS = [
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.codesymphony.app",
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
] as const;

function supportsBrowserNotifications(): boolean {
  return typeof Notification !== "undefined";
}

export function supportsDesktopNotifications(): boolean {
  return isTauriDesktop() || supportsBrowserNotifications();
}

export function usesSystemManagedDesktopNotificationPermissions(): boolean {
  return isTauriDesktop();
}

export async function getDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (isTauriDesktop()) {
    return "granted";
  }

  if (!supportsBrowserNotifications()) {
    return "denied";
  }

  return Notification.permission;
}

export async function requestDesktopNotificationPermission(): Promise<NotificationPermission> {
  if (isTauriDesktop()) {
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
  if (isTauriDesktop()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_native_desktop_notification", {
        title: payload.title,
        body: payload.body,
      });
      return true;
    } catch {
      try {
        const { sendNotification } = await import("@tauri-apps/plugin-notification");
        await sendNotification({
          title: payload.title,
          body: payload.body,
        });
        return true;
      } catch {
        return false;
      }
    }
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
  if (!isTauriDesktop()) {
    return false;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");

    await invoke("open_native_notification_settings");
    return true;
  } catch {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");

      for (const href of MACOS_NOTIFICATION_SETTINGS_URLS) {
        try {
          await openUrl(href);
          return true;
        } catch {
          continue;
        }
      }
    } catch {
      return false;
    }
  }

  return false;
}
