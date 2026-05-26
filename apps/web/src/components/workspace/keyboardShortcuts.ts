export type WorkspaceShortcutPlatform = "mac" | "windows" | "linux";

export type WorkspaceShortcutId =
  | "open_settings"
  | "toggle_workspace_sidebar"
  | "focus_chat_input"
  | "quick_file_picker"
  | "close_active_surface"
  | "save_active_file"
  | "find_terminal";

export type WorkspaceShortcutSectionId = "workspace" | "editor" | "terminal";

type WorkspaceShortcutDefinition = {
  id: WorkspaceShortcutId;
  label: string;
  description: string;
  scope: string;
  bindings: Record<WorkspaceShortcutPlatform, string | null>;
};

type WorkspaceShortcutSection = {
  id: WorkspaceShortcutSectionId;
  label: string;
  description: string;
  shortcutIds: WorkspaceShortcutId[];
};

export const WORKSPACE_SHORTCUTS: Record<WorkspaceShortcutId, WorkspaceShortcutDefinition> = {
  open_settings: {
    id: "open_settings",
    label: "Open settings",
    description: "Open the workspace settings view.",
    scope: "Global",
    bindings: {
      mac: "Cmd+,",
      windows: "Ctrl+,",
      linux: "Ctrl+,",
    },
  },
  toggle_workspace_sidebar: {
    id: "toggle_workspace_sidebar",
    label: "Toggle repositories sidebar",
    description: "Show or hide the left repository/worktree sidebar.",
    scope: "Global",
    bindings: {
      mac: "Cmd+B",
      windows: "Ctrl+Shift+B",
      linux: "Ctrl+Shift+B",
    },
  },
  focus_chat_input: {
    id: "focus_chat_input",
    label: "Focus chat input",
    description: "Jump back to the chat composer from other workspace surfaces.",
    scope: "Global",
    bindings: {
      mac: "Cmd+J",
      windows: "Ctrl+Shift+J",
      linux: "Ctrl+Shift+J",
    },
  },
  quick_file_picker: {
    id: "quick_file_picker",
    label: "Open quick file picker",
    description: "Search files in the current worktree and open one immediately.",
    scope: "Global",
    bindings: {
      mac: "Cmd+Shift+O",
      windows: "Ctrl+Shift+O",
      linux: "Ctrl+Shift+O",
    },
  },
  close_active_surface: {
    id: "close_active_surface",
    label: "Close active surface",
    description: "Close the active file, review tab, terminal tab, automation view, or chat thread.",
    scope: "Contextual",
    bindings: {
      mac: "Cmd+W",
      windows: null,
      linux: null,
    },
  },
  save_active_file: {
    id: "save_active_file",
    label: "Save active file",
    description: "Save the current file in the editor.",
    scope: "File editor",
    bindings: {
      mac: "Cmd+S",
      windows: "Ctrl+S",
      linux: "Ctrl+S",
    },
  },
  find_terminal: {
    id: "find_terminal",
    label: "Find in terminal",
    description: "Search within the visible terminal buffer.",
    scope: "Terminal focus",
    bindings: {
      mac: "Cmd+F",
      windows: "Ctrl+F",
      linux: "Ctrl+F",
    },
  },
};

export const WORKSPACE_SHORTCUT_SECTIONS: WorkspaceShortcutSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    description: "Shortcut set for workspace actions that are currently available in CodeSymphony.",
    shortcutIds: [
      "open_settings",
      "toggle_workspace_sidebar",
      "focus_chat_input",
      "quick_file_picker",
      "close_active_surface",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "File editing shortcuts that are already supported in the current editor surface.",
    shortcutIds: ["save_active_file"],
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Shortcuts that work while a terminal tab is focused.",
    shortcutIds: ["find_terminal"],
  },
];

type ShortcutKeyboardEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented">;

export function resolveWorkspaceShortcutPlatform(platform?: string): WorkspaceShortcutPlatform {
  const value = (platform ?? readNavigatorPlatform()).toLowerCase();
  if (value.includes("mac")) {
    return "mac";
  }
  if (value.includes("win")) {
    return "windows";
  }
  return "linux";
}

export function getWorkspaceShortcutLabel(
  shortcut: WorkspaceShortcutDefinition,
  platform?: WorkspaceShortcutPlatform | string,
): string | null {
  const resolvedPlatform = platform === "mac" || platform === "windows" || platform === "linux"
    ? platform
    : resolveWorkspaceShortcutPlatform(platform);
  return shortcut.bindings[resolvedPlatform];
}

export function getVisibleWorkspaceShortcutSections(platform?: WorkspaceShortcutPlatform | string): Array<{
  id: WorkspaceShortcutSectionId;
  label: string;
  description: string;
  shortcuts: WorkspaceShortcutDefinition[];
}> {
  return WORKSPACE_SHORTCUT_SECTIONS.map((section) => ({
    ...section,
    shortcuts: section.shortcutIds
      .map((shortcutId) => WORKSPACE_SHORTCUTS[shortcutId])
      .filter((shortcut) => getWorkspaceShortcutLabel(shortcut, platform) !== null),
  })).filter((section) => section.shortcuts.length > 0);
}

export function matchesOpenSettingsShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, ",");
}

export function matchesToggleWorkspaceSidebarShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "b", { shift: !isMac });
}

export function matchesFocusChatInputShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "j", { shift: !isMac });
}

function matchesPrimaryShortcut(
  event: ShortcutKeyboardEvent,
  isMac: boolean,
  key: string,
  options?: {
    shift?: boolean;
  },
): boolean {
  if (event.defaultPrevented) {
    return false;
  }

  if (event.altKey) {
    return false;
  }

  if (event.shiftKey !== (options?.shift ?? false)) {
    return false;
  }

  if (isMac) {
    if (!event.metaKey || event.ctrlKey) {
      return false;
    }
  } else if (!event.ctrlKey || event.metaKey) {
    return false;
  }

  return event.key.toLowerCase() === key;
}

function readNavigatorPlatform(): string {
  if (typeof navigator === "undefined") {
    return "mac";
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return navigatorWithUserAgentData.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "mac";
}
