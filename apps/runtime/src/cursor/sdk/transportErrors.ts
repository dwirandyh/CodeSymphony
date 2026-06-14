// The Cursor SDK talks to local agents and MCP servers over HTTP/2 via
// `@connectrpc/connect-node`. When a peer (most often an MCP server connection)
// resets an HTTP/2 stream, Node emits the error asynchronously on the stream's
// `'error'` event rather than rejecting the awaited request promise. That error
// surfaces as an unhandled rejection / uncaught exception that escapes every
// try/catch around `runCursorSdkTurn`. With no global handler the runtime
// process crashes mid-turn: the SSE stream dies, the thread run state is never
// cleared, and the client is stuck forever at "waiting for response".
//
// These framing/stream resets are benign with respect to the turn itself — the
// run still reaches a terminal status — so we detect and swallow them at the
// process level instead of letting them take down the runtime.

const CURSOR_SDK_HTTP2_ERROR_CODES = new Set([
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_INVALID_STREAM",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
]);

const CURSOR_SDK_HTTP2_ERROR_MESSAGE =
  /NGHTTP2_(?:FRAME_SIZE_ERROR|INTERNAL_ERROR|PROTOCOL_ERROR|REFUSED_STREAM)|ERR_HTTP2_STREAM_ERROR|Stream closed with error code/i;

export function isCursorSdkHttp2TransportError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CURSOR_SDK_HTTP2_ERROR_CODES.has(code)) {
    return true;
  }

  return CURSOR_SDK_HTTP2_ERROR_MESSAGE.test(error.message);
}
