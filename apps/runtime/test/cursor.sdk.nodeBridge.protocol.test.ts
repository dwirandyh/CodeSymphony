import { describe, expect, it } from "vitest";
import { parseCursorSdkNodeTurnOutboundLine } from "../src/cursor/sdk/nodeTurnBridge.js";

describe("Cursor SDK node bridge protocol parsing", () => {
  it("parses ready handshake lines", () => {
    expect(parseCursorSdkNodeTurnOutboundLine('{"type":"ready"}')).toEqual({ type: "ready" });
  });

  it("parses done result lines", () => {
    expect(parseCursorSdkNodeTurnOutboundLine(JSON.stringify({
      type: "done",
      result: { output: "ok", sessionId: "agent-1" },
    }))).toEqual({
      type: "done",
      result: { output: "ok", sessionId: "agent-1" },
    });
  });

  it("ignores non-protocol stdout noise instead of throwing", () => {
    expect(parseCursorSdkNodeTurnOutboundLine("Selected cursor model: \"composer-2.5\".")).toBeNull();
    expect(parseCursorSdkNodeTurnOutboundLine("nullx")).toBeNull();
    expect(parseCursorSdkNodeTurnOutboundLine("[debug] streaming event")).toBeNull();
  });

  it("ignores JSON objects that are not bridge protocol messages", () => {
    expect(parseCursorSdkNodeTurnOutboundLine('{"foo":"bar"}')).toBeNull();
  });
});