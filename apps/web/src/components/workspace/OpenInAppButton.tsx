import { useState } from "react";
import { ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import type { ExternalApp } from "@codesymphony/shared-types";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { getAppIcon } from "../../lib/appIcons";
import { api } from "../../lib/api";
import { useInstalledApps } from "../../hooks/queries/useInstalledApps";

const PREFERRED_APP_KEY_PREFIX = "codesymphony:preferred-editor";

function getPreferredAppId(targetPath: string): string | null {
  try {
    const specific = localStorage.getItem(`${PREFERRED_APP_KEY_PREFIX}:${targetPath}`);
    if (specific) return specific;
    return localStorage.getItem(PREFERRED_APP_KEY_PREFIX);
  } catch {
    return null;
  }
}

function setPreferredAppId(targetPath: string, appId: string) {
  try {
    localStorage.setItem(`${PREFERRED_APP_KEY_PREFIX}:${targetPath}`, appId);
    localStorage.setItem(PREFERRED_APP_KEY_PREFIX, appId);
  } catch {
    // localStorage not available
  }
}

interface OpenInAppButtonProps {
  targetPath: string;
  className?: string;
}

export function OpenInAppButton({ targetPath, className }: OpenInAppButtonProps) {
  const { data: apps = [], isLoading } = useInstalledApps();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [preferredId, setPreferredId] = useState<string | null>(() => getPreferredAppId(targetPath));

  // Determine selected app: preferred if it exists in the list, else first available
  const selectedApp = apps.find((a) => a.id === preferredId) ?? apps[0] ?? null;

  async function handleSelectApp(app: ExternalApp) {
    setPreferredId(app.id);
    setPreferredAppId(targetPath, app.id);
    setPopoverOpen(false);

    if (opening) return;
    setOpening(true);
    try {
      await api.openInApp({ appId: app.id, targetPath });
    } catch {
      // Could show a toast; for now silently fail
    } finally {
      setOpening(false);
    }
  }

  async function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (!selectedApp || opening) return;
    setOpening(true);
    try {
      await api.openInApp({ appId: selectedApp.id, targetPath });
    } catch {
      // Could show a toast; for now silently fail
    } finally {
      setOpening(false);
    }
  }

  if (isLoading) {
    return (
      <div className={cn("flex h-9 items-center gap-1 text-xs text-muted-foreground", className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
      </div>
    );
  }

  if (apps.length === 0) {
    return null;
  }

  const AppIcon = selectedApp ? getAppIcon(selectedApp.id) : null;

  return (
    <div
      className={cn(
        "inline-flex h-9 items-center rounded-md border border-border text-xs",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Left zone: App selector */}
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full items-center gap-1.5 rounded-l-md px-2.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="Select app"
            onClick={(e) => e.stopPropagation()}
          >
            {AppIcon && <AppIcon className="h-3.5 w-3.5" />}
            <span className="max-w-[80px] truncate">{selectedApp?.name ?? "App"}</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[220px] p-1">
          <div className="space-y-0.5">
            {apps.map((app) => {
              const Icon = getAppIcon(app.id);
              const isSelected = app.id === selectedApp?.id;
              return (
                <button
                  key={app.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary",
                    isSelected && "bg-secondary/60 font-medium text-foreground",
                  )}
                  onClick={() => handleSelectApp(app)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{app.name}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Divider */}
      <div className="h-5 w-px bg-border" />

      {/* Right zone: Open button */}
      <button
        type="button"
        className="flex h-full items-center rounded-r-md px-2.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        title={`Open in ${selectedApp?.name ?? "app"}`}
        disabled={opening || !selectedApp}
        onClick={handleOpen}
      >
        {opening ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ExternalLink className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
