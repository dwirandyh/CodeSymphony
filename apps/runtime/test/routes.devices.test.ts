import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDeviceRoutes } from "../src/routes/devices";

describe("device routes", () => {
  let app: FastifyInstance;
  const getNativeIosStatus = vi.fn();
  const readAndroidClipboard = vi.fn();
  const writeAndroidClipboard = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    app = Fastify({ logger: false });
    await app.register(websocket);
    app.decorate("deviceService", {
      getNativeIosStatus,
      readAndroidClipboard,
      writeAndroidClipboard,
    } as never);
    app.decorate("logService", {
      log: vi.fn(),
      list: vi.fn(),
      subscribe: vi.fn(),
      clear: vi.fn(),
    } as never);
    await app.register(registerDeviceRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/device-streams/:sessionId/android/clipboard returns device clipboard text", async () => {
    readAndroidClipboard.mockResolvedValue("android-clipboard");

    const res = await app.inject({
      method: "GET",
      url: "/api/device-streams/session-1/android/clipboard",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.text).toBe("android-clipboard");
    expect(readAndroidClipboard).toHaveBeenCalledWith("session-1");
  });

  it("PUT /api/device-streams/:sessionId/android/clipboard writes device clipboard text", async () => {
    writeAndroidClipboard.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "PUT",
      url: "/api/device-streams/session-1/android/clipboard",
      payload: {
        paste: true,
        text: "host to android",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(writeAndroidClipboard).toHaveBeenCalledWith("session-1", {
      paste: true,
      text: "host to android",
    });
  });

  it("GET /api/device-streams/:sessionId/native/status returns iOS keyboard sync fields", async () => {
    getNativeIosStatus.mockReturnValue({
      session_info: {
        device_height: 844,
        device_width: 390,
        keyboard_sync_available: true,
        pixel_height: 1688,
        pixel_width: 780,
        software_keyboard_visible: true,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/device-streams/session-1/native/status",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      session_info: {
        device_height: 844,
        device_width: 390,
        keyboard_sync_available: true,
        pixel_height: 1688,
        pixel_width: 780,
        software_keyboard_visible: true,
      },
    });
    expect(getNativeIosStatus).toHaveBeenCalledWith("session-1");
  });
});
