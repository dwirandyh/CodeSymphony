import { useEffect } from "react";

type AppCrashFallbackProps = {
  error?: Error | null;
  onReload?: () => void;
  onResetHome?: () => void;
};

function isReloadShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r";
}

export function AppCrashFallback({ error, onReload, onResetHome }: AppCrashFallbackProps) {
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!isReloadShortcut(event)) {
        return;
      }

      event.preventDefault();
      onReload?.();
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [onReload]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_rgba(248,113,113,0.12),_transparent_40%),linear-gradient(180deg,_rgba(15,23,42,0.96),_rgba(2,6,23,1))] px-4 py-10 text-foreground">
      <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-background/80 p-6 shadow-2xl backdrop-blur">
        <div className="mb-5">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-destructive/80">App Recovery</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">The app hit a blocking error</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Reload the app to recover without closing the macOS window. If the current route is corrupted, reset back to the workspace home screen.
          </p>
        </div>

        <div className="rounded-2xl border border-border/60 bg-secondary/30 p-4">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Recovery Actions</div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
              onClick={() => onReload?.()}
            >
              Reload App
            </button>
            <button
              type="button"
              className="rounded-xl border border-border/70 bg-background/60 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary/60"
              onClick={() => onResetHome?.()}
            >
              Reset To Home
            </button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Shortcut: <kbd className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[11px]">Cmd/Ctrl + R</kbd>
          </p>
        </div>

        {error?.message ? (
          <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/10 p-4">
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-destructive/80">Error Details</div>
            <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-6 text-destructive">
              {error.message}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
