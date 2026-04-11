import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTauriDesktop, openExternalUrl, shouldOpenInExternalApp } from "./openExternalUrl";

const { openUrlMock, logMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(),
  logMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

vi.mock("./logService", () => ({
  logService: {
    log: logMock,
  },
}));

describe("openExternalUrl", () => {
  const originalTauriInternals = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

  beforeEach(() => {
    openUrlMock.mockReset();
    logMock.mockReset();
    vi.spyOn(window, "open").mockImplementation(() => null);
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.history.replaceState({}, "", "/workspace");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof originalTauriInternals === "undefined") {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    } else {
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = originalTauriInternals;
    }
  });

  it("detects tauri desktop when internals are injected", () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isTauriDesktop()).toBe(true);
  });

  it("opens links via browser tabs outside tauri", async () => {
    await openExternalUrl("https://example.com");

    expect(window.open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opening external URL", {
      href: "https://example.com",
      environment: "browser",
    });
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opened external URL", {
      href: "https://example.com",
      environment: "browser",
    });
  });

  it("opens links via tauri opener inside desktop", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await openExternalUrl("https://example.com");

    expect(openUrlMock).toHaveBeenCalledWith("https://example.com");
    expect(window.open).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opening external URL", {
      href: "https://example.com",
      environment: "tauri",
    });
    expect(logMock).toHaveBeenCalledWith("info", "external-link", "Opened external URL", {
      href: "https://example.com",
      environment: "tauri",
    });
  });

  it("logs opener failures and rethrows", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    openUrlMock.mockRejectedValueOnce(new Error("open failed"));

    await expect(openExternalUrl("https://example.com")).rejects.toThrow("open failed");

    expect(logMock).toHaveBeenCalledWith("error", "external-link", "Failed to open external URL", {
      href: "https://example.com",
      environment: "tauri",
      error: "open failed",
    });
  });
});

describe("shouldOpenInExternalApp", () => {
  it("opens external http urls outside the current origin", () => {
    window.history.replaceState({}, "", "/workspace");

    expect(shouldOpenInExternalApp("https://github.com/tauri-apps/tauri")).toBe(true);
  });

  it("keeps same-origin app links internal", () => {
    window.history.replaceState({}, "", "/workspace");

    expect(shouldOpenInExternalApp("/settings")).toBe(false);
    expect(shouldOpenInExternalApp(`${window.location.origin}/repositories`)).toBe(false);
  });

  it("treats mailto links as external", () => {
    expect(shouldOpenInExternalApp("mailto:test@example.com")).toBe(true);
  });
});
