import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code lifecycle events we wire to the status hook. The script reads the
// actual event from the stdin JSON, so every entry runs the same command.
const CLAUDE_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "SessionEnd",
] as const;

// Tool-scoped events take a matcher; the rest are session/turn events.
const CLAUDE_MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

// Codex native hooks.json (v0.142+) uses the same Claude-style event names and
// stdin JSON with hook_event_name. PermissionRequest is Codex-native for
// approval prompts. Project hooks work for normal repos; git worktrees ignore
// project-layer hooks (codex#27133), so we also merge into user-global
// $CODEX_HOME/hooks.json. The notify script no-ops without CS_TERMINAL_SESSION_ID.
const CODEX_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PreToolUse",
    "PostToolUse",
    "Stop",
] as const;

const CODEX_MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse", "PermissionRequest"]);

interface CommandHookEntry {
    type: "command";
    command: string;
}

interface HookGroup {
    matcher?: string;
    hooks: CommandHookEntry[];
}

function groupHasCommand(group: HookGroup, command: string): boolean {
    return (group.hooks ?? []).some((hook) => hook?.command === command);
}

function shellQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildCodexHookCommand(scriptPath: string): string {
    return `CS_AGENT_ID=codex ${shellQuote(scriptPath)}`;
}

function resolveCodexHome(): string {
    const fromEnv = process.env.CODEX_HOME?.trim();
    return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".codex");
}

function mergeHooksJsonFile(
    hooksPath: string,
    events: readonly string[],
    matcherEvents: Set<string>,
    command: string,
): void {
    let document: Record<string, unknown> = {};
    if (existsSync(hooksPath)) {
        try {
            document = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
        } catch {
            document = {};
        }
    }

    const hooks = (document.hooks && typeof document.hooks === "object"
        ? (document.hooks as Record<string, HookGroup[]>)
        : {}) as Record<string, HookGroup[]>;

    for (const event of events) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
        const alreadyWired = groups.some((group) => groupHasCommand(group, command));
        if (!alreadyWired) {
            const group: HookGroup = { hooks: [{ type: "command", command }] };
            if (matcherEvents.has(event)) {
                group.matcher = "*";
            }
            groups.push(group);
        }
        hooks[event] = groups;
    }

    document.hooks = hooks;
    writeFileSync(hooksPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function ensureClaudeSettings(worktreeCwd: string, scriptPath: string): void {
    const claudeDir = join(worktreeCwd, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
        try {
            settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        } catch {
            settings = {};
        }
    }

    const hooks = (settings.hooks && typeof settings.hooks === "object"
        ? (settings.hooks as Record<string, HookGroup[]>)
        : {}) as Record<string, HookGroup[]>;

    for (const event of CLAUDE_EVENTS) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
        const alreadyWired = groups.some((group) => groupHasCommand(group, scriptPath));
        if (!alreadyWired) {
            const group: HookGroup = { hooks: [{ type: "command", command: scriptPath }] };
            if (CLAUDE_MATCHER_EVENTS.has(event)) {
                group.matcher = "*";
            }
            groups.push(group);
        }
        hooks[event] = groups;
    }

    settings.hooks = hooks;
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function buildOpencodePlugin(scriptPath: string): string {
    const script = JSON.stringify(scriptPath);
    return `// CodeSymphony agent-status plugin (generated). Reports OpenCode lifecycle to
// the runtime so the terminal tab shows a live status badge.
export const CodeSymphonyAgentStatus = async ({ $ }) => {
  if (!process?.env?.CS_TERMINAL_SESSION_ID) return {};
  const script = ${script};
  const notify = async (hookEventName) => {
    const payload = JSON.stringify({ hook_event_name: hookEventName });
    try {
      await $\`CS_AGENT_ID=opencode bash \${script} \${payload}\`;
    } catch {
      // best-effort
    }
  };
  const isChild = (props) => Boolean(props?.info?.parentID ?? props?.parentID);
  return {
    event: async ({ event }) => {
      if (isChild(event.properties)) return;
      if (event.type === "session.created") return notify("SessionStart");
      if (event.type === "session.deleted") return notify("SessionEnd");
      if (event.type === "session.status") {
        const type = event.properties?.status?.type;
        if (type === "busy") return notify("Start");
        if (type === "idle") return notify("Stop");
      }
      if (event.type === "session.idle" || event.type === "session.error") return notify("Stop");
      if (event.type === "session.busy") return notify("Start");
    },
    "permission.ask": async (_permission, output) => {
      if (output?.status === "ask") await notify("PermissionRequest");
    },
  };
};
`;
}

function ensureOpencodePlugin(worktreeCwd: string, scriptPath: string): void {
    const pluginDir = join(worktreeCwd, ".opencode", "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "cs-agent-status.js"), buildOpencodePlugin(scriptPath), "utf8");
}

function ensureCodexHooks(worktreeCwd: string, scriptPath: string): void {
    const command = buildCodexHookCommand(scriptPath);

    // Project-local: works for normal git checkouts; ignored inside git worktrees.
    const projectCodexDir = join(worktreeCwd, ".codex");
    mkdirSync(projectCodexDir, { recursive: true });
    mergeHooksJsonFile(
        join(projectCodexDir, "hooks.json"),
        CODEX_EVENTS,
        CODEX_MATCHER_EVENTS,
        command,
    );

    // User-global: required for git worktrees (project hooks silently ignored).
    // Env-guarded script makes this safe outside CodeSymphony terminals.
    const codexHome = resolveCodexHome();
    mkdirSync(codexHome, { recursive: true });
    mergeHooksJsonFile(
        join(codexHome, "hooks.json"),
        CODEX_EVENTS,
        CODEX_MATCHER_EVENTS,
        command,
    );
}

/**
 * Wire the supported agent CLIs (Claude Code, OpenCode, Codex) in a worktree so
 * they report lifecycle status back to the runtime. Best-effort and idempotent;
 * never throws (a failed write must not break terminal spawn).
 *
 * Codex also merges into user-global $CODEX_HOME/hooks.json because project
 * hooks are ignored when Codex runs inside a git worktree. The bundled ZDOTDIR
 * `codex` shell function only adds `--dangerously-bypass-hook-trust` so the
 * injected hooks run without an interactive trust prompt.
 */
export function ensureAgentHookConfigs(worktreeCwd: string, scriptPath: string): void {
    try {
        ensureClaudeSettings(worktreeCwd, scriptPath);
    } catch {
        // best-effort
    }
    try {
        ensureOpencodePlugin(worktreeCwd, scriptPath);
    } catch {
        // best-effort
    }
    try {
        ensureCodexHooks(worktreeCwd, scriptPath);
    } catch {
        // best-effort
    }
}
