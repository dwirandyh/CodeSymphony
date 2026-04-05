import type { LucideIcon } from "lucide-react";
import { Code2, Terminal, Braces, Monitor, SquareTerminal } from "lucide-react";

const APP_ICONS: Record<string, LucideIcon> = {
  // Editors / IDEs
  vscode: Code2,
  cursor: Code2,
  zed: Braces,
  "android-studio": Code2,
  intellij: Code2,
  webstorm: Code2,
  sublime: Code2,
  xcode: Monitor,
  fleet: Code2,
  nova: Code2,
  // Terminals
  terminal: Terminal,
  iterm: SquareTerminal,
  warp: SquareTerminal,
  ghostty: SquareTerminal,
};

const DEFAULT_APP_ICON: LucideIcon = Code2;

export function getAppIcon(appId: string): LucideIcon {
  return APP_ICONS[appId] ?? DEFAULT_APP_ICON;
}
