import { describe, expect, it } from "vitest";
import { __testing } from "../src/opencode/sessionRunner";
import { DEFAULT_CHAT_MODEL_BY_AGENT } from "@codesymphony/shared-types";

describe("opencode session runner config", () => {
  it("defaults OpenCode threads to a free built-in model", () => {
    expect(DEFAULT_CHAT_MODEL_BY_AGENT.opencode).toBe("opencode/minimax-m2.5-free");
  });

  it("applies ask permissions to both build and plan agents for default threads", () => {
    const { config, agent, model } = __testing.buildOpencodeRuntimeConfig({
      permissionMode: "default",
      threadPermissionMode: "default",
      model: "opencode/minimax-m2.5-free",
    });

    expect(agent).toBe("build");
    expect(model).toEqual({
      providerID: "opencode",
      modelID: "minimax-m2.5-free",
    });
    expect(config.permission).toEqual({
      edit: "ask",
      bash: "ask",
      webfetch: "ask",
      doom_loop: "ask",
      external_directory: "ask",
    });
    expect(config.agent?.build?.permission).toEqual(config.permission);
    expect(config.agent?.plan?.permission).toEqual(config.permission);
  });

  it("applies allow permissions to both build and plan agents for full access threads", () => {
    const { config } = __testing.buildOpencodeRuntimeConfig({
      permissionMode: "default",
      threadPermissionMode: "full_access",
      model: "opencode/minimax-m2.5-free",
    });

    expect(config.permission).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "allow",
    });
    expect(config.agent?.build?.permission).toEqual(config.permission);
    expect(config.agent?.plan?.permission).toEqual(config.permission);
  });

  it("extracts session ids from headless SDK delta and permission events", () => {
    expect(__testing.getEventSessionId({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_delta",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "hello",
      },
    })).toBe("ses_delta");

    expect(__testing.getEventSessionId({
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID: "ses_perm",
        permission: "bash",
        patterns: ["pwd"],
        always: ["pwd *"],
        metadata: {},
        tool: {
          messageID: "msg_1",
          callID: "call_1",
        },
      },
    })).toBe("ses_perm");
  });

  it("normalizes headless SDK permission requests", () => {
    expect(__testing.derivePermissionBlockedPath({
      id: "perm_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["pwd > /tmp/out.txt"],
      always: ["pwd *"],
      metadata: {},
      tool: {
        messageID: "msg_1",
        callID: "call_1",
      },
    })).toBe("pwd > /tmp/out.txt");

    expect(__testing.normalizePermissionRequest({
      id: "perm_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["pwd > /tmp/out.txt"],
      always: ["pwd *"],
      metadata: {},
      tool: {
        messageID: "msg_1",
        callID: "call_1",
      },
    })).toEqual({
      requestId: "perm_1",
      callId: "call_1",
      toolNameFallback: "bash",
      toolInput: {
        command: "pwd > /tmp/out.txt",
      },
      blockedPath: "pwd > /tmp/out.txt",
    });
  });
});
