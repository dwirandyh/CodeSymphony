import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "../ui/button";
import { isTauriDesktop } from "../../lib/openExternalUrl";
import { cn } from "../../lib/utils";

type MacDesktopTitleBarProps = {
  appTitle?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  leftPanelVisible: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onToggleLeftPanel: () => void;
  className?: string;
};

const MACOS_FULLSCREEN_EVENT = "codesymphony://fullscreen-changed";
const MACOS_FULLSCREEN_SYNC_DELAYS_MS = [0, 180, 520, 980] as const;
const MACOS_FULLSCREEN_VIEWPORT_TOLERANCE = 6;

function detectLikelyFullscreenViewport() {
  if (typeof window === "undefined") {
    return false;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const screenWidth = window.screen.availWidth || window.screen.width;
  const screenHeight = window.screen.availHeight || window.screen.height;

  if (viewportWidth < 1 || viewportHeight < 1 || screenWidth < 1 || screenHeight < 1) {
    return false;
  }

  return (
    viewportWidth >= screenWidth - MACOS_FULLSCREEN_VIEWPORT_TOLERANCE
    && viewportHeight >= screenHeight - MACOS_FULLSCREEN_VIEWPORT_TOLERANCE
  );
}

export function MacDesktopTitleBar({
  appTitle = "CodeSymphony",
  canGoBack,
  canGoForward,
  leftPanelVisible,
  onGoBack,
  onGoForward,
  onToggleLeftPanel,
  className,
}: MacDesktopTitleBarProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isFullscreenRef = useRef(false);
  const syncTimeoutIdsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }

    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unlistenCallbacks: Array<() => void> = [];

    const clearScheduledFullscreenSync = () => {
      for (const timeoutId of syncTimeoutIdsRef.current) {
        window.clearTimeout(timeoutId);
      }
      syncTimeoutIdsRef.current = [];
    };

    const applyFullscreenState = (nextIsFullscreen: boolean) => {
      if (disposed || nextIsFullscreen === isFullscreenRef.current) {
        return;
      }

      isFullscreenRef.current = nextIsFullscreen;
      setIsFullscreen(nextIsFullscreen);
    };

    const syncFullscreenState = async (preferredState?: boolean) => {
      let nextIsFullscreen = preferredState;

      if (typeof nextIsFullscreen !== "boolean") {
        try {
          nextIsFullscreen = await currentWindow.isFullscreen();
        } catch {
          nextIsFullscreen = undefined;
        }
      }

      if (nextIsFullscreen !== true) {
        nextIsFullscreen = detectLikelyFullscreenViewport();
      }

      applyFullscreenState(nextIsFullscreen);
    };

    const scheduleFullscreenSync = (preferredState?: boolean) => {
      clearScheduledFullscreenSync();
      syncTimeoutIdsRef.current = MACOS_FULLSCREEN_SYNC_DELAYS_MS.map((delayMs) =>
        window.setTimeout(() => {
          void syncFullscreenState(delayMs === 0 ? preferredState : undefined);
        }, delayMs),
      );
    };

    void syncFullscreenState();

    void currentWindow
      .listen<boolean>(MACOS_FULLSCREEN_EVENT, ({ payload }) => {
        const nextIsFullscreen = payload === true;
        applyFullscreenState(nextIsFullscreen);
        scheduleFullscreenSync(nextIsFullscreen);
      })
      .then((callback) => {
        if (disposed) {
          callback();
          return;
        }

        unlistenCallbacks.push(callback);
      })
      .catch(() => {
        // Ignore custom fullscreen event registration failures outside the Tauri shell.
      });

    for (const registerListener of [
      currentWindow.onResized.bind(currentWindow),
      currentWindow.onFocusChanged.bind(currentWindow),
      currentWindow.onScaleChanged.bind(currentWindow),
    ]) {
      void registerListener(() => {
        scheduleFullscreenSync();
      })
        .then((callback) => {
          if (disposed) {
            callback();
            return;
          }

          unlistenCallbacks.push(callback);
        })
        .catch(() => {
          // Ignore desktop event registration failures outside the Tauri shell.
        });
    }

    const handleViewportChange = () => {
      scheduleFullscreenSync();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("focus", handleViewportChange);
    document.addEventListener("visibilitychange", handleViewportChange);

    return () => {
      disposed = true;
      clearScheduledFullscreenSync();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("focus", handleViewportChange);
      document.removeEventListener("visibilitychange", handleViewportChange);
      for (const callback of unlistenCallbacks) {
        if (typeof callback === "function") {
          callback();
        }
      }
    };
  }, []);

  function handleDragStart(event: ReactMouseEvent<HTMLDivElement>) {
    if (!isTauriDesktop() || event.button !== 0 || event.defaultPrevented) {
      return;
    }

    if (event.target instanceof HTMLElement) {
      const interactiveTarget = event.target.closest("button, a, input, textarea, select, [role='button']");
      if (interactiveTarget) {
        return;
      }
    }

    const dragAttempt = getCurrentWindow().startDragging();
    void Promise.resolve(dragAttempt).catch(() => {
      // Ignore drag-start failures outside the desktop shell.
    });
  }

  return (
    <header
      className={cn(
        "relative hidden h-[38px] shrink-0 select-none border-b border-border/45 bg-card/75 lg:block",
        className,
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 right-0 transition-[left] duration-150 ease-out",
          isFullscreen ? "left-0" : "left-[72px]",
        )}
        data-tauri-drag-region
        onMouseDown={handleDragStart}
        data-testid="mac-titlebar-drag-surface"
        aria-hidden="true"
      />

      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 z-10 flex items-center pr-3 translate-y-[2px] transition-[left] duration-150 ease-out",
          isFullscreen ? "left-3" : "left-[82px]",
        )}
        data-testid="mac-titlebar-controls"
      >
        <div className="pointer-events-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={leftPanelVisible ? "Hide left panel" : "Show left panel"}
            title={leftPanelVisible ? "Hide left panel" : "Show left panel"}
            className="h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-secondary/45 hover:text-foreground"
            onClick={onToggleLeftPanel}
            data-testid="mac-titlebar-left-toggle"
          >
            {leftPanelVisible ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Go back"
            title="Go back"
            className="h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-secondary/45 hover:text-foreground"
            disabled={!canGoBack}
            onClick={onGoBack}
            data-testid="mac-titlebar-back"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Go forward"
            title="Go forward"
            className="h-6 w-6 shrink-0 rounded-md text-muted-foreground hover:bg-secondary/45 hover:text-foreground"
            disabled={!canGoForward}
            onClick={onGoForward}
            data-testid="mac-titlebar-forward"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 flex translate-y-[2px] items-center justify-center px-[10rem]">
        <span className="block truncate text-[11px] font-medium leading-none tracking-[0.08em] text-foreground/78">
          {appTitle}
        </span>
      </div>
    </header>
  );
}
