import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCursorSdkProcessGuardForTests,
  installCursorSdkProcessGuard,
  setCursorSdkProcessGuardLogger,
} from "../src/cursor/sdk/processGuard.js";

function getListeners(event: "unhandledRejection" | "uncaughtException") {
  return process.listeners(event);
}

describe("installCursorSdkProcessGuard", () => {
  let before: {
    unhandledRejection: ReturnType<typeof getListeners>;
    uncaughtException: ReturnType<typeof getListeners>;
  };

  beforeEach(() => {
    __resetCursorSdkProcessGuardForTests();
    before = {
      unhandledRejection: getListeners("unhandledRejection"),
      uncaughtException: getListeners("uncaughtException"),
    };
  });

  afterEach(() => {
    for (const listener of getListeners("unhandledRejection")) {
      if (!before.unhandledRejection.includes(listener)) {
        process.off("unhandledRejection", listener as never);
      }
    }
    for (const listener of getListeners("uncaughtException")) {
      if (!before.uncaughtException.includes(listener)) {
        process.off("uncaughtException", listener as never);
      }
    }
    __resetCursorSdkProcessGuardForTests();
  });

  function newGuardListener(event: "unhandledRejection" | "uncaughtException") {
    const added = getListeners(event).filter((listener) => !before[event].includes(listener));
    expect(added).toHaveLength(1);
    return added[0] as (error: unknown) => void;
  }

  it("swallows benign Cursor SDK HTTP/2 transport rejections", () => {
    const logger = vi.fn();
    installCursorSdkProcessGuard({ logger });
    const handler = newGuardListener("unhandledRejection");

    const transportError = new Error("[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR");
    (transportError as { code?: string }).code = "ERR_HTTP2_STREAM_ERROR";

    expect(() => handler(transportError)).not.toThrow();
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("swallows abort rejections raised during cancelled Cursor SDK turns", () => {
    const logger = vi.fn();
    installCursorSdkProcessGuard({ logger });
    const handler = newGuardListener("unhandledRejection");

    const abortError = new Error("Aborted");
    abortError.name = "AbortError";

    expect(() => handler(abortError)).not.toThrow();
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it("rethrows genuine rejections so they keep crash-loud behavior", () => {
    installCursorSdkProcessGuard();
    const handler = newGuardListener("unhandledRejection");

    const genuine = new Error("real bug");
    expect(() => handler(genuine)).toThrow("real bug");
  });

  it("rethrows genuine uncaught exceptions", () => {
    installCursorSdkProcessGuard();
    const handler = newGuardListener("uncaughtException");

    const genuine = new Error("boom");
    expect(() => handler(genuine)).toThrow("boom");
  });

  it("installs listeners only once", () => {
    installCursorSdkProcessGuard();
    const afterFirst = getListeners("unhandledRejection").length;
    installCursorSdkProcessGuard();
    expect(getListeners("unhandledRejection")).toHaveLength(afterFirst);
  });

  it("routes suppressed transport errors to a logger swapped in after install", () => {
    installCursorSdkProcessGuard();
    const handler = newGuardListener("unhandledRejection");

    const logger = vi.fn();
    setCursorSdkProcessGuardLogger(logger);

    const transportError = new Error("[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR");
    (transportError as { code?: string }).code = "ERR_HTTP2_STREAM_ERROR";

    expect(() => handler(transportError)).not.toThrow();
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "Suppressed benign Cursor SDK async error",
      expect.objectContaining({ kind: "unhandledRejection" }),
    );
  });
});
