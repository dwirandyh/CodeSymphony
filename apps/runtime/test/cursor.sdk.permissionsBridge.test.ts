import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCursorSdkPermissionHookCommand,
  buildCursorSdkPermissionHookFile,
  handleCursorSdkPermissionHook,
  installCursorSdkWorktreeHook,
  resetCursorSdkPermissionBridgesForTests,
} from "../src/cursor/sdk/permissionsBridge.js";

describe("Cursor SDK permissions bridge", () => {
  beforeEach(() => {
    resetCursorSdkPermissionBridgesForTests();
  });

  it("maps lowercase preToolUse shell hook decisions through onPermissionRequest", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      permissionMode: "default",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "preToolUse",
        tool_use_id: "tool 1",
        tool_name: "Shell",
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
      toolName: "Shell",
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

  it("still accepts capitalized PreToolUse for safety", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "allow_always" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "PreToolUse",
        tool_use_id: "tool 2",
        tool_name: "Shell",
        tool_input: { command: "pnpm test" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({ permission: "allow" });
  });

  it("ignores non preToolUse hook events", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "default",
      hookInput: {
        hook_event_name: "afterShellExecution",
        tool_name: "Shell",
      },
      onPermissionRequest,
    });

    expect(result).toEqual({});
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-allows the ask_user_question custom tool so its execute can run", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    for (const toolName of ["MCP:ask_user_question", "ask_user_question"]) {
      const result = await handleCursorSdkPermissionHook({
        cwd: "/tmp/project",
        threadPermissionMode: "default",
        hookInput: {
          hook_event_name: "preToolUse",
          tool_use_id: `tool ${toolName}`,
          tool_name: toolName,
          tool_input: { questions: [{ question: "?" }] },
        },
        onPermissionRequest,
      });

      expect(result).toEqual({ permission: "allow" });
    }
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("auto-allows full-access threads without prompting", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "deny" as const }));

    const result = await handleCursorSdkPermissionHook({
      cwd: "/tmp/project",
      threadPermissionMode: "full_access",
      hookInput: {
        hook_event_name: "preToolUse",
        tool_use_id: "tool 3",
        tool_name: "Shell",
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
        hook_event_name: "preToolUse",
        tool_use_id: "tool 4",
        tool_name: "Edit",
        tool_input: { file_path: "/tmp/project/src/main.ts" },
      },
      onPermissionRequest,
    });

    expect(result).toEqual({ permission: "allow" });
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it("builds a cursor-format hooks file that registers only preToolUse", () => {
    const scriptPath = "/tmp/project/.cursor/.codesymphony-permission-hook.cjs";

    const file = buildCursorSdkPermissionHookFile(scriptPath);

    expect(file).toEqual({
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            command: buildCursorSdkPermissionHookCommand(scriptPath),
            matcher: "*",
            failClosed: true,
          },
        ],
      },
    });
    // The command invokes the bridge script by path (not an inline `node -e`,
    // which Cursor's shell splitter mangles).
    expect(buildCursorSdkPermissionHookCommand(scriptPath)).toBe(`node ${JSON.stringify(scriptPath)}`);
  });
});

describe("Cursor SDK worktree hook installation", () => {
  let worktree: string;
  const endpointUrl = "http://127.0.0.1:4331/api/cursor-sdk/permissions";

  beforeEach(async () => {
    resetCursorSdkPermissionBridgesForTests();
    worktree = await mkdtemp(path.join(os.tmpdir(), "cs-cursor-hook-wt-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("writes .cursor/hooks.json + bridge script into the worktree and removes them on dispose", async () => {
    const install = await installCursorSdkWorktreeHook(worktree, endpointUrl);

    const hooksPath = path.join(worktree, ".cursor", "hooks.json");
    const scriptPath = path.join(worktree, ".cursor", ".codesymphony-permission-hook.cjs");
    const written = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(written.hooks.preToolUse).toHaveLength(1);
    // Command references the bridge script by path; script exists and posts to the endpoint.
    expect(written.hooks.preToolUse[0].command).toBe(buildCursorSdkPermissionHookCommand(scriptPath));
    const script = await readFile(scriptPath, "utf8");
    expect(script).toContain(JSON.stringify(endpointUrl));

    await install.dispose();
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    // .cursor created by us is removed when empty
    await expect(stat(path.join(worktree, ".cursor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refcounts concurrent installs and only removes after the last dispose", async () => {
    const a = await installCursorSdkWorktreeHook(worktree, endpointUrl);
    const b = await installCursorSdkWorktreeHook(worktree, endpointUrl);
    const hooksPath = path.join(worktree, ".cursor", "hooks.json");

    await a.dispose();
    await stat(hooksPath); // still present
    await b.dispose();
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a pre-existing user hooks.json and restores it on dispose", async () => {
    const cursorDir = path.join(worktree, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const original = {
      version: 1,
      hooks: { preToolUse: [{ type: "command", command: "user-hook", matcher: "*" }] },
    };
    const hooksPath = path.join(cursorDir, "hooks.json");
    await writeFile(hooksPath, JSON.stringify(original, null, 2), "utf8");

    const install = await installCursorSdkWorktreeHook(worktree, endpointUrl);
    const merged = JSON.parse(await readFile(hooksPath, "utf8"));
    // both the user hook and our gate are present during the turn
    expect(merged.hooks.preToolUse).toHaveLength(2);

    await install.dispose();
    const restored = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(restored).toEqual(original);
  });

  it("self-heals an orphaned gate left by a crashed turn (no accumulation)", async () => {
    const cursorDir = path.join(worktree, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, "hooks.json");
    const scriptPath = path.join(cursorDir, ".codesymphony-permission-hook.cjs");
    // Simulate a crash leftover: a hooks.json containing only our gate entry.
    const orphan = {
      version: 1,
      hooks: { preToolUse: [{ type: "command", command: buildCursorSdkPermissionHookCommand(scriptPath), matcher: "*", failClosed: true }] },
    };
    await writeFile(hooksPath, JSON.stringify(orphan, null, 2), "utf8");

    const install = await installCursorSdkWorktreeHook(worktree, endpointUrl);
    const merged = JSON.parse(await readFile(hooksPath, "utf8"));
    // Exactly one gate entry — the orphan was stripped, not accumulated.
    expect(merged.hooks.preToolUse).toHaveLength(1);

    await install.dispose();
    // File had no genuine user content, so it is removed entirely.
    await expect(stat(hooksPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("strips an orphaned gate but keeps genuine user hooks on restore", async () => {
    const cursorDir = path.join(worktree, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    const hooksPath = path.join(cursorDir, "hooks.json");
    const scriptPath = path.join(cursorDir, ".codesymphony-permission-hook.cjs");
    const userEntry = { type: "command", command: "user-hook", matcher: "*" };
    const orphanedGate = { type: "command", command: buildCursorSdkPermissionHookCommand(scriptPath), matcher: "*", failClosed: true };
    await writeFile(hooksPath, JSON.stringify({
      version: 1,
      hooks: { preToolUse: [userEntry, orphanedGate] },
    }, null, 2), "utf8");

    const install = await installCursorSdkWorktreeHook(worktree, endpointUrl);
    const merged = JSON.parse(await readFile(hooksPath, "utf8"));
    // user hook + one fresh gate (orphan removed, no accumulation)
    expect(merged.hooks.preToolUse).toHaveLength(2);

    await install.dispose();
    const restored = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(restored.hooks.preToolUse).toEqual([userEntry]);
  });
});
