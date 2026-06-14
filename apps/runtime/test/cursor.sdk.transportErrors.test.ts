import { describe, expect, it } from "vitest";
import { isCursorSdkHttp2TransportError } from "../src/cursor/sdk/transportErrors.js";

describe("isCursorSdkHttp2TransportError", () => {
  it("matches the NGHTTP2 framing reset surfaced by the Cursor SDK MCP transport", () => {
    const error = new Error("[internal] Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR");
    (error as { code?: string }).code = "ERR_HTTP2_STREAM_ERROR";

    expect(isCursorSdkHttp2TransportError(error)).toBe(true);
  });

  it("matches by error code even when the message is opaque", () => {
    const error = new Error("Stream closed with error code");
    (error as { code?: string }).code = "ERR_HTTP2_SESSION_ERROR";

    expect(isCursorSdkHttp2TransportError(error)).toBe(true);
  });

  it("matches a ConnectError whose code field is not the HTTP/2 code", () => {
    // The real SDK wraps the reset in a ConnectError with code=null but keeps
    // the NGHTTP2 text in the message.
    const error = new Error("[internal] Stream closed with error code NGHTTP2_INTERNAL_ERROR");

    expect(isCursorSdkHttp2TransportError(error)).toBe(true);
  });

  it("does not match genuine application errors", () => {
    expect(isCursorSdkHttp2TransportError(new Error("Invalid params"))).toBe(false);
    expect(isCursorSdkHttp2TransportError(new Error("CURSOR_API_KEY is required"))).toBe(false);
    expect(isCursorSdkHttp2TransportError("just a string")).toBe(false);
    expect(isCursorSdkHttp2TransportError(null)).toBe(false);
  });
});
