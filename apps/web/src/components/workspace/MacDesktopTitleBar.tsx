import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "../ui/button";
import { debugLog } from "../../lib/debugLog";
import { isTauriDesktop } from "../../lib/openExternalUrl";
import { cn } from "../../lib/utils";

type MacDesktopTitleBarProps = {
  desktopApp?: boolean;
  appTitle?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  leftPanelVisible: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onToggleLeftPanel: () => void;
  className?: string;
};

const TITLEBAR_FULLSCREEN_SYNC_CHECKPOINTS_MS = [0, 180, 480, 900];

const INTERACTIVE_TITLEBAR_TARGET_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[contenteditable='true']",
].join(", ");

function isInteractiveTitlebarTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_TITLEBAR_TARGET_SELECTOR) !== null;
}

function describeTitlebarTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return { tagName: null, role: null, testId: null };
  }

  return {
    tagName: target.tagName.toLowerCase(),
    role: target.getAttribute("role"),
    testId: target.getAttribute("data-testid"),
  };
}

async function runTitlebarWindowAction(action: "startDragging" | "toggleMaximize", target: EventTarget | null) {
  if (!isTauriDesktop()) {
    return;
  }

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();

    if (action === "startDragging") {
      await currentWindow.startDragging();
      return;
    }

    await currentWindow.toggleMaximize();
  } catch (error) {
    debugLog("desktop.titlebar", `${action}.failed`, {
      target: describeTitlebarTarget(target),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function useMacDesktopFullscreenState() {
  const [fullscreen, setFullscreen] = useState(false);
  const syncGenerationRef = useRef(0);
  const timeoutIdsRef = useRef<number[]>([]);
  const lastLoggedFullscreenRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }

    let disposed = false;
    let currentWindow: {
      isFullscreen: () => Promise<boolean>;
      onResized: (handler: () => void) => Promise<() => void>;
      onMoved: (handler: () => void) => Promise<() => void>;
      onScaleChanged: (handler: () => void) => Promise<() => void>;
      onFocusChanged: (handler: (event: { payload: boolean }) => void) => Promise<() => void>;
    } | null = null;
    const unlistenFns: Array<() => void> = [];

    function clearScheduledSyncs() {
      for (const timeoutId of timeoutIdsRef.current) {
        window.clearTimeout(timeoutId);
      }
      timeoutIdsRef.current = [];
    }

    async function syncFullscreenState(reason: string) {
      if (disposed || currentWindow === null) {
        return;
      }

      try {
        const nextFullscreen = await currentWindow.isFullscreen();
        if (disposed) {
          return;
        }

        setFullscreen((previousFullscreen) => previousFullscreen === nextFullscreen ? previousFullscreen : nextFullscreen);

        if (lastLoggedFullscreenRef.current !== nextFullscreen) {
          lastLoggedFullscreenRef.current = nextFullscreen;
          debugLog("desktop.titlebar", "fullscreen.changed", {
            reason,
            fullscreen: nextFullscreen,
            controlsInset: nextFullscreen ? 12 : 82,
          });
        }
      } catch (error) {
        debugLog("desktop.titlebar", "fullscreen.sync.failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    function scheduleFullscreenSync(reason: string) {
      const generation = ++syncGenerationRef.current;
      clearScheduledSyncs();

      for (const checkpointMs of TITLEBAR_FULLSCREEN_SYNC_CHECKPOINTS_MS) {
        const timeoutId = window.setTimeout(() => {
          if (disposed || syncGenerationRef.current !== generation) {
            return;
          }

          void syncFullscreenState(`${reason}@${checkpointMs}ms`);
        }, checkpointMs);

        timeoutIdsRef.current.push(timeoutId);
      }
    }

    async function registerListeners() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      if (disposed) {
        return;
      }

      currentWindow = getCurrentWindow();
      scheduleFullscreenSync("mount");

      const register = async (subscribe: Promise<() => void>) => {
        const unlisten = await subscribe;
        if (disposed) {
          unlisten();
          return;
        }
        unlistenFns.push(unlisten);
      };

      await Promise.all([
        register(currentWindow.onResized(() => {
          scheduleFullscreenSync("window.resized");
        })),
        register(currentWindow.onMoved(() => {
          scheduleFullscreenSync("window.moved");
        })),
        register(currentWindow.onScaleChanged(() => {
          scheduleFullscreenSync("window.scale_changed");
        })),
        register(currentWindow.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            scheduleFullscreenSync("window.focused");
          }
        })),
      ]);
    }

    void registerListeners().catch((error) => {
      debugLog("desktop.titlebar", "fullscreen.listener.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      disposed = true;
      syncGenerationRef.current += 1;
      clearScheduledSyncs();
      for (const unlisten of unlistenFns) {
        unlisten();
      }
    };
  }, []);

  return fullscreen;
}

export function MacDesktopTitleBar({
  desktopApp = false,
  appTitle = "CodeSymphony",
  canGoBack,
  canGoForward,
  leftPanelVisible,
  onGoBack,
  onGoForward,
  onToggleLeftPanel,
  className,
}: MacDesktopTitleBarProps) {
  const fullscreen = useMacDesktopFullscreenState();

  function handleTitlebarMouseDown(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0 || event.detail !== 1 || event.defaultPrevented || isInteractiveTitlebarTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    debugLog("desktop.titlebar", "startDragging.requested", {
      detail: event.detail,
      target: describeTitlebarTarget(event.target),
    });

    void runTitlebarWindowAction("startDragging", event.target);
  }

  function handleTitlebarDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0 || event.defaultPrevented || isInteractiveTitlebarTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    debugLog("desktop.titlebar", "toggleMaximize.requested", {
      detail: event.detail,
      target: describeTitlebarTarget(event.target),
    });

    void runTitlebarWindowAction("toggleMaximize", event.target);
  }

  return (
    <header
      className={cn(
        "relative h-[38px] shrink-0 select-none border-b border-border/45 bg-card/75",
        desktopApp ? "block" : "hidden lg:block",
        className,
      )}
      onMouseDownCapture={handleTitlebarMouseDown}
      onDoubleClickCapture={handleTitlebarDoubleClick}
      data-testid="mac-titlebar-drag-surface"
      data-titlebar-layout={fullscreen ? "fullscreen" : "windowed"}
    >
      <div
        className={cn(
          "relative flex h-full items-center pr-3 transition-[padding] duration-150",
          fullscreen ? "pl-3" : "pl-[82px]",
        )}
        data-testid="mac-titlebar-controls"
      >
        <div className="z-10 flex items-center gap-1">
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

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-[10rem]">
          <span className="block truncate text-[11px] font-medium leading-none tracking-[0.08em] text-foreground/78">
            {appTitle}
          </span>
        </div>
      </div>
    </header>
  );
}
