import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface ClaudeHookEntry {
    type: "command";
    command: string;
}

interface ClaudeHookGroup {
    matcher?: string;
    hooks: ClaudeHookEntry[];
}

function groupHasCommand(group: ClaudeHookGroup, command: string): boolean {
    return (group.hooks ?? []).some((hook) => hook?.command === command);
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
        ? (settings.hooks as Record<string, ClaudeHookGroup[]>)
        : {}) as Record<string, ClaudeHookGroup[]>;

    for (const event of CLAUDE_EVENTS) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
        const alreadyWired = groups.some((group) => groupHasCommand(group, scriptPath));
        if (!alreadyWired) {
            const group: ClaudeHookGroup = { hooks: [{ type: "command", command: scriptPath }] };
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

/**
 * Wire the supported agent CLIs (Claude Code, OpenCode) in a worktree so they
 * report lifecycle status back to the runtime. Best-effort and idempotent;
 * never throws (a failed write must not break terminal spawn). Codex is wired
 * separately via the bundled ZDOTDIR `codex` shell function.
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
}
