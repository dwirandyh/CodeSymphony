---
name: claude-agent-sdk-typescript
description: Deep implementation guide for the TypeScript Claude Agent SDK, grounded in the installed SDK source and types. Use this whenever code imports `@anthropic-ai/claude-agent-sdk`, or the user asks how to build, debug, or review Agent SDK code involving `query()`, hooks, permission callbacks, MCP servers, in-process tools, subagents, sessions, browser transport, or structured output. Prefer this skill over generic Claude API guidance when the task is specifically about the Agent SDK runtime rather than raw `@anthropic-ai/sdk` Messages API.
---

# Claude Agent SDK TypeScript

This skill helps with Agent SDK usage by staying anchored to the actual installed SDK types/source instead of relying only on surface docs.

## What this skill is for

Use this skill for:
- implementing new Agent SDK integrations
- debugging existing `query()` flows
- understanding `SDKMessage` / `SDKResultMessage` / partial stream events
- designing permission policy and hooks
- wiring MCP servers, including in-process SDK MCP tools
- defining and constraining subagents
- resuming, listing, tagging, renaming, and forking sessions
- using browser transport
- using Agent SDK structured output via `outputFormat`

## First rule: verify the local SDK before advising

When possible, inspect the installed package first:
1. `node_modules/.../@anthropic-ai/claude-agent-sdk/package.json`
2. `sdk.d.ts`
3. `browser-sdk.d.ts` if browser use is relevant
4. `sdk-tools.d.ts` if built-in Claude tool schemas matter
5. local app code that already uses the SDK

Do not assume generic docs match the installed version. Prefer local types/source if they disagree with memory or broad examples.

For this repo, start with `references/source-map.md`.

## Core mental model

- The main API is `query({ prompt, options })`.
- `query()` returns a `Query`, which is both:
  - an `AsyncGenerator<SDKMessage, void>` you iterate over
  - a controller with methods like `interrupt()`, `setPermissionMode()`, `setModel()`, `initializationResult()`, `mcpServerStatus()`, `setMcpServers()`, `stopTask()`, `rewindFiles()`, and `close()`
- Treat Agent SDK as a streamed event protocol, not “one prompt in, one string out”.
- Most real integrations should explicitly handle at least:
  - `assistant`
  - `result`
  - `system` init/status events
  - `task_started` / `task_progress` / `task_notification` for subagents
  - optionally `stream_event` when partials matter

## Implementation workflow

1. Identify whether the user actually needs the Agent SDK.
   - If they only need raw Claude API tool use, recommend `@anthropic-ai/sdk` instead.
   - If they need built-in file/web/shell tools, permissions, hooks, or subagents, Agent SDK is appropriate.
2. Find the installed version and inspect types.
3. Read existing integration code in the repo before proposing new patterns.
4. Give the smallest working snippet that matches the user's runtime:
   - Node/local process → main SDK export
   - browser/WebSocket transport → browser export
5. Explain the exact option, message type, or hook controlling the behavior.

## How to reason about options

### Tool availability vs permissioning

Keep these separate:
- `tools`: what built-in tools exist in the model context
- `allowedTools`: which tool names are auto-allowed without prompting
- `disallowedTools`: remove tools entirely
- `permissionMode`: overall permission behavior
- `canUseTool`: per-call policy callback
- permission-related hooks: event-based interception and augmentation

Do not mix them up. A common mistake is treating `allowedTools` as the full tool allowlist. It is not.

### Recommended defaults

When writing code:
- set `cwd` explicitly for filesystem work
- prefer `tools: { type: "preset", preset: "claude_code" }` when you want the standard tool surface
- use `disallowedTools` and/or `allowedTools` to narrow behavior
- choose `permissionMode` deliberately; start with `"default"` unless the app clearly needs stricter or more automated behavior
- use `systemPrompt: { type: "preset", preset: "claude_code", append: "..." }` when you want Claude Code defaults plus custom policy
- set `settingSources` intentionally:
  - omitting it means SDK isolation mode
  - include `"project"` if you need `.claude/settings.json` and `CLAUDE.md`
- enable `includePartialMessages` only if the caller actually consumes streamed partial events
- use `stderr` or debug options when diagnosing CLI/subprocess issues
- use `model` only when you must override the CLI default

## Permissions guidance

Explain the permission modes clearly:
- `"default"`: normal prompting for risky operations
- `"acceptEdits"`: auto-accept file edits
- `"plan"`: planning mode, no real execution
- `"dontAsk"`: deny anything not already permitted; this is not auto-approve
- `"bypassPermissions"`: bypass checks entirely and requires `allowDangerouslySkipPermissions: true`

When the user needs policy logic, prefer:
1. `canUseTool` for centralized allow/deny decisions
2. hooks for observability, context injection, or fine-grained event-driven adjustments

### `canUseTool`

Use it when the application needs to decide tool execution programmatically. It receives:
- `toolName`
- raw tool `input`
- extra context such as `toolUseID`, `blockedPath`, `decisionReason`, permission suggestions, and optional `agentID`

Return a `PermissionResult`:
- allow, optionally with `updatedInput` and `updatedPermissions`
- deny, with a message and optional `interrupt`

Good uses:
- protect destructive Bash patterns
- auto-approve read-only tools
- require stronger checks outside allowed directories
- attach durable permission updates when the user chooses “always allow”

### Permission hooks

Relevant hook surfaces:
- `PreToolUse` can set `permissionDecision`, `permissionDecisionReason`, `updatedInput`, and `additionalContext`
- `PermissionRequest` can return an allow/deny decision object
- `PostToolUse` and `PostToolUseFailure` can append context or modify MCP tool output

Use hooks when you need audit trails, policy hints, or post-processing alongside runtime control.

## Hooks guidance

Hooks are one of the most important advanced Agent SDK features. Use them for:
- auditing tool calls
- adding context after a failure
- correlating subagent activity
- custom permission handling
- reacting to compaction, setup, worktree, elicitation, or session lifecycle events

Important hook events to remember:
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `PermissionRequest`
- `SubagentStart`
- `SubagentStop`
- `Elicitation`
- `ElicitationResult`
- `InstructionsLoaded`
- `PreCompact`
- `PostCompact`
- `WorktreeCreate`
- `WorktreeRemove`

Prefer telling developers exactly which hook to use for the need:
- before a tool executes → `PreToolUse`
- after tool output exists → `PostToolUse`
- after tool failure → `PostToolUseFailure`
- when an MCP server asks for user input or auth → `Elicitation`
- when subagent lifecycle matters → `SubagentStart` / `SubagentStop`

## MCP guidance

The Agent SDK supports multiple MCP transport types:
- stdio
- SSE
- HTTP
- in-process SDK servers

When the user wants custom tools inside the same Node process, prefer the in-process SDK path:
- define tools with `tool(name, description, zodSchema, handler)`
- package them with `createSdkMcpServer({ name, version, tools })`
- pass them through `options.mcpServers`

This is usually better than spawning another local process when:
- the logic is lightweight
- you already have app state in memory
- you want minimal transport overhead

Use process-based MCP servers when:
- the tool provider already exists externally
- the tool runtime has different dependencies or lifecycle needs
- the server must be shared across applications

Important MCP caveats:
- `setMcpServers()` only changes dynamically managed servers, not servers from settings files
- long-running SDK MCP calls may need `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT`
- check `mcpServerStatus()` when debugging connection/auth issues
- status objects include useful metadata such as connection state, scope, tool list, and errors
- `onElicitation` or elicitation hooks are required if you want to handle MCP auth/forms instead of auto-declining

## Subagent guidance

Teach subagents as constrained workers, not as a default for everything.

When defining `agents`:
- give each agent a narrow description so the `Agent` tool knows when to use it
- keep tool access small
- set `maxTurns` for bounded behavior when appropriate
- give agent-specific MCP servers or skills only when truly needed
- use `agent` when the main thread itself should run as a named agent

Good subagent uses:
- exploration
- testing
- review
- analysis
- parallel independent research

Bad subagent uses:
- trivial single-step tasks
- tasks that need the same broad tool access as the parent for no reason
- situations where the extra orchestration obscures a simple flow

When the user wants progress UX, mention:
- `task_started`
- `task_progress`
- `task_notification`
- `agentProgressSummaries`

## Session guidance

Use session APIs when the user needs persistence, history, or branching:
- `listSessions`
- `getSessionInfo`
- `getSessionMessages`
- `renameSession`
- `tagSession`
- `forkSession`

Clarify the core differences:
- `continue`: continue the most recent conversation in the current directory
- `resume`: resume a specific session ID
- `sessionId`: set a specific ID for the session
- `forkSession: true`: when resuming, fork instead of continuing the same session lineage

Important session caveats:
- `continue` and `resume` are mutually exclusive
- `sessionId` cannot be combined freely with `continue` / `resume` unless forking rules are satisfied
- `persistSession: false` disables disk persistence and later resume
- session listing can include worktrees; `includeWorktrees` defaults to true when appropriate

## Structured output guidance

Agent SDK structured output is not the same API surface as `@anthropic-ai/sdk` `messages.parse()`.

In the Agent SDK:
- use `outputFormat`
- current output format type is `json_schema`
- final `SDKResultSuccess` may include `structured_output`

When helping the user, be precise:
- if they are using Agent SDK `query()`, talk about `outputFormat` and `structured_output`
- if they are using raw Claude API, talk about `output_config.format` / `messages.parse()`

## Browser guidance

If the integration runs in the browser, use `@anthropic-ai/claude-agent-sdk/browser`.
That browser surface uses:
- `prompt: AsyncIterable<SDKUserMessage>`
- WebSocket transport config
- optional hooks, `canUseTool`, and MCP servers

Do not give Node subprocess examples for a browser-only integration.

## Common pitfalls to call out

- `allowedTools` does not define the full tool set; it only auto-allows named tools
- `dontAsk` denies non-preapproved operations; it does not silently allow them
- `bypassPermissions` requires `allowDangerouslySkipPermissions: true`
- omitting `settingSources` means no filesystem settings are loaded; include `"project"` if CLAUDE.md behavior matters
- `rewindFiles()` only works if `enableFileCheckpointing` is on
- `setMcpServers()` does not change settings-defined servers
- `promptSuggestions` arrive after the `result` message, so callers must keep iterating
- `unstable_v2_createSession`, `unstable_v2_resumeSession`, and `unstable_v2_prompt` are alpha/unstable APIs
- partial assistant events only appear when `includePartialMessages: true`
- consumers often ignore non-result messages and then miss auth, task, hook, or rate-limit events
- `Query` is a controller as well as a stream; if the user needs cancellation or runtime reconfiguration, mention the control methods instead of reinventing them

## How to answer

When this skill triggers:
1. identify whether the question is about Node, browser, MCP, hooks, permissions, sessions, subagents, or structured output
2. inspect the installed package or relevant local code before giving confident claims
3. cite the exact local file and line when practical
4. give a concise explanation plus the smallest correct snippet
5. warn about one or two relevant pitfalls, not an exhaustive dump
6. if the repo already has an integration, mirror its patterns before introducing new abstractions

## Bundled references

Read these as needed:
- `references/source-map.md` — validated local source locations and what they cover
- `references/patterns.md` — ready-to-adapt code snippets for common Agent SDK tasks
