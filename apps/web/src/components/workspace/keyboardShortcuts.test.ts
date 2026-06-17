import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SHORTCUTS,
  getJumpToWorktreeShortcutIndex,
  getVisibleWorkspaceShortcutSections,
  getWorkspaceShortcutLabel,
  matchesCreateTerminalShortcut,
  matchesCreateThreadShortcut,
  matchesFocusChatInputShortcut,
  matchesNavigateBackShortcut,
  matchesNavigateForwardShortcut,
  matchesNextSessionTabShortcut,
  matchesNextWorktreeShortcut,
  matchesOpenInAppShortcut,
  matchesOpenPullRequestShortcut,
  matchesOpenSettingsShortcut,
  matchesPreviousSessionTabShortcut,
  matchesPreviousWorktreeShortcut,
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
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_settings, "mac")).toBe("⌘,");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_settings, "windows")).toBe("Ctrl+,");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_in_app, "mac")).toBe("⌘⇧A");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_in_app, "windows")).toBe("Ctrl+Shift+A");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_pull_request, "mac")).toBe("⌘G");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.open_pull_request, "windows")).toBe("Ctrl+G");
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.close_active_surface, "linux")).toBeNull();
  });

  it("lists editor layout shortcuts including split and focus groups", () => {
    const macSections = getVisibleWorkspaceShortcutSections("mac");
    const editor = macSections.find((section) => section.id === "editor");
    expect(editor?.shortcuts.map((s) => s.id)).toEqual([
      "save_active_file",
      "split_active_tab",
      "focus_editor_group_left",
      "focus_editor_group_right",
    ]);
    expect(getWorkspaceShortcutLabel(WORKSPACE_SHORTCUTS.split_active_tab, "mac")).toBe("⌘\\");
  });

  it("filters out shortcuts that are unavailable on the selected platform", () => {
    const linuxSections = getVisibleWorkspaceShortcutSections("linux");
    const workspaceSection = linuxSections.find((section) => section.id === "workspace");
    expect(workspaceSection?.shortcuts.some((shortcut) => shortcut.id === "close_active_surface")).toBe(false);
    expect(linuxSections.find((section) => section.id === "sessions")?.shortcuts).toHaveLength(4);
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

  it("has unique platform bindings for shortcuts with a concrete binding", () => {
    for (const platform of ["mac", "windows", "linux"] as const) {
      const bindings = Object.values(WORKSPACE_SHORTCUTS)
        .map((shortcut) => shortcut.bindings[platform])
        .filter((binding): binding is string => binding != null);

      expect(new Set(bindings).size).toBe(bindings.length);
    }
  });

  it("matches open-in-app and open-pull-request shortcuts", () => {
    expect(matchesOpenInAppShortcut({
      key: "A",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesOpenInAppShortcut({
      key: "a",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);

    expect(matchesOpenPullRequestShortcut({
      key: "g",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesOpenPullRequestShortcut({
      key: "G",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, false)).toBe(true);
  });

  it("matches create session shortcuts from the ADR", () => {
    expect(matchesCreateTerminalShortcut({
      key: "T",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesCreateTerminalShortcut({
      key: "T",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);

    expect(matchesCreateThreadShortcut({
      key: "t",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesCreateThreadShortcut({
      key: "T",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);
  });

  it("matches session tab traversal shortcuts from the ADR", () => {
    expect(matchesPreviousSessionTabShortcut({
      key: "ArrowLeft",
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesNextSessionTabShortcut({
      key: "ArrowRight",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);
  });

  it("matches worktree navigation shortcuts from the ADR", () => {
    expect(matchesPreviousWorktreeShortcut({
      key: "ArrowUp",
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesNextWorktreeShortcut({
      key: "ArrowDown",
      metaKey: false,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);

    expect(getJumpToWorktreeShortcutIndex({
      key: "3",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(2);

    expect(getJumpToWorktreeShortcutIndex({
      key: "9",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(8);
  });

  it("matches workspace navigation history shortcuts from the ADR", () => {
    expect(matchesNavigateBackShortcut({
      key: "[",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
    }, true)).toBe(true);

    expect(matchesNavigateForwardShortcut({
      key: "]",
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      defaultPrevented: false,
    }, false)).toBe(true);
  });
});
