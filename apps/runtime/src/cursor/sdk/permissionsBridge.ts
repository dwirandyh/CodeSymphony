import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  editTargetFromUnknownToolInput,
  resolveToolPresentationContext,
} from "../../claude/toolClassification.js";
import { shouldAutoApproveWorkspaceEdit } from "../../services/chat/workspaceEditPermissions.js";
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

export type CursorSdkPermissionHookSettings = {
  version: 1;
  hooks: {
    preToolUse: Array<{
      type: "command";
      command: string;
      matcher: "*";
      failClosed: true;
    }>;
  };
};

export type CursorSdkPermissionHookInput = {
  hook_event_name?: unknown;
  tool_use_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
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
  token: string;
  dispose: () => void;
};

export type CursorSdkPermissionHookProject = {
  rootDir: string;
  dispose: () => Promise<void>;
};

const cursorSdkPermissionBridges = new Map<string, RegisteredCursorSdkPermissionBridge>();

function coerceObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeToolUseId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.replace(/\s+/g, "")
    : `cursor-sdk-tool:${randomUUID()}`;
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

export async function handleCursorSdkPermissionHook(
  params: HandleCursorSdkPermissionHookParams,
): Promise<CursorSdkHookResponse> {
  if (params.hookInput.hook_event_name !== "PreToolUse") {
    return {};
  }

  const rawToolName = normalizeToolName(params.hookInput.tool_name);
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
  const token = randomUUID();
  cursorSdkPermissionBridges.set(token, bridge);

  return {
    token,
    dispose: () => {
      cursorSdkPermissionBridges.delete(token);
    },
  };
}

export async function handleRegisteredCursorSdkPermissionHook(
  token: string,
  hookInput: CursorSdkPermissionHookInput,
): Promise<CursorSdkHookResponse | null> {
  const bridge = cursorSdkPermissionBridges.get(token);
  if (!bridge) {
    return null;
  }

  return handleCursorSdkPermissionHook({
    ...bridge,
    hookInput,
  });
}

export function resetCursorSdkPermissionBridgesForTests(): void {
  cursorSdkPermissionBridges.clear();
}

export function buildCursorSdkPermissionHookCommand(endpointUrl: string): string {
  const script = [
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
  ].join("");

  return `node -e ${JSON.stringify(script)}`;
}

export function buildCursorSdkPermissionHookSettings(endpointUrl: string): CursorSdkPermissionHookSettings {
  return {
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
  };
}

export async function createCursorSdkPermissionHookProject(
  endpointUrl: string,
): Promise<CursorSdkPermissionHookProject> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codesymphony-cursor-sdk-permissions-"));
  const cursorDir = path.join(rootDir, ".cursor");
  await mkdir(cursorDir, { recursive: true });
  await writeFile(
    path.join(cursorDir, "settings.json"),
    `${JSON.stringify(buildCursorSdkPermissionHookSettings(endpointUrl), null, 2)}\n`,
    "utf8",
  );

  return {
    rootDir,
    dispose: () => rm(rootDir, { recursive: true, force: true }),
  };
}

export function buildCursorSdkPermissionEndpointUrl(token: string): string {
  const baseUrl = process.env.CODESYMPHONY_RUNTIME_PUBLIC_URL?.trim()
    || `http://127.0.0.1:${process.env.RUNTIME_PORT?.trim() || "4331"}`;
  return `${baseUrl.replace(/\/+$/, "")}/api/cursor-sdk/permissions/${encodeURIComponent(token)}`;
}
