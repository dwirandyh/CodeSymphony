import { describe, expect, it, vi } from "vitest";
import {
  buildCursorSdkPermissionHookCommand,
  buildCursorSdkPermissionHookSettings,
  handleCursorSdkPermissionHook,
} from "../src/cursor/sdk/permissionsBridge.js";

describe("Cursor SDK permissions bridge", () => {
  it("maps default-mode PreToolUse hook decisions through onPermissionRequest", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 1",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({
      permission: "deny",
      user_message: "Denied by CodeSymphony permission gate.",
    });
    expect(onPermissionRequest).toHaveBeenCalledWith({
      requestId: "tool1",
      toolName: "Bash",
      toolInput: { command: "rm -rf build" },
      blockedPath: null,
      decisionReason: null,
      suggestions: null,
      canAlwaysAllow: true,
      alwaysAllowScope: "native",
      alwaysAllowDescription: "Uses Cursor hook allow for this request; CodeSymphony records the allow-always decision.",
      subagentOwnerToolUseId: null,
      launcherToolUseId: null,
    });
  });

  it("maps allow_always to hook allow", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "allow_always" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 2",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({ permission: "allow" });
  });

  it("auto-allows full-access threads without prompting", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "full_access",
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 3",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({ permission: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-allows in-worktree edits without prompting", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 4",
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/project/src/main.ts" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({ permission: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("builds Cursor hook settings that POST hook JSON to CodeSymphony", () => {
    const endpointUrl = "http://127.0.0.1:4331/api/cursor-sdk/permissions/token-1";

    const settings = buildCursorSdkPermissionHookSettings(endpointUrl);

    expect(settings).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            command: buildCursorSdkPermissionHookCommand(endpointUrl),
            matcher: "*",
            failClosed: true,
          },
        ],
      },
    });
  });
});
