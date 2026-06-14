import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  editTargetFromUnknownToolInput,
  resolveToolPresentationContext,
} from "../../claude/toolClassification.js";
import { shouldAutoApproveWorkspaceEdit } from "../../services/chat/workspaceEditPermissions.js";
import { CURSOR_SDK_QUESTION_TOOL_NAME } from "./questionTool.js";
import type { ChatAgentRunner } from "../../types.js";

type RunnerArgs = Parameters<ChatAgentRunner>[0];

const CURSOR_SDK_ALWAYS_ALLOW_DESCRIPTION =
  "Uses Cursor hook allow for this request; CodeSymphony records the allow-always decision.";

export type CursorSdkHookResponse = {
  permission?: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
  additional_context?: string;
};

type CursorSdkHookEntry = {
  type: "command";
  command: string;
  matcher: "*";
  failClosed: true;
};

// Cursor reads project hooks from <workspaceRoot>/.cursor/hooks.json (NOT
// settings.json, which only carries `plugins`). Only `preToolUse` is
// registered: it fires for Shell, MCP, and file tools. Registering
// `beforeShellExecution` in addition would double-prompt for shell commands.
export type CursorSdkPermissionHookFile = {
  version: 1;
  hooks: {
    preToolUse: CursorSdkHookEntry[];
  };
};

export type CursorSdkPermissionHookInput = {
  hook_event_name?: unknown;
  tool_use_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  // Cursor stamps every hook payload with the originating agent id under
  // session_id (also conversation_id / generation_id). Used to route the hook
  // to the correct in-flight turn when several share one worktree hooks file.
  session_id?: unknown;
};

export type HandleCursorSdkPermissionHookParams = {
  cwd: string;
  permissionMode?: RunnerArgs["permissionMode"];
  threadPermissionMode?: RunnerArgs["threadPermissionMode"];
  hookInput: CursorSdkPermissionHookInput;
  onPermissionRequest: RunnerArgs["onPermissionRequest"];
};

export type RegisteredCursorSdkPermissionBridge = Omit<
  HandleCursorSdkPermissionHookParams,
  "hookInput"
>;

export type CursorSdkPermissionBridgeRegistration = {
  // Bind this bridge to the agent id once the SDK assigns one, so incoming
  // hooks (which carry session_id === agentId) route here.
  bind: (agentId: string) => void;
  dispose: () => void;
};

export type CursorSdkWorktreeHookInstallation = {
  dispose: () => Promise<void>;
};

const cursorSdkPermissionBridgesByAgentId = new Map<string, RegisteredCursorSdkPermissionBridge>();

function coerceObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeToolUseId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.replace(/\s+/g, "")
    : `cursor-sdk-tool:${crypto.randomUUID()}`;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "Tool";
}

function resolveBlockedPath(toolName: string, toolInput: Record<string, unknown>): string | null {
  return editTargetFromUnknownToolInput(toolName, toolInput) ?? null;
}

function toHookResponse(decision: "allow" | "allow_always" | "deny"): CursorSdkHookResponse {
  if (decision === "deny") {
    return {
      permission: "deny",
      user_message: "Denied by CodeSymphony permission gate.",
    };
  }

  return { permission: "allow" };
}

function isCursorSdkQuestionToolName(toolName: string): boolean {
  const normalized = toolName.trim().replace(/^MCP:/i, "").toLowerCase();
  return normalized === CURSOR_SDK_QUESTION_TOOL_NAME;
}

function isPreToolUseEvent(hookEventName: unknown): boolean {
  // Cursor sends lowercase "preToolUse"; accept the Claude-style "PreToolUse"
  // spelling too for resilience.
  return hookEventName === "preToolUse" || hookEventName === "PreToolUse";
}

export async function handleCursorSdkPermissionHook(
  params: HandleCursorSdkPermissionHookParams,
): Promise<CursorSdkHookResponse> {
  if (!isPreToolUseEvent(params.hookInput.hook_event_name)) {
    return {};
  }

  const rawToolName = normalizeToolName(params.hookInput.tool_name);
  // Our own question tool routes through preToolUse first; auto-allow it so its
  // execute() runs and surfaces a structured question.requested instead of a
  // permission prompt. Cursor prefixes MCP-style tools with "MCP:".
  if (isCursorSdkQuestionToolName(rawToolName)) {
    return { permission: "allow" };
  }

  const toolInput = coerceObject(params.hookInput.tool_input);
  const presentation = resolveToolPresentationContext({
    toolName: rawToolName,
    input: toolInput,
    title: rawToolName,
  });
  const toolName = presentation.toolName;
  const blockedPath = resolveBlockedPath(toolName, toolInput);

  if (params.threadPermissionMode === "full_access") {
    return { permission: "allow" };
  }

  if (shouldAutoApproveWorkspaceEdit({
    workspaceRoot: params.cwd,
    toolName,
    toolInput,
    blockedPath,
  })) {
    return { permission: "allow" };
  }

  const result = await params.onPermissionRequest({
    requestId: normalizeToolUseId(params.hookInput.tool_use_id),
    toolName,
    toolInput,
    blockedPath,
    decisionReason: null,
    suggestions: null,
    canAlwaysAllow: true,
    alwaysAllowScope: "native",
    alwaysAllowDescription: CURSOR_SDK_ALWAYS_ALLOW_DESCRIPTION,
    subagentOwnerToolUseId: null,
    launcherToolUseId: null,
  });

  return toHookResponse(result.decision);
}

export function registerCursorSdkPermissionBridge(
  bridge: RegisteredCursorSdkPermissionBridge,
): CursorSdkPermissionBridgeRegistration {
  let boundAgentId: string | null = null;

  return {
    bind: (agentId: string) => {
      if (!agentId) {
        return;
      }
      if (boundAgentId && boundAgentId !== agentId) {
        cursorSdkPermissionBridgesByAgentId.delete(boundAgentId);
      }
      boundAgentId = agentId;
      cursorSdkPermissionBridgesByAgentId.set(agentId, bridge);
    },
    dispose: () => {
      if (boundAgentId) {
        cursorSdkPermissionBridgesByAgentId.delete(boundAgentId);
        boundAgentId = null;
      }
    },
  };
}

export async function handleRegisteredCursorSdkPermissionHook(
  hookInput: CursorSdkPermissionHookInput,
): Promise<CursorSdkHookResponse | null> {
  const sessionId = typeof hookInput.session_id === "string" && hookInput.session_id.trim().length > 0
    ? hookInput.session_id
    : null;
  const bridge = sessionId ? cursorSdkPermissionBridgesByAgentId.get(sessionId) : null;
  if (!bridge) {
    return null;
  }

  return handleCursorSdkPermissionHook({
    ...bridge,
    hookInput,
  });
}

export function resetCursorSdkPermissionBridgesForTests(): void {
  cursorSdkPermissionBridgesByAgentId.clear();
  worktreeHookStateByPath.clear();
}

// The bridge runs as a standalone Node script referenced by absolute path.
// Cursor shell-splits the hook `command` string; an inline `node -e "<script>"`
// with the embedded endpoint URL's nested quotes gets mangled by that splitter
// and silently never executes, so we write the script to a file and invoke it
// by path instead.
export function buildCursorSdkPermissionHookScript(endpointUrl: string): string {
  return [
    `const endpoint=${JSON.stringify(endpointUrl)};`,
    "let input='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>{input+=chunk;});",
    "process.stdin.on('end',async()=>{",
    "try{",
    "const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:input||'{}'});",
    "if(!response.ok){throw new Error(String(response.status));}",
    "const text=await response.text();",
    "JSON.parse(text);",
    "process.stdout.write(text);",
    "}catch{",
    "process.stdout.write(JSON.stringify({permission:'deny',user_message:'CodeSymphony permission bridge unavailable.'}));",
    "}",
    "});",
    "",
  ].join("\n");
}

export function buildCursorSdkPermissionHookCommand(scriptPath: string): string {
  return `node ${JSON.stringify(scriptPath)}`;
}

export function buildCursorSdkPermissionHookFile(scriptPath: string): CursorSdkPermissionHookFile {
  return {
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
  };
}

type WorktreeHookState = {
  refCount: number;
  hooksPath: string;
  scriptPath: string;
  restoreContent: string | null;
  createdCursorDir: boolean;
};

const worktreeHookStateByPath = new Map<string, WorktreeHookState>();

const CURSOR_SDK_HOOK_SCRIPT_FILENAME = ".codesymphony-permission-hook.cjs";

function isCodesymphonyGateEntry(entry: unknown): boolean {
  const obj = entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : null;
  return typeof obj?.command === "string" && obj.command.includes(CURSOR_SDK_HOOK_SCRIPT_FILENAME);
}

// Parses a hooks.json string and strips any CodeSymphony gate entries (left over
// from a crashed turn — refcounts are in-memory, so a hard kill cannot dispose).
// Returns the sanitized object plus whether any genuine user content remains, so
// callers never accumulate gates or persist a stray failClosed deny-all.
function sanitizeUserHookFile(originalContent: string | null): {
  base: Record<string, unknown>;
  hasUserContent: boolean;
} {
  let base: Record<string, unknown> = { version: 1, hooks: {} };
  if (originalContent) {
    try {
      const parsed = JSON.parse(originalContent) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed user file: fall back to a clean gate-only file rather than
      // crash the turn.
      return { base: { version: 1, hooks: {} }, hasUserContent: false };
    }
  }

  if (typeof base.version !== "number") {
    base.version = 1;
  }
  const hooks = (base.hooks && typeof base.hooks === "object" && !Array.isArray(base.hooks)
    ? base.hooks
    : {}) as Record<string, unknown>;
  const userPreToolUse = (Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [])
    .filter((entry) => !isCodesymphonyGateEntry(entry));
  if (userPreToolUse.length > 0) {
    hooks.preToolUse = userPreToolUse;
  } else {
    delete hooks.preToolUse;
  }
  base.hooks = hooks;

  const hasUserContent = Object.keys(hooks).length > 0;
  return { base, hasUserContent };
}

function mergeCursorHookFile(originalContent: string | null, gateEntry: CursorSdkHookEntry): Record<string, unknown> {
  const { base } = sanitizeUserHookFile(originalContent);
  const hooks = base.hooks as Record<string, unknown>;
  const existing = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  hooks.preToolUse = [...existing, gateEntry];
  return base;
}

// Installs the CodeSymphony permission gate into <worktree>/.cursor/hooks.json.
// Refcounted per worktree so concurrent turns sharing a worktree do not clobber
// each other; the original file (if any) is restored on the final dispose.
export async function installCursorSdkWorktreeHook(
  worktree: string,
  endpointUrl: string,
): Promise<CursorSdkWorktreeHookInstallation> {
  const existingState = worktreeHookStateByPath.get(worktree);
  if (existingState) {
    existingState.refCount += 1;
    return { dispose: makeWorktreeHookDispose(worktree) };
  }

  const cursorDir = path.join(worktree, ".cursor");
  const hooksPath = path.join(cursorDir, "hooks.json");
  const scriptPath = path.join(cursorDir, ".codesymphony-permission-hook.cjs");

  let createdCursorDir = false;
  try {
    await stat(cursorDir);
  } catch {
    await mkdir(cursorDir, { recursive: true });
    createdCursorDir = true;
  }

  let originalContent: string | null = null;
  try {
    originalContent = await readFile(hooksPath, "utf8");
  } catch {
    originalContent = null;
  }

  // Compute what to restore on dispose: genuine user content with any orphaned
  // gate entries stripped (a crashed turn cannot run dispose). When no user
  // content remains, the file is removed entirely on dispose.
  const { base: sanitizedUser, hasUserContent } = sanitizeUserHookFile(originalContent);
  const restoreContent = hasUserContent
    ? `${JSON.stringify(sanitizedUser, null, 2)}\n`
    : null;

  // Write the bridge script to a file and reference it by path (see
  // buildCursorSdkPermissionHookScript for why an inline `node -e` form fails).
  await writeFile(scriptPath, buildCursorSdkPermissionHookScript(endpointUrl), "utf8");

  const gateEntry = buildCursorSdkPermissionHookFile(scriptPath).hooks.preToolUse[0];
  const merged = mergeCursorHookFile(originalContent, gateEntry);
  await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  worktreeHookStateByPath.set(worktree, {
    refCount: 1,
    hooksPath,
    scriptPath,
    restoreContent,
    createdCursorDir,
  });

  return { dispose: makeWorktreeHookDispose(worktree) };
}

function makeWorktreeHookDispose(worktree: string): () => Promise<void> {
  let disposed = false;
  return async () => {
    if (disposed) {
      return;
    }
    disposed = true;

    const state = worktreeHookStateByPath.get(worktree);
    if (!state) {
      return;
    }

    state.refCount -= 1;
    if (state.refCount > 0) {
      return;
    }
    worktreeHookStateByPath.delete(worktree);

    // Always remove our bridge script; it is never part of the user's config.
    await rm(state.scriptPath, { force: true });

    if (state.restoreContent !== null) {
      await writeFile(state.hooksPath, state.restoreContent, "utf8");
      return;
    }

    await rm(state.hooksPath, { force: true });
    if (state.createdCursorDir) {
      // Remove the .cursor dir only if it is now empty (rmdir throws ENOTEMPTY
      // otherwise, which we swallow).
      await rmdir(path.dirname(state.hooksPath)).catch(() => {});
    }
  };
}

export function buildCursorSdkPermissionEndpointUrl(): string {
  const baseUrl = process.env.CODESYMPHONY_RUNTIME_PUBLIC_URL?.trim()
    || `http://127.0.0.1:${process.env.RUNTIME_PORT?.trim() || "4331"}`;
  return `${baseUrl.replace(/\/+$/, "")}/api/cursor-sdk/permissions`;
}
