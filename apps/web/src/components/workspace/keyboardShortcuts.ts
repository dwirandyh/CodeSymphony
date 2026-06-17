export type WorkspaceShortcutPlatform = "mac" | "windows" | "linux";

export type WorkspaceShortcutId =
  | "open_settings"
  | "toggle_workspace_sidebar"
  | "focus_chat_input"
  | "quick_file_picker"
  | "open_in_app"
  | "open_pull_request"
  | "close_active_surface"
  | "create_terminal"
  | "create_thread"
  | "previous_session_tab"
  | "next_session_tab"
  | "previous_worktree"
  | "next_worktree"
  | "jump_worktree"
  | "navigate_back"
  | "navigate_forward"
  | "save_active_file"
  | "find_terminal"
  | "split_active_tab"
  | "focus_editor_group_left"
  | "focus_editor_group_right";

export type WorkspaceShortcutSectionId = "workspace" | "sessions" | "worktrees" | "navigation" | "editor" | "terminal";

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
  open_in_app: {
    id: "open_in_app",
    label: "Open in app",
    description: "Open the current worktree in the preferred desktop app.",
    scope: "Global",
    bindings: {
      mac: "Cmd+Shift+A",
      windows: "Ctrl+Shift+A",
      linux: "Ctrl+Shift+A",
    },
  },
  open_pull_request: {
    id: "open_pull_request",
    label: "Open pull request",
    description: "Open the existing pull request or merge request for the current worktree.",
    scope: "Global",
    bindings: {
      mac: "Cmd+G",
      windows: "Ctrl+G",
      linux: "Ctrl+G",
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
  create_terminal: {
    id: "create_terminal",
    label: "Create new terminal",
    description: "Create a terminal tab for the active worktree.",
    scope: "Session tabs",
    bindings: {
      mac: "Cmd+Shift+T",
      windows: "Ctrl+Shift+Alt+T",
      linux: "Ctrl+Shift+Alt+T",
    },
  },
  create_thread: {
    id: "create_thread",
    label: "Create new thread",
    description: "Create a chat thread for the active worktree.",
    scope: "Session tabs",
    bindings: {
      mac: "Cmd+T",
      windows: "Ctrl+Shift+T",
      linux: "Ctrl+Shift+T",
    },
  },
  previous_session_tab: {
    id: "previous_session_tab",
    label: "Previous session tab",
    description: "Move to the previous thread, terminal, review, or file tab.",
    scope: "Session tabs",
    bindings: {
      mac: "Cmd+Alt+Left",
      windows: "Ctrl+Shift+Alt+Left",
      linux: "Ctrl+Shift+Alt+Left",
    },
  },
  next_session_tab: {
    id: "next_session_tab",
    label: "Next session tab",
    description: "Move to the next thread, terminal, review, or file tab.",
    scope: "Session tabs",
    bindings: {
      mac: "Cmd+Alt+Right",
      windows: "Ctrl+Shift+Alt+Right",
      linux: "Ctrl+Shift+Alt+Right",
    },
  },
  previous_worktree: {
    id: "previous_worktree",
    label: "Previous worktree",
    description: "Select the previous visible worktree in the sidebar.",
    scope: "Repository and worktree navigation",
    bindings: {
      mac: "Cmd+Alt+Up",
      windows: "Ctrl+Shift+Alt+Up",
      linux: "Ctrl+Shift+Alt+Up",
    },
  },
  next_worktree: {
    id: "next_worktree",
    label: "Next worktree",
    description: "Select the next visible worktree in the sidebar.",
    scope: "Repository and worktree navigation",
    bindings: {
      mac: "Cmd+Alt+Down",
      windows: "Ctrl+Shift+Alt+Down",
      linux: "Ctrl+Shift+Alt+Down",
    },
  },
  jump_worktree: {
    id: "jump_worktree",
    label: "Jump to worktree 1-9",
    description: "Jump to a visible worktree by sidebar order.",
    scope: "Repository and worktree navigation",
    bindings: {
      mac: "Cmd+1-9",
      windows: "Ctrl+Shift+1-9",
      linux: "Ctrl+Shift+1-9",
    },
  },
  navigate_back: {
    id: "navigate_back",
    label: "Navigate back",
    description: "Move back through workspace navigation history.",
    scope: "Workspace navigation history",
    bindings: {
      mac: "Cmd+[",
      windows: "Ctrl+Shift+[",
      linux: "Ctrl+Shift+[",
    },
  },
  navigate_forward: {
    id: "navigate_forward",
    label: "Navigate forward",
    description: "Move forward through workspace navigation history.",
    scope: "Workspace navigation history",
    bindings: {
      mac: "Cmd+]",
      windows: "Ctrl+Shift+]",
      linux: "Ctrl+Shift+]",
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
  split_active_tab: {
    id: "split_active_tab",
    label: "Split active tab",
    description: "Move the active session tab into the next editor column (split editor).",
    scope: "Editor layout",
    bindings: {
      mac: "Cmd+\\",
      windows: "Ctrl+\\",
      linux: "Ctrl+\\",
    },
  },
  focus_editor_group_left: {
    id: "focus_editor_group_left",
    label: "Focus left editor group",
    description: "Focus the left editor column and its active tab.",
    scope: "Editor layout",
    bindings: {
      mac: "Cmd+1",
      windows: "Ctrl+1",
      linux: "Ctrl+1",
    },
  },
  focus_editor_group_right: {
    id: "focus_editor_group_right",
    label: "Focus right editor group",
    description: "Focus the right editor column when split is active.",
    scope: "Editor layout",
    bindings: {
      mac: "Cmd+2",
      windows: "Ctrl+2",
      linux: "Ctrl+2",
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
      "open_in_app",
      "open_pull_request",
      "close_active_surface",
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Shortcuts for thread, terminal, review, and file tabs.",
    shortcutIds: [
      "create_terminal",
      "create_thread",
      "previous_session_tab",
      "next_session_tab",
    ],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    description: "Shortcuts for visible sidebar worktrees.",
    shortcutIds: [
      "previous_worktree",
      "next_worktree",
      "jump_worktree",
    ],
  },
  {
    id: "navigation",
    label: "Navigation",
    description: "Shortcuts for workspace navigation history.",
    shortcutIds: [
      "navigate_back",
      "navigate_forward",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "File editing shortcuts that are already supported in the current editor surface.",
    shortcutIds: [
      "save_active_file",
      "split_active_tab",
      "focus_editor_group_left",
      "focus_editor_group_right",
    ],
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
  const binding = shortcut.bindings[resolvedPlatform];
  if (!binding) {
    return null;
  }
  return resolvedPlatform === "mac" ? formatMacShortcutLabel(binding) : binding;
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

export function matchesOpenInAppShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "a", { shift: true });
}

export function matchesOpenPullRequestShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "g");
}

export function matchesCreateTerminalShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "t", { shift: true, alt: !isMac });
}

export function matchesCreateThreadShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "t", { shift: !isMac });
}

export function matchesPreviousSessionTabShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "arrowleft", { alt: true, shift: !isMac });
}

export function matchesNextSessionTabShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "arrowright", { alt: true, shift: !isMac });
}

export function matchesPreviousWorktreeShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "arrowup", { alt: true, shift: !isMac });
}

export function matchesNextWorktreeShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "arrowdown", { alt: true, shift: !isMac });
}

export function getJumpToWorktreeShortcutIndex(event: ShortcutKeyboardEvent, isMac: boolean): number | null {
  const key = event.key.length === 1 ? event.key : "";
  if (!/^[1-9]$/.test(key)) {
    return null;
  }

  if (!matchesPrimaryShortcut(event, isMac, key, { shift: !isMac })) {
    return null;
  }

  return Number.parseInt(key, 10) - 1;
}

export function matchesNavigateBackShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "[", { shift: !isMac });
}

export function matchesNavigateForwardShortcut(event: ShortcutKeyboardEvent, isMac: boolean): boolean {
  return matchesPrimaryShortcut(event, isMac, "]", { shift: !isMac });
}

function matchesPrimaryShortcut(
  event: ShortcutKeyboardEvent,
  isMac: boolean,
  key: string,
  options?: {
    alt?: boolean;
    shift?: boolean;
  },
): boolean {
  if (event.defaultPrevented) {
    return false;
  }

  if (event.altKey !== (options?.alt ?? false)) {
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

  return event.key.toLowerCase() === key.toLowerCase();
}

function formatMacShortcutLabel(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      switch (part) {
        case "Cmd":
          return "⌘";
        case "Shift":
          return "⇧";
        case "Alt":
          return "⌥";
        case "Ctrl":
          return "⌃";
        case "Left":
          return "←";
        case "Right":
          return "→";
        case "Up":
          return "↑";
        case "Down":
          return "↓";
        default:
          return part;
      }
    })
    .join("");
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
