import { appendRuntimeDebugLog } from "../../routes/debug.js";
import { isCursorSdkHttp2TransportError } from "./transportErrors.js";

let installed = false;

type ProcessErrorLogger = (message: string, data: Record<string, unknown>) => void;

let activeLogger: ProcessErrorLogger | null = null;

function isBenignCursorSdkAsyncError(error: unknown): boolean {
  if (isCursorSdkHttp2TransportError(error)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError"
    || /abort|cancel/i.test(error.message);
}

function summarize(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: typeof (error as { code?: unknown }).code === "string"
        ? (error as { code?: string }).code
        : null,
    };
  }
  return { name: null, message: String(error), code: null };
}

/**
 * Installs process-level guards that swallow benign HTTP/2 transport resets
 * raised asynchronously by the Cursor SDK's local-agent / MCP connections.
 *
 * Without this, such a rejection escapes every try/catch around a turn and
 * crashes the runtime process mid-stream, leaving threads stuck at "waiting
 * for response". Genuine (non-transport) errors are rethrown so they keep
 * their normal crash-loud behavior.
 *
 * The logger can be swapped after install via {@link setCursorSdkProcessGuardLogger}
 * so early-startup crashes still surface (console fallback) before the runtime's
 * structured log service exists.
 */
export function installCursorSdkProcessGuard(options?: { logger?: ProcessErrorLogger }): void {
  if (options?.logger) {
    activeLogger = options.logger;
  }

  if (installed) {
    return;
  }
  installed = true;

  const handle = (kind: "unhandledRejection" | "uncaughtException", error: unknown): boolean => {
    if (!isBenignCursorSdkAsyncError(error)) {
      return false;
    }

    appendRuntimeDebugLog({
      source: "cursor.sdk.transportGuard",
      message: kind,
      data: summarize(error),
    });
    activeLogger?.("Suppressed benign Cursor SDK async error", {
      kind,
      ...summarize(error),
    });
    return true;
  };

  process.on("unhandledRejection", (reason) => {
    if (handle("unhandledRejection", reason)) {
      return;
    }
    throw reason;
  });

  process.on("uncaughtException", (error) => {
    if (handle("uncaughtException", error)) {
      return;
    }
    throw error;
  });
}

export function setCursorSdkProcessGuardLogger(logger: ProcessErrorLogger): void {
  activeLogger = logger;
}

export function __resetCursorSdkProcessGuardForTests(): void {
  installed = false;
  activeLogger = null;
}
