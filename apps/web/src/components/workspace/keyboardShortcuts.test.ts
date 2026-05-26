import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SHORTCUTS,
  getVisibleWorkspaceShortcutSections,
  getWorkspaceShortcutLabel,
  matchesFocusChatInputShortcut,
  matchesOpenSettingsShortcut,
  matchesToggleWorkspaceSidebarShortcut,
  resolveWorkspaceShortcutPlatform,
} from "./keyboardShortcuts";

describe("keyboardShortcuts", () => {
  it("resolves shortcut platforms from common platform strings", () => {
    expect(resolveWorkspaceShortcutPlatform("macOS")).toBe("mac");
    expect(resolveWorkspaceShortcutPlatform("Win32")).toBe("windows");
    expect(resolveWorkspaceShortcutPlatform("Linux x86_64")).toBe("linux");
  });

  it("returns the current-platform label for a shortcut definition", () => {
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_settings, "mac")).toBe("Cmd+,");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_settings, "windows")).toBe("Ctrl+,");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.close_active_surface, "linux")).toBeNull();
  });

  it("filters out shortcuts that are unavailable on the selected platform", () => {
    const linuxSections = getVisibleWorkspaceShortcutSections("linux");
    const workspaceSection = linuxSections.find((section) => section.id === "workspace");
    expect(workspaceSection?.shortcuts.some((shortcut) => shortcut.id === "close_active_surface")).toBe(false);
  });

  it("matches the adopted open-settings shortcut on both mac and non-mac layouts", () => {
    expect(matchesOpenSettingsShortcut({
      key: ",",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesOpenSettingsShortcut({
      key: ",",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, false)).toBe(true);
  });

  it("matches the sidebar and focus shortcuts with platform-specific modifiers", () => {
    expect(matchesToggleWorkspaceSidebarShortcut({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesToggleWorkspaceSidebarShortcut({
      key: "B",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);

    expect(matchesFocusChatInputShortcut({
      key: "J",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);
  });

  it("does not match when extra modifiers or default-prevented events are present", () => {
    expect(matchesOpenSettingsShortcut({
      key: ",",
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(false);

    expect(matchesFocusChatInputShortcut({
      key: "j",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: true,
    }, true)).toBe(false);
  });
});
