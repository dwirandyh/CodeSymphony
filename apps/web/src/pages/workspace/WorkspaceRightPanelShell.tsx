import { cn } from "../../lib/utils";

type RightPanelId = "explorer" | "git" | "device" | null;

export function WorkspaceRightPanelShell({
  desktopApp = false,
  rightPanelId,
  gitChangeCount,
  onUpdatePanel,
}: {
  desktopApp?: boolean;
  rightPanelId: RightPanelId;
  gitChangeCount: number;
  onUpdatePanel: (panel: "explorer" | "git" | "device" | undefined) => void;
}) {
  function renderRailButton({
    label,
    shortLabel,
    panelId,
  }: {
    label: string;
    shortLabel: string;
    panelId: Exclude<RightPanelId, null>;
  }) {
    const active = rightPanelId === panelId;

    return (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={cn(
          "relative mb-2 flex h-9 w-9 items-center justify-center rounded-md text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground",
          active && "bg-secondary text-foreground",
        )}
        onClick={() => onUpdatePanel(active ? undefined : panelId)}
      >
        {shortLabel}
        {panelId === "git" && gitChangeCount > 0 ? (
          <span className="absolute right-0.5 top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
            {gitChangeCount > 99 ? "99+" : gitChangeCount}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "mb-1 min-h-0 shrink-0 flex-row bg-card/75 sm:mb-2 lg:mb-0",
        desktopApp ? "flex" : "hidden lg:flex",
      )}
      data-testid="workspace-right-panel-shell"
    >
      {rightPanelId ? (
        <aside
          className="relative flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border/30"
          style={{ width: "320px" }}
        >
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
            Loading panel...
          </div>
        </aside>
      ) : null}

      <nav className="flex w-[48px] shrink-0 flex-col items-center pt-[10px] lg:pt-[14px]">
        {renderRailButton({
          label: "Explorer",
          shortLabel: "E",
          panelId: "explorer",
        })}
        {renderRailButton({
          label: "Source Control",
          shortLabel: "G",
          panelId: "git",
        })}
        {renderRailButton({
          label: "Devices",
          shortLabel: "D",
          panelId: "device",
        })}
      </nav>
    </div>
  );
}
