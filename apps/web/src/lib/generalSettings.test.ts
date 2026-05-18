import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETION_SOUND_VOLUME_MAX,
  COMPLETION_SOUND_VOLUME_MIN,
  DEFAULT_GENERAL_SETTINGS,
  GENERAL_SETTINGS_STORAGE_KEY,
  loadGeneralSettings,
  normalizeGeneralSettings,
  saveGeneralSettings,
} from "./generalSettings";

describe("generalSettings", () => {
  afterEach(() => {
    window.localStorage.removeItem(GENERAL_SETTINGS_STORAGE_KEY);
  });

  it("falls back to defaults for invalid input", () => {
    expect(normalizeGeneralSettings(null)).toEqual(DEFAULT_GENERAL_SETTINGS);
    expect(normalizeGeneralSettings({ sendMessagesWith: "weird" })).toEqual(DEFAULT_GENERAL_SETTINGS);
  });

  it("clamps completion sound volume into the supported range", () => {
    expect(normalizeGeneralSettings({ completionSoundVolume: -20 }).completionSoundVolume)
      .toBe(COMPLETION_SOUND_VOLUME_MIN);
    expect(normalizeGeneralSettings({ completionSoundVolume: 999 }).completionSoundVolume)
      .toBe(COMPLETION_SOUND_VOLUME_MAX);
  });

  it("persists and reloads valid settings", () => {
    const saved = saveGeneralSettings({
      sendMessagesWith: "mod_enter",
      desktopNotificationsEnabled: true,
      completionSound: "pop",
      completionSoundVolume: 165,
      autoConvertLongTextEnabled: false,
    });

    expect(saved).toEqual({
      sendMessagesWith: "mod_enter",
      desktopNotificationsEnabled: true,
      completionSound: "pop",
      completionSoundVolume: 165,
      autoConvertLongTextEnabled: false,
    });
    expect(loadGeneralSettings()).toEqual(saved);
  });
});
