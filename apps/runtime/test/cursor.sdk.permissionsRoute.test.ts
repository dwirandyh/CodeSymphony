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

  it("handles Cursor hook requests through a registered permission bridge", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));
    const bridge = registerCursorSdkPermissionBridge({
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      onPermissionRequest,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/cursor-sdk/permissions/${bridge.token}`,
      payload: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 1",
        tool_name: "Bash",
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

  it("rejects unknown bridge tokens", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/cursor-sdk/permissions/missing-token",
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Cursor SDK permission bridge not found" });
  });
});
