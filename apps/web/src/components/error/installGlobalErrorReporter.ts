import { debugLog } from "../../lib/debugLog";

// Chromium fires a benign ErrorEvent when ResizeObserver delivery spans frames.
// It is not a crash, so keep it out of the debug/crash pipeline.
function isBenignResizeObserverError(message: string | undefined): boolean {
  return typeof message === "string" && message.includes("ResizeObserver loop");
}

/**
 * Capture uncaught errors that escape React's render boundary — async throws,
 * event-handler errors, and unhandled promise rejections — and force-flush them
 * to the runtime debug log so a crash survives the reload that follows.
 *
 * Returns a disposer that removes the listeners.
 */
export function installGlobalErrorReporter(): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleError = (event: ErrorEvent) => {
    if (isBenignResizeObserverError(event.message)) {
      return;
    }
    const error = event.error instanceof Error ? event.error : null;
    debugLog(
      "app.crash",
      error?.message ?? event.message ?? "Uncaught error",
      {
        kind: "window.error",
        name: error?.name ?? null,
        stack: error?.stack ?? null,
        source: event.filename ?? null,
        line: event.lineno ?? null,
        column: event.colno ?? null,
      },
      { force: true },
    );
  };

  window.addEventListener("error", handleError);

  const handleRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const error = reason instanceof Error ? reason : null;
    debugLog(
      "app.crash",
      error?.message ?? (typeof reason === "string" ? reason : "Unhandled promise rejection"),
      {
        kind: "unhandledrejection",
        name: error?.name ?? null,
        stack: error?.stack ?? null,
      },
      { force: true },
    );
  };

  window.addEventListener("unhandledrejection", handleRejection);

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
