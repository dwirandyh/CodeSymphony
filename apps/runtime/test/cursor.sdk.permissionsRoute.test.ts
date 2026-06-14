import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCursorSdkPermissionRoutes } from "../src/routes/cursorSdkPermissions.js";
import {
  registerCursorSdkPermissionBridge,
  resetCursorSdkPermissionBridgesForTests,
} from "../src/cursor/sdk/permissionsBridge.js";

describe("Cursor SDK permission routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetCursorSdkPermissionBridgesForTests();
    app = Fastify({ logger: false });
    await app.register(registerCursorSdkPermissionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    resetCursorSdkPermissionBridgesForTests();
  });

  it("handles Cursor hook requests routed by session_id (agent id)", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));
    const bridge = registerCursorSdkPermissionBridge({
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onPermissionRequest,
    });
    bridge.bind("agent-abc");

    const response = await app.inject({
      method: "POST",
      url: "/api/cursor-sdk/permissions",
      payload: {
        hook_event_name: "preToolUse",
        session_id: "agent-abc",
        tool_use_id: "tool 1",
        tool_name: "Shell",
        tool_input: { command: "rm -rf build" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      permission: "deny",
      user_message: "Denied by CodeSymphony permission gate.",
    });
    expect(onPermissionRequest).toHaveBeenCalledOnce();
  });

  it("rejects unknown agent sessions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/cursor-sdk/permissions",
      payload: {
        hook_event_name: "preToolUse",
        session_id: "agent-unknown",
        tool_name: "Shell",
        tool_input: { command: "rm -rf build" },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Cursor SDK permission bridge not found" });
  });
});
