import { describe, expect, it, vi } from "vitest";
import { buildAndroidSetClipboardMessage } from "./androidScrcpy";
import {
  readAndroidClipboardWithFallback,
  writeAndroidClipboardWithFallback,
} from "./androidClipboardTransport";

describe("androidClipboardTransport", () => {
  it("prefers the runtime clipboard route when it is available", async () => {
    const api = {
      readAndroidClipboard: vi.fn(),
      writeAndroidClipboard: vi.fn().mockResolvedValue(undefined),
    };
    const send = vi.fn();

    await expect(writeAndroidClipboardWithFallback({
      api,
      paste: true,
      sessionId: "session-1",
      socket: {
        readyState: 1,
        send,
      },
      text: "Halo 👋",
    })).resolves.toBe("runtime");

    expect(api.writeAndroidClipboard).toHaveBeenCalledWith("session-1", {
      paste: true,
      text: "Halo 👋",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("falls back to the runtime clipboard route when the viewer socket is unavailable", async () => {
    const api = {
      readAndroidClipboard: vi.fn(),
      writeAndroidClipboard: vi.fn().mockResolvedValue(undefined),
    };

    await expect(writeAndroidClipboardWithFallback({
      api,
      paste: false,
      sessionId: "session-2",
      socket: null,
      text: "runtime clip",
    })).resolves.toBe("runtime");

    expect(api.writeAndroidClipboard).toHaveBeenCalledWith("session-2", {
      paste: false,
      text: "runtime clip",
    });
  });

  it("falls back to the viewer socket when the runtime clipboard route fails", async () => {
    const api = {
      readAndroidClipboard: vi.fn(),
      writeAndroidClipboard: vi.fn().mockRejectedValue(new Error("clipboard helper unavailable")),
    };
    const send = vi.fn();

    await expect(writeAndroidClipboardWithFallback({
      api,
      paste: true,
      sessionId: "session-2b",
      socket: {
        readyState: 1,
        send,
      },
      text: "Halo 👋",
    })).resolves.toBe("viewer");

    expect(send).toHaveBeenCalledTimes(1);
    expect(Array.from(send.mock.calls[0][0] as Uint8Array)).toEqual(
      Array.from(buildAndroidSetClipboardMessage("Halo 👋", true)),
    );
  });

  it("reads clipboard text from the viewer channel when available", async () => {
    const api = {
      readAndroidClipboard: vi.fn(),
      writeAndroidClipboard: vi.fn(),
    };
    const requestFromViewer = vi.fn().mockResolvedValue("viewer clip");

    await expect(readAndroidClipboardWithFallback({
      api,
      requestFromViewer,
      sessionId: "session-3",
    })).resolves.toEqual({
      text: "viewer clip",
      transport: "viewer",
    });

    expect(api.readAndroidClipboard).not.toHaveBeenCalled();
  });

  it("falls back to the runtime clipboard route when the viewer request fails", async () => {
    const api = {
      readAndroidClipboard: vi.fn().mockResolvedValue("runtime clip"),
      writeAndroidClipboard: vi.fn(),
    };
    const requestFromViewer = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(readAndroidClipboardWithFallback({
      api,
      requestFromViewer,
      sessionId: "session-4",
    })).resolves.toEqual({
      text: "runtime clip",
      transport: "runtime",
    });

    expect(api.readAndroidClipboard).toHaveBeenCalledWith("session-4");
  });
});
