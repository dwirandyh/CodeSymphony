# CLI Agent Integration Spec

## Purpose

This document defines the integration contract for adding a new CLI-backed chat agent to CodeSymphony.

It uses the existing `codex` agent as the baseline because Codex already exercises the full end-to-end surface area that a serious CLI agent must support in this codebase:

- thread-level agent and model selection
- built-in and custom model handling
- slash command discovery
- session persistence and resume
- streaming assistant output
- tool lifecycle events
- permission requests and approval policies
- plan mode behavior
- question / structured input requests
- subagent activity
- provider-specific runtime configuration
- web composer, settings, and timeline integration

The goal is to make adding a new agent a checklist-driven engineering task instead of a scattered set of ad hoc edits.

## Scope

This spec covers:

- shared types and persistence
- runtime runner contract
- chat service orchestration
- HTTP routes
- web composer and settings integration
- test coverage requirements
- manual QA / dogfood expectations

This spec does not define the provider-specific transport protocol in detail. That belongs inside the new agent's runtime adapter.

## Baseline

The current supported CLI agents are:

- `claude`
- `codex`
- `opencode`

Codex is the baseline reference because it is the most complete example of a JSON-RPC style CLI agent with:

- explicit per-thread session IDs
- slash command loading from the provider runtime
- skill alias normalization (`/skill` in UI, `$skill` in prompt)
- plan mode policy mapping
- custom provider overrides via CLI config / Responses API
- timeline-compatible tool, plan, and subagent normalization

## Core Product Expectations For Any CLI Agent

A new CLI agent is not just "another model option". It is a full runtime integration. A production-ready agent must satisfy all of the following:

### 1. Thread Selection

The agent must be selectable per thread, alongside a model and optional `modelProviderId`.

Expected behavior:

- a thread stores the selected agent
- a thread stores the effective model string
- a thread stores the optional model provider reference
- changing the agent resets any provider-specific session ID
- changing the agent or model is blocked once the thread has messages
- changing the agent or model is blocked while the assistant is running

### 2. Session Lifecycle

The agent must support thread-level session continuity.

Expected behavior:

- the runner accepts `sessionId: string | null`
- the runner can emit a newly created provider session ID through `onSessionId`
- the runtime persists the provider session ID on the thread
- subsequent turns reuse the persisted session ID for the same agent
- switching to another agent clears this session state

### 3. Streaming Output

The agent must be able to stream assistant output through the standard callback contract in `apps/runtime/src/types.ts`.

Required callbacks:

- `onText`
- `onToolStarted`
- `onToolOutput`
- `onToolFinished`
- `onQuestionRequest`
- `onPermissionRequest`
- `onPlanFileDetected`
- `onSubagentStarted`
- `onSubagentStopped`

If the provider cannot support one of these concepts natively, the adapter must either:

- normalize the provider's native event into the contract, or
- explicitly degrade while keeping the runtime stable

Silent capability gaps are not acceptable.

### 4. Permission Model

The agent must honor both:

- chat mode: `default | plan`
- thread permission mode: `default | full_access`

The runtime behavior must remain consistent with existing agents:

- default thread + default mode => ask/on-request
- full access thread + default mode => always allow / no approval prompts
- any plan-mode run => non-mutating exploration only unless explicitly designed otherwise and approved as a product rule

Codex baseline:

- `default` thread + `default` mode => `approvalPolicy: "on-request"`, `sandbox: "read-only"`
- `full_access` thread + `default` mode => `approvalPolicy: "never"`, `sandbox: "danger-full-access"`
- any `plan` mode => still uses request approvals and read-only execution
- mutating plan-mode approvals are auto-declined

If a new agent has a different native permission API, the adapter must still preserve these product-level semantics.

### 5. Slash Commands

The agent must have a defined slash command behavior.

Acceptable patterns:

- runtime-native command listing, like Codex `skills/list`
- CLI-native command listing
- fallback static discovery
- explicit empty catalog when the agent genuinely has no slash commands

But the behavior must be intentional and tested.

Codex baseline:

- primary source: app-server `skills/list`
- fallback source: repo + home skill scanning via `listCodexSkills`
- prompt normalization converts recognized `/skill` or `$skill` into an explicit provider instruction

### 6. Model and Provider Selection

The agent must support:

- built-in model IDs
- optional custom providers via `ModelProvider`
- provider endpoint testing in Settings if custom endpoints are allowed

Codex baseline:

- built-in models come from `BUILTIN_CHAT_MODELS_BY_AGENT.codex`
- defaults come from `DEFAULT_CHAT_MODEL_BY_AGENT.codex`
- custom providers use the OpenAI Responses API contract
- local Codex CLI config can override the effective built-in model/provider

### 7. Plan Mode

If the agent can generate plan-like output, the runtime must normalize it into the common plan flow.

Required behavior:

- plan output becomes a `plan.created` event
- plan review works after refresh/reconnect
- non-plan activity before the plan remains visible in the timeline
- plan mode does not silently mutate the workspace

Codex baseline:

- structured plan updates are normalized
- `<proposed_plan>` fallback is supported
- emitted plan source is `codex_plan_item`

### 8. Subagents

If the provider supports delegation, the runtime must map it into:

- `subagent.started`
- `subagent.finished`

Minimum data:

- `agentId`
- `agentType`
- `toolUseId`
- `description`
- `lastMessage` on finish when available

### 9. Abort / Stop

The runner must stop promptly when the runtime aborts the turn.

Required behavior:

- abort propagates from `AbortController`
- child process / transport is torn down
- the runner rejects with `AbortError`
- partial assistant output remains preserved by chat service behavior

### 10. Error Reporting

Errors must be actionable.

Expected behavior:

- startup failures explain whether the binary, auth, provider config, or runtime transport failed
- provider-specific overrides are surfaced in failure hints when relevant
- route and UI layers can show a stable message without guessing provider internals

Codex baseline:

- error hints include the effective CLI provider and config path when local Codex config overrides model/provider resolution

## Runtime Contract

All CLI agents are adapted to the `ChatAgentRunner` contract in `apps/runtime/src/types.ts`.

The minimum runner contract is:

```ts
type ChatAgentRunner = (args: {
  prompt: string;
  sessionId: string | null;
  listSlashCommandsOnly?: boolean;
  sessionWorktreePath?: string | null;
  cwd: string;
  abortController?: AbortController;
  onSessionId?: (sessionId: string) => Promise<void> | void;
  permissionMode?: ChatMode;
  threadPermissionMode?: ChatThreadPermissionMode;
  permissionProfile?: ChatThreadPermissionProfile;
  autoAcceptTools?: boolean;
  model?: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
  onText: (chunk: string) => Promise<void> | void;
  onToolStarted: (...) => Promise<void> | void;
  onToolOutput: (...) => Promise<void> | void;
  onToolFinished: (...) => Promise<void> | void;
  onQuestionRequest: (...) => Promise<{ answers: Record<string, string> }>;
  onPermissionRequest: (...) => Promise<{ decision: PermissionDecision; message?: string }>;
  onPlanFileDetected: (...) => Promise<void> | void;
  onSubagentStarted: (...) => Promise<void> | void;
  onSubagentStopped: (...) => Promise<void> | void;
}) => Promise<ChatAgentRunnerResult>;
```

New agents must map their native protocol into this contract instead of extending the contract casually. If the contract is missing something fundamental, change the shared contract deliberately and update all agents.

## Codex Baseline Capability Matrix

| Capability | Codex Baseline | What a new agent must do |
|---|---|---|
| Agent registration | `CliAgent = "codex"` | Add enum entry everywhere that currently assumes a closed set |
| Built-in models | `BUILTIN_CHAT_MODELS_BY_AGENT.codex` | Declare built-ins and default model |
| Session persistence | `codexSessionId` on thread | Add provider-specific session storage or a generalized replacement |
| Slash command listing | `skills/list`, fallback to local skill scan | Define command discovery path and fallback behavior |
| Skill prompt normalization | `/skill` and `$skill` normalize to explicit Codex instruction | Define whether the agent needs prompt rewriting and test it |
| Provider overrides | CLI config + custom Responses endpoint | Define custom provider path if applicable |
| Plan mode | structured plan extraction + deny mutating approvals | Preserve product-level plan semantics |
| Questions | request-user-input normalization | Normalize provider question payloads |
| Permissions | command/file change/general approvals | Normalize native approvals into runtime decisions |
| Subagents | start/finish lifecycle + ownership mapping | Normalize delegation events |
| Abort | process kill + `AbortError` | Stop quickly and predictably |
| Timeline compatibility | plan/tool/subagent output fit common timeline model | Avoid provider-specific rendering hacks in web |

## Required Integration Surfaces

When adding a new CLI agent, check every surface below.

### 1. Shared Types

Files:

- `packages/shared-types/src/workflow.ts`

Required updates:

- add the agent to `CliAgentSchema`
- add built-in models to `BUILTIN_CHAT_MODELS_BY_AGENT`
- add a default to `DEFAULT_CHAT_MODEL_BY_AGENT`
- ensure `ChatThreadSchema` supports the new agent session field if using per-agent session columns
- ensure create/update input schemas accept the new agent
- ensure `ModelProviderSchema` and `TestModelProviderInputSchema` work for the agent

### 2. Database / Persistence

Files:

- `apps/runtime/prisma/schema.prisma`
- new Prisma migration under `apps/runtime/prisma/migrations/...`

Required updates:

- persist agent enum support
- persist any provider-specific session ID, if still using per-agent thread columns
- preserve existing default data for older rows
- update related indexes if needed

Current pattern:

- `claudeSessionId`
- `codexSessionId`
- `opencodeSessionId`

If future growth makes per-agent columns too expensive, replace them with a generalized session map only as an intentional refactor. Do not mix patterns accidentally.

### 3. Runtime Runner

Files:

- add `apps/runtime/src/<agent>/sessionRunner.ts`
- add supporting parser / config / policy helpers under `apps/runtime/src/<agent>/...`

Required responsibilities:

- spawn or connect to the provider CLI/runtime
- translate native events into runtime callbacks
- handle session start/resume
- handle list-slash-commands mode if supported
- handle custom provider base URL and API key if supported
- honor aborts
- normalize provider-specific approval and question payloads
- normalize plan and subagent events

Recommended split, based on Codex:

- `sessionRunner.ts` for transport and orchestration
- `config.ts` for provider override/config parsing
- `plan.ts` for plan normalization
- `toolContext.ts` for tool and ownership mapping
- `protocolUtils.ts` for raw payload coercion
- `collaborationMode.ts` for permission/plan policy

### 4. Runtime Chat Service

Files:

- `apps/runtime/src/services/chat/chatService.ts`

Required updates:

- `normalizeAgent`
- `resolveDefaultModelForAgent`
- `resolveThreadSelection`
- `getRunnerForAgent`
- `getThreadSessionId`
- `buildSessionIdUpdate`
- `buildSelectionUpdate`
- any agent-specific prompt normalization logic
- `listSlashCommands`
- error hint integration if the agent has a CLI config override story

Required product behaviors:

- thread creation inherits the current agent/model selection
- agent selection changes clear provider session state
- send path uses the selected agent
- optimistic thread behavior remains correct

### 5. Runtime HTTP Routes

Files:

- `apps/runtime/src/routes/chats.ts`
- `apps/runtime/src/routes/models.ts`

Required updates:

- chat route query validation for slash commands
- model provider endpoint test contract
- optional model catalog endpoint if the agent needs dynamic built-in model discovery

Important current gotcha:

- `apps/runtime/src/routes/chats.ts` currently validates slash command agent query with `z.enum(["claude", "codex"])`

That means adding a new agent requires a route update even if shared types were already updated.

### 6. Web API Layer

Files:

- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/queryKeys.ts`
- any agent-specific data hook, for example `useOpencodeModels`

Required updates:

- API calls accept the new agent value
- slash command query keys vary by agent
- any dynamic model catalog endpoint has a matching hook and fallback behavior

### 7. Web Composer

Files:

- `apps/web/src/components/workspace/composer/Composer.tsx`

Required updates:

- `AGENT_LABELS`
- icon mapping
- built-in model display names
- agent-specific model options
- custom provider listing for the new agent
- agent hover/preview behavior
- mobile session settings flow
- model selector lock behavior still applies when thread has messages

If the agent has special slash command semantics, the composer must still keep UI behavior stable. Codex is the current example:

- UI inserts `/dogfood`
- runtime may normalize it to `$dogfood`
- the user never has to learn a different composer syntax for the same feature

### 8. Web Settings

Files:

- `apps/web/src/components/workspace/SettingsDialog.tsx`

Required updates:

- agent dropdown options
- provider protocol mapping
- placeholder text
- inline help copy
- endpoint test behavior
- edit/delete labels for provider rows

If the agent uses Responses-compatible custom endpoints, reflect that clearly in help text and tests.

### 9. Web Session State

Files:

- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts`
- `apps/web/src/collections/threads.ts`

Required updates:

- optimistic agent selection update clears the correct session ID
- thread hydration preserves the new selection fields
- composer defaults resolve correctly for the new agent
- creating additional threads carries forward the active selection
- message submit waits for in-flight agent selection updates

### 10. Timeline / Event Interpretation

Files to inspect:

- `apps/web/src/pages/workspace/eventUtils.ts`
- `apps/web/src/pages/workspace/hooks/usePendingGates.test.tsx`
- `apps/web/src/pages/workspace/hooks/useWorkspaceTimeline.test.tsx`
- `packages/chat-timeline-core/...`

Required updates if the agent introduces provider-specific plan or tool event shapes:

- plan detection heuristics
- canonical plan source handling
- tool/activity item ordering
- subagent rendering

Provider-specific event payloads should be normalized in runtime whenever possible. Web should not become a pile of agent-specific conditionals.

## Definition Of Done For A New CLI Agent

A new agent integration is considered complete only if all of the following are true:

- the agent can be selected in the composer
- a new thread can be created with that agent
- a follow-up message reuses the correct provider session
- built-in models are selectable
- custom provider entries work if supported
- slash commands behave intentionally
- permission prompts work
- plan mode works
- stop/abort works
- thread refresh/reload preserves timeline integrity
- all required tests pass
- targeted dogfood is completed

## Required Test Coverage

The test plan below is mandatory. Reuse Codex tests as the template.

### A. Shared Types And Schema Tests

Purpose:

- prove the new agent is part of the common domain contract

Test cases:

1. `CliAgentSchema` accepts the new agent.
2. `BUILTIN_CHAT_MODELS_BY_AGENT.<agent>` is present and non-empty.
3. `DEFAULT_CHAT_MODEL_BY_AGENT.<agent>` points to a valid built-in default unless the product intentionally defaults to a dynamic catalog entry.
4. `CreateChatThreadInputSchema` accepts the new agent.
5. `UpdateChatThreadAgentSelectionInputSchema` accepts the new agent.
6. `ModelProvider` create/update/test schemas accept the new agent.

### B. Database / Migration Tests

Purpose:

- prove persisted threads remain compatible

Test cases:

1. Existing threads migrate with sane defaults.
2. New threads created without explicit agent still default correctly.
3. New threads created with the new agent persist correct `agent`, `model`, `modelProviderId`.
4. Provider-specific session ID field persists and reloads correctly.

### C. Runner Unit Tests

Purpose:

- prove the adapter itself is correct independent of chat service

Minimum test cases, modeled after Codex:

1. Starts the provider process/runtime with the expected args.
2. Passes custom provider base URL and API key correctly.
3. Resolves and emits provider session ID.
4. Streams text deltas through `onText`.
5. Emits tool start/output/finish in stable order.
6. Normalizes permission requests.
7. Maps permission decisions back to the provider protocol.
8. Normalizes structured questions.
9. Emits plan payloads through `onPlanFileDetected`.
10. Emits subagent start/finish with stable `toolUseId`.
11. Supports slash-command listing mode, if applicable.
12. Rejects with `AbortError` when aborted mid-turn.
13. Produces actionable errors on startup failure.

Codex examples to mirror:

- `apps/runtime/test/codex.sessionRunner.test.ts`
- `apps/runtime/test/codex.sessionRunner.skills.test.ts`
- `apps/runtime/test/codex.sessionRunner.abort.test.ts`

### D. Chat Service Integration Tests

Purpose:

- prove the runtime orchestrates the new agent correctly

Minimum test cases:

1. `updateThreadAgentSelection` routes threads to the new runner.
2. The correct session ID field is persisted after a turn.
3. The old agent session fields are cleared when switching agents.
4. Built-in model resolution works.
5. Active provider resolution works.
6. Custom provider mismatch is rejected with a clear error.
7. Agent selection cannot change while a thread is running.
8. Agent selection cannot change after the thread has messages.
9. Creating a new thread inherits the active composer selection.
10. Sending a message uses the selected agent and selected model.
11. Agent-specific prompt preprocessing runs only for that agent.
12. Error hints include provider/config context if the new agent supports local overrides.

Codex reference:

- `apps/runtime/test/chatService.agent-selection.test.ts`

### E. Slash Command Tests

Purpose:

- prove command discovery and prompt normalization work

Minimum test cases:

1. `GET /api/worktrees/:id/slash-commands?agent=<agent>` accepts the new agent.
2. Runtime returns command catalog successfully.
3. Fallback path works when primary command discovery fails.
4. Unknown slash commands remain untouched.
5. Recognized agent-native commands are normalized correctly if the agent needs normalization.

Codex reference:

- `apps/runtime/test/codexSkills.test.ts`
- `apps/runtime/test/routes.chats.test.ts`
- `apps/runtime/test/codex.sessionRunner.skills.test.ts`

### F. Permission And Plan Tests

Purpose:

- prove product-level safety semantics still hold

Minimum test cases:

1. Default thread asks before approval-gated actions.
2. Full access thread auto-allows approval-gated actions.
3. Plan mode remains non-mutating by product policy.
4. Mutating plan-mode requests are denied or mapped safely.
5. Read/search-only plan-mode actions remain allowed.
6. Plan payload is persisted as a canonical `plan.created` event.
7. Plan review survives refresh/reconnect.

Codex reference:

- `apps/runtime/test/codex.sessionRunner.test.ts`
- `apps/runtime/test/chatService.permissions.test.ts`

### G. Route Tests

Purpose:

- prove HTTP surface accepts the new agent everywhere

Minimum test cases:

1. `PATCH /api/threads/:id/agent-selection` accepts the new agent.
2. `GET /api/worktrees/:id/slash-commands?agent=<agent>` accepts the new agent.
3. `POST /api/model-providers/test` uses the correct protocol for the agent.
4. Agent-specific model catalog endpoint responds correctly, if present.
5. Route errors return stable status codes and useful messages.

Codex/OpenCode reference:

- `apps/runtime/test/routes.chats.test.ts`
- `apps/runtime/test/routes.models.test.ts`

### H. Web Component Tests

Purpose:

- prove the agent is actually usable in the UI

Minimum test cases:

1. Composer shows the new agent in the selector.
2. Composer shows built-in model options for the new agent.
3. Composer shows custom provider-backed models for the new agent.
4. Choosing the new agent emits `onAgentSelectionChange` with the correct payload.
5. Model selector stays locked once the thread has messages.
6. Slash command suggestions load for the new agent.
7. Session settings/mobile flow still works with the new agent.
8. Settings dialog shows the new agent in provider forms.
9. Settings dialog shows correct placeholders/help text.
10. Settings dialog sends the right payload to provider test API.

Reference tests:

- `apps/web/src/components/workspace/Composer.test.tsx`
- `apps/web/src/components/workspace/SettingsDialog.test.tsx`

### I. Web Hook / State Tests

Purpose:

- prove thread state transitions remain correct

Minimum test cases:

1. `useChatSession` carries the new selection into new threads.
2. `useChatSession` waits for pending agent selection update before sending.
3. Optimistic selection clears the correct session field.
4. Hydrated threads preserve the new agent and model.
5. Slash command query keys vary by agent.

Reference tests:

- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.render.test.tsx`
- `apps/web/src/pages/workspace/hooks/useSlashCommands.test.tsx`
- `apps/web/src/lib/api.test.ts`
- `apps/web/src/lib/queryKeys.test.ts`

### J. Manual Dogfood

Purpose:

- catch the cross-layer bugs unit tests miss

Minimum manual checks:

1. Open a clean thread, switch to the new agent, and send a short prompt.
2. Refresh the page and send a follow-up prompt. Confirm session continuity.
3. Trigger slash command suggestions and verify the expected catalog.
4. Trigger a permission request and verify approve/deny flows.
5. Run in plan mode and verify plan review behavior.
6. Stop a running turn and confirm partial output is preserved.
7. Verify mobile or narrow viewport behavior if any new header or composer chrome was added.

## Recommended File Checklist

Use this as a concrete implementation checklist:

- `packages/shared-types/src/workflow.ts`
- `apps/runtime/prisma/schema.prisma`
- `apps/runtime/prisma/migrations/...`
- `apps/runtime/src/types.ts` if the shared runner contract changes
- `apps/runtime/src/<agent>/sessionRunner.ts`
- `apps/runtime/src/<agent>/config.ts` if needed
- `apps/runtime/src/services/chat/chatService.ts`
- `apps/runtime/src/routes/chats.ts`
- `apps/runtime/src/routes/models.ts`
- `apps/runtime/test/<agent>.sessionRunner*.test.ts`
- `apps/runtime/test/chatService.agent-selection.test.ts`
- `apps/runtime/test/routes.chats.test.ts`
- `apps/runtime/test/routes.models.test.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/queryKeys.ts`
- `apps/web/src/components/workspace/composer/Composer.tsx`
- `apps/web/src/components/workspace/SettingsDialog.tsx`
- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts`
- `apps/web/src/hooks/queries/useSlashCommandsQuery.ts`
- `apps/web/src/components/workspace/Composer.test.tsx`
- `apps/web/src/components/workspace/SettingsDialog.test.tsx`
- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.render.test.tsx`

## Common Failure Modes

These are the regressions most likely to happen when adding an agent:

1. The enum is updated, but route validation still hardcodes the old agent set.
2. The composer shows the new agent, but `useChatSession` does not clear or persist the right session field.
3. The runtime can send messages, but slash command fetching still uses old assumptions.
4. Settings can create a provider row, but provider endpoint testing still uses the wrong wire protocol.
5. The new runner streams text, but tool events are missing or out of order.
6. Plan output renders in the live run but disappears after refresh because it was not normalized into canonical events.
7. Full access or plan mode semantics drift from the product rules.
8. Agent selection works on a brand new thread but breaks after the first message because the lock semantics were not preserved.

## Preferred Delivery Sequence For A New Agent

Use this order to keep the rollout safe:

1. Add shared types and persistence.
2. Implement a minimal runner that can start, emit text, persist a session ID, and abort.
3. Wire chat service agent selection and message routing.
4. Add model/provider testing support.
5. Add slash command support.
6. Add permission, plan, and subagent normalization.
7. Add web composer and settings support.
8. Fill out integration and manual tests.

## Minimum Review Questions

Before merging a new CLI agent, reviewers should be able to answer "yes" to all of these:

- Is the new agent selectable end-to-end from the composer?
- Is session reuse explicit and tested?
- Are permission semantics aligned with existing product rules?
- Is plan mode safe and timeline-stable?
- Are slash commands intentionally supported or intentionally empty?
- Is provider testing using the right protocol?
- Are route validators updated everywhere?
- Are the required runtime, route, and web tests present?

If any answer is "no", the integration is incomplete.
