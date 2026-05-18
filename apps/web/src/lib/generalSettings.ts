export const GENERAL_SETTINGS_STORAGE_KEY = "codesymphony:workspace:general-settings";
export const AUTO_CONVERT_LONG_TEXT_THRESHOLD = 5000;
export const COMPLETION_SOUND_VOLUME_MIN = 0;
export const COMPLETION_SOUND_VOLUME_MAX = 200;
export const DEFAULT_COMPLETION_SOUND_VOLUME = 140;

export type SendMessagesWith = "enter" | "mod_enter";
export type CompletionSound = "off" | "chime" | "ding" | "pop";

export type GeneralSettings = {
  sendMessagesWith: SendMessagesWith;
  desktopNotificationsEnabled: boolean;
  completionSound: CompletionSound;
  completionSoundVolume: number;
  autoConvertLongTextEnabled: boolean;
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  sendMessagesWith: "enter",
  desktopNotificationsEnabled: false,
  completionSound: "off",
  completionSoundVolume: DEFAULT_COMPLETION_SOUND_VOLUME,
  autoConvertLongTextEnabled: true,
};

function normalizeSendMessagesWith(value: unknown): SendMessagesWith {
  return value === "mod_enter" ? "mod_enter" : "enter";
}

function normalizeCompletionSound(value: unknown): CompletionSound {
  return value === "chime" || value === "ding" || value === "pop" ? value : "off";
}

function normalizeCompletionSoundVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_COMPLETION_SOUND_VOLUME;
  }

  return Math.max(
    COMPLETION_SOUND_VOLUME_MIN,
    Math.min(COMPLETION_SOUND_VOLUME_MAX, Math.round(value)),
  );
}

export function normalizeGeneralSettings(input: unknown): GeneralSettings {
  if (!input || typeof input !== "object") {
    return DEFAULT_GENERAL_SETTINGS;
  }

  const record = input as Partial<Record<keyof GeneralSettings, unknown>>;

  return {
    sendMessagesWith: normalizeSendMessagesWith(record.sendMessagesWith),
    desktopNotificationsEnabled: record.desktopNotificationsEnabled === true,
    completionSound: normalizeCompletionSound(record.completionSound),
    completionSoundVolume: normalizeCompletionSoundVolume(record.completionSoundVolume),
    autoConvertLongTextEnabled: record.autoConvertLongTextEnabled !== false,
  };
}

export function loadGeneralSettings(): GeneralSettings {
  if (typeof window === "undefined") {
    return DEFAULT_GENERAL_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(GENERAL_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_GENERAL_SETTINGS;
    }

    return normalizeGeneralSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_GENERAL_SETTINGS;
  }
}

export function saveGeneralSettings(value: GeneralSettings): GeneralSettings {
  const normalized = normalizeGeneralSettings(value);
  if (typeof window === "undefined") {
    return normalized;
  }

  try {
    window.localStorage.setItem(GENERAL_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage failures and keep the in-memory preferences.
  }

  return normalized;
}

function readPlatform(): string {
  if (typeof navigator === "undefined") {
    return "";
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
}

export function isMacLikePlatform(): boolean {
  return /mac/i.test(readPlatform());
}

export function getModifierEnterLabel(): string {
  return isMacLikePlatform() ? "⌘+Enter" : "Ctrl+Enter";
}

export function getModifierEnterHint(): string {
  return isMacLikePlatform() ? "⌘↵" : "Ctrl+Enter";
}

export function getShiftEnterHint(): string {
  return isMacLikePlatform() ? "⇧↵" : "Shift+Enter";
}

export function hasPrimarySubmitModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacLikePlatform() ? event.metaKey : event.ctrlKey;
}
