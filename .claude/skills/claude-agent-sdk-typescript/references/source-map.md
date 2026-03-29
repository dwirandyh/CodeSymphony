# Local Claude Agent SDK source map

This reference is grounded in the installed package in this repo:

- package: `@anthropic-ai/claude-agent-sdk`
- version: `0.2.76`
- `claudeCodeVersion`: `2.1.76`
- package root: `/Users/dwirandyh/Work/Personal/codesymphony/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.76_zod@4.3.6/node_modules/@anthropic-ai/claude-agent-sdk`

## Key files

| Topic | File | Lines | Notes |
|---|---|---:|---|
| package metadata | `package.json` | 1-62 | version, exports, engine, `claudeCodeVersion` |
| overview | `README.md` | 1-45 | package purpose and links |
| custom subagent definition | `sdk.d.ts` | 34-68 | `AgentDefinition` |
| in-process MCP server factory | `sdk.d.ts` | 296-308 | `createSdkMcpServer()` |
| session utilities | `sdk.d.ts` | 400-452, 531-555, 1570, 3390 | fork/get/list/rename/tag |
| MCP config and status | `sdk.d.ts` | 557-652 | stdio/SSE/HTTP/SDK configs and server status |
| main query options | `sdk.d.ts` | 744-1179 | `Options` including agents, tools, MCP, model, permissions, hooks |
| system prompt preset | `sdk.d.ts` | 1188-1207 | raw string vs Claude Code preset + append |
| output format + permission modes | `sdk.d.ts` | 1227-1304 | `OutputFormat`, `PermissionMode`, `PermissionResult`, `PermissionUpdate` |
| hook inputs/outputs | `sdk.d.ts` | 1329-1362 | `PostToolUse`, `PreToolUse`, additional context, updated input |
| query controller methods | `sdk.d.ts` | 1409-1557 | `Query` async generator plus control methods |
| `query()` | `sdk.d.ts` | 1559-1562 | top-level API |
| assistant/auth/system init | `sdk.d.ts` | 1644-1759 | `SDKAssistantMessage`, `SDKAuthStatusMessage`, init response |
| control requests | `sdk.d.ts` | 1761-1844 | interrupt, MCP, permission, rewind, etc. |
| stream/result/session unions | `sdk.d.ts` | 1989-2125 | `SdkMcpToolDefinition`, `SDKMessage`, `SDKPartialAssistantMessage`, `SDKResultMessage`, unstable v2 session |
| thinking/tool helper | `sdk.d.ts` | 3407-3455 | adaptive/enabled/disabled thinking, `tool()` helper, `ToolConfig` |
| browser export | `browser-sdk.d.ts` | 11-52 | browser `query()` and WebSocket transport |
| tool input schemas | `sdk-tools.d.ts` | 11-312 | Claude built-in tool input/output schema typing |

## Practical repo-specific integration example

This repo already uses the Agent SDK in:

- `apps/runtime/src/claude/sessionRunner.ts:166-214`

Notable choices there:
- `query({ prompt, options })`
- `includePartialMessages: true`
- `resume: sessionId`
- custom `canUseTool`
- lifecycle hooks for `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`
- `tools: { type: "preset", preset: "claude_code" }`
- explicit `settingSources: ["local", "project", "user"]`
- explicit `cwd`, `env`, and `stderr`

That file is a good real-world pattern source when answering questions for this repo.

## High-value facts validated from source

### Query is both stream and controller
- `Query` extends `AsyncGenerator<SDKMessage, void>` and exposes methods like `interrupt()`, `setPermissionMode()`, `setModel()`, `initializationResult()`, `mcpServerStatus()`, `setMcpServers()`, `rewindFiles()`, `stopTask()`, and `close()`.
- Source: `sdk.d.ts:1409-1557`

### Tool availability is separate from permissioning
- `tools`, `allowedTools`, `disallowedTools`, `permissionMode`, `canUseTool`, and hooks all exist separately.
- Source: `sdk.d.ts:789-905, 1022-1034, 1236-1304`

### `dontAsk` is deny-by-default, not auto-approve
- Source: `sdk.d.ts:1022-1029, 1233-1236`

### `bypassPermissions` requires an explicit dangerous opt-in
- `allowDangerouslySkipPermissions: true`
- Source: `sdk.d.ts:1031-1034`

### `settingSources` is critical
- Omitting it means no filesystem settings are loaded; include `"project"` to load `CLAUDE.md` files.
- Source: `sdk.d.ts:1151-1159`

### `setMcpServers()` only affects dynamic SDK-added servers
- It does not alter settings-file servers.
- Source: `sdk.d.ts:1521-1535`

### `rewindFiles()` requires checkpointing
- `enableFileCheckpointing` must be enabled first.
- Source: `sdk.d.ts:861-868, 1489-1498`

### Partial assistant messages are opt-in
- `includePartialMessages: true` is required for `SDKPartialAssistantMessage` / `stream_event`.
- Source: `sdk.d.ts:936-939, 1997-2005`

### Prompt suggestions arrive after result
- Consumers must keep iterating after `result` if they want `prompt_suggestion` messages.
- Source: `sdk.d.ts:1059-1069, 2027-2035`

### Structured output in Agent SDK
- `OutputFormat` is currently `json_schema` only.
- Success results may include `structured_output`.
- Source: `sdk.d.ts:1227-1229, 2085-2102`

### Unstable v2 session APIs are explicitly alpha
- `unstable_v2_createSession`, `unstable_v2_prompt`, `unstable_v2_resumeSession`
- Source: `sdk.d.ts:2104-2125, 3493-3514`

### Browser SDK is separate
- Browser usage comes from `@anthropic-ai/claude-agent-sdk/browser` and requires WebSocket options.
- Source: `browser-sdk.d.ts:11-52`
