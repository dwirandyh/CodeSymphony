import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGlobalErrorReporter } from "./installGlobalErrorReporter";

const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/debugLog", () => ({
  debugLog: debugLogMock,
}));

describe("installGlobalErrorReporter", () => {
  let dispose: () => void;

  beforeEach(() => {
    debugLogMock.mockClear();
  });

  afterEach(() => {
    dispose?.();
  });

  it("reports an uncaught window error through the debug log", () => {
    dispose = installGlobalErrorReporter();

    const error = new Error("Cannot convert undefined or null to object");
    window.dispatchEvent(new ErrorEvent("error", { message: error.message, error }));

    const crashEntry = debugLogMock.mock.calls.find(([source]) => source === "app.crash");
    expect(crashEntry).toBeDefined();

    const [, message, data, options] = crashEntry!;
    expect(message).toBe("Cannot convert undefined or null to object");
    expect((data as { kind?: string }).kind).toBe("window.error");
    expect((data as { stack?: string | null }).stack).toEqual(expect.any(String));
    expect((options as { force?: boolean }).force).toBe(true);
  });

  it("reports an unhandled promise rejection through the debug log", () => {
    dispose = installGlobalErrorReporter();

    const error = new Error("rejected with null");
    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", { value: error });
    window.dispatchEvent(event);

    const crashEntry = debugLogMock.mock.calls.find(([source]) => source === "app.crash");
    expect(crashEntry).toBeDefined();

    const [, message, data, options] = crashEntry!;
    expect(message).toBe("rejected with null");
    expect((data as { kind?: string }).kind).toBe("unhandledrejection");
    expect((data as { stack?: string | null }).stack).toEqual(expect.any(String));
    expect((options as { force?: boolean }).force).toBe(true);
  });

  it("ignores benign ResizeObserver loop warnings", () => {
    dispose = installGlobalErrorReporter();

    window.dispatchEvent(new ErrorEvent("error", {
      message: "ResizeObserver loop completed with undelivered notifications.",
    }));
    window.dispatchEvent(new ErrorEvent("error", {
      message: "ResizeObserver loop limit exceeded",
    }));

    const crashEntry = debugLogMock.mock.calls.find(([source]) => source === "app.crash");
    expect(crashEntry).toBeUndefined();
  });
});
