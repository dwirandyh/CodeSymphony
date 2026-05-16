# CodeSymphony

Local-first, conductor.build-style workspace: onboard Git repositories, manage worktrees, and run threaded AI coding sessions through **several local CLI coding agents** (not only Claude), with live SSE tool and message events. Ships as a **web app** (React + Vite) and an optional **desktop shell** (Tauri).

## Features

- Repository onboarding from local filesystem paths (and directory pick where supported)
- Git worktrees per repository; agent runs with the selected worktree as `cwd`
- Threaded chat per **CLI agent** (`claude`, `codex`, `cursor`, `opencode`): streaming deltas, tool lifecycle, plan/execute gates, and permission prompts; optional **custom model providers** in the UI for agents that support them (Claude, Codex, OpenCode — not Cursor)
- Integrated editor-style affordances (files, git status/diff, device streaming sidecars)
- Local SQLite persistence for chat threads, events, and repository metadata
- Workspace-wide event stream for cross-panel updates

## CLI coding agents

Each chat thread picks an **agent** (`claude` \| `codex` \| `cursor` \| `opencode`). Install and authenticate only the CLIs you use; the runtime shells out to the corresponding binary and normalizes streaming into the same event timeline.

| Agent | What runs | Default binary / env override | Notes |
|-------|-----------|----------------------------------|--------|
| **Claude** | [Claude Code](https://docs.anthropic.com/claude-code) via the TypeScript Agent SDK | `CLAUDE_CODE_EXECUTABLE` → `claude` | `claude login`; primary path uses `@anthropic-ai/claude-agent-sdk` |
| **Codex** | OpenAI **Codex** CLI (app-server / headless integration in this repo) | `CODEX_BINARY_PATH` → `codex` | Configure auth and models the Codex way (`~/.codex/config.toml`, etc.); optional OpenAI-compatible **custom provider** rows in Settings map to Codex when active |
| **Cursor** | **Cursor** CLI in ACP mode | `CURSOR_AGENT_BINARY_PATH` → `cursor-agent` | Uses Cursor’s built-in model list; **no** custom base URL/API key providers in CodeSymphony |
| **OpenCode** | **OpenCode** CLI | `OPENCODE_BINARY_PATH` → `opencode` | Optional custom providers like Claude/Codex; model discovery via `/api/opencode/models` |

Thread model selection and **Model providers** in the app call `GET/POST /api/model-providers` (and related routes in `apps/runtime/src/routes/models.ts`). Builtin model IDs per agent are defined in `packages/shared-types` (`CliAgent`, `BUILTIN_CHAT_MODELS_BY_AGENT`).

## Architecture

| Path | Role |
|------|------|
| `apps/runtime` | Fastify API, Prisma + SQLite, chat runners (`claude` / `codex` / `cursor` / `opencode`), device/git/filesystem routes |
| `apps/web` | React 19 + Vite + Tailwind workspace UI |
| `apps/desktop` | Tauri shell wrapping the web app |
| `packages/shared-types` | Zod schemas and shared API types |
| `packages/chat-timeline-core` | Timeline assembly from chat events (used by the web app; built in parallel during `pnpm dev`) |
| `packages/orchestrator-core` | Standalone run state machine (not required by the runtime) |

Implementations live under `apps/runtime/src/routes/` (grouped by domain: `chats`, `repositories`, `devices`, `models`, etc.). Keep new API routes grouped by the same domain boundary.

### Default ports

| Service | Port (typical) |
|---------|----------------|
| Runtime (dev) | `4331` |
| Web (Vite dev) | `5173` |
| Desktop dev (Tauri webview) | `5174` (see Tauri / Vite config) |
| Desktop dev sidecar runtime | `4321` |
| Packaged desktop app runtime | `4322` |

Running **multiple git worktrees** of this repo: use `make setup-worktree PORT=<runtime-port>` so each clone gets its own `RUNTIME_PORT` and matching `VITE_RUNTIME_PORT` / `VITE_DEV_PORT` in `apps/web/.env`. See `make help` for `setup-worktree-up` / `stop-worktree-up`.

## Prerequisites

- Node.js 22+
- pnpm 10+ (repo pins `packageManager` in root `package.json`)
- Git on `PATH`
- **At least one** supported coding CLI on `PATH` (or configured via the env vars in [CLI coding agents](#cli-coding-agents)), with that tool’s normal login/auth completed

Optional (install as needed):

- Rust + Cargo + Tauri prerequisites (desktop)
- **Android streaming**: `ws-scrcpy` sidecar — `make setup-android-streaming` then `make start-android-streaming`. If `ANDROID_WS_SCRCPY_COMMAND` is unset, the runtime can fall back to `scripts/start-ws-scrcpy.sh` when present.
- **iOS simulator bridge**: optional `IOS_SIMULATOR_BRIDGE_COMMAND` in `apps/runtime/.env` (see `.env.example`).

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure the runtime:

```bash
cp apps/runtime/.env.example apps/runtime/.env
```

Recommended baseline (adjust paths as needed):

```env
RUNTIME_HOST=0.0.0.0
RUNTIME_PORT=4331
DATABASE_URL="file:./dev.db"
WORKTREE_ROOT="~/.codesymphony/worktrees"
# Agent binaries (optional; defaults shown in .env.example)
CLAUDE_CODE_EXECUTABLE=claude
CODEX_BINARY_PATH=codex
CURSOR_AGENT_BINARY_PATH=cursor-agent
OPENCODE_BINARY_PATH=opencode
```

The dev database file is created under `apps/runtime/prisma/` when you migrate. Runtime tests use `apps/runtime/prisma/test.db`; desktop dev may use `desktop.db` — Prisma resolves `file:./…` URLs relative to `apps/runtime/prisma/schema.prisma`.

3. Initialize the database:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

(`pnpm db:seed` sets `DATABASE_URL` for the seed script; ensure `apps/runtime/.env` matches your dev DB.)

## Run

**Web + runtime** (also watches `chat-timeline-core` for TypeScript changes):

```bash
pnpm dev
```

or:

```bash
make dev
```

The Makefile targets are convenience wrappers around the same pnpm scripts.

- Web: `http://127.0.0.1:5173` (Vite proxies `/api` to the runtime)
- Runtime: JSON API under `http://127.0.0.1:4331/api`; liveness at `http://127.0.0.1:4331/health` (not under `/api`)
- Quick smoke check: open `http://127.0.0.1:4331/health` before debugging API or UI issues.

**Runtime only** — `pnpm dev:runtime`  
**Web only** — `pnpm dev:web` (expects a running runtime for API calls)

**Production-style run** (builds runtime + web, then serves bundled web from the runtime):

```bash
pnpm run
```

or `make run` (stops common dev processes first).

**Desktop**:

```bash
pnpm dev:desktop
```

Release macOS app (signing identity required for distribution):

```bash
APPLE_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm --filter @codesymphony/desktop build:app
```

Use `CODESYMPHONY_MACOS_SIGN_IDENTITY` as an alias for the signing identity. Use `pnpm --filter @codesymphony/desktop build:app:adhoc` only for local ad-hoc builds; TCC-sensitive features (e.g. screen recording) may not behave like a properly signed app.

Build outputs:

- `.app`: `apps/desktop/src-tauri/target/release/bundle/macos/CodeSymphony.app`
- `.dmg`: `apps/desktop/src-tauri/target/release/bundle/dmg/` when you run `pnpm --filter @codesymphony/desktop build`

## Desktop app troubleshooting

If the installed `.app` / `.dmg` build feels stale, the thread UI gets stuck, or the app fails while the browser at `http://127.0.0.1:4322` still works, inspect the packaged runtime logs first.

Find the app data directory used by the installed macOS app:

```bash
APP_SUPPORT_DIR="${HOME}/Library/Application Support/com.codesymphony.app"
test -d "${APP_SUPPORT_DIR}" || APP_SUPPORT_DIR="$(find "${HOME}/Library/Application Support" -maxdepth 1 -name 'com.codesymphony.app' -print -quit)"
printf '%s\n' "${APP_SUPPORT_DIR}"
```

Important packaged-app files:

- `debug.log` — client + runtime debug events written through `POST /api/debug/log`
- `runtime.stdout.log` — packaged runtime stdout
- `runtime.stderr.log` — packaged runtime stderr
- `codesymphony.db` — packaged desktop SQLite database

Read the latest lines:

```bash
tail -n 200 "${APP_SUPPORT_DIR}/debug.log"
tail -n 200 "${APP_SUPPORT_DIR}/runtime.stdout.log"
tail -n 200 "${APP_SUPPORT_DIR}/runtime.stderr.log"
```

If the app fails before those files are created, launch the bundle binary directly from Terminal to capture desktop-shell errors:

```bash
/Applications/CodeSymphony.app/Contents/MacOS/codesymphony-desktop
```

If the packaged runtime is up, these endpoints are available on the desktop runtime port (`4322`):

```bash
curl http://127.0.0.1:4322/health
curl http://127.0.0.1:4322/api/debug/runtime-info
curl "http://127.0.0.1:4322/api/debug/log-buffer?limit=200"
```

For thread ordering / stale-stream issues, filter the log buffer to the selected thread:

```bash
curl "http://127.0.0.1:4322/api/debug/log-buffer?source=thread.stream,thread.workspace&threadId=<thread-id>&limit=200"
```

If the installed app UI is stuck but the runtime is healthy, open the same packaged runtime in a normal browser at `http://127.0.0.1:4322`, enable focused debug logging there, reproduce once, then inspect `debug.log` or `/api/debug/log-buffer`:

```js
localStorage.setItem("codesymphony.debugLog", "true");
localStorage.setItem("codesymphony.debugLog.sources", "thread.stream,thread.workspace");
localStorage.setItem("codesymphony.debugLog.threadId", "<thread-id>");
location.reload();
```

Clear the filters after capture:

```js
localStorage.removeItem("codesymphony.debugLog");
localStorage.removeItem("codesymphony.debugLog.sources");
localStorage.removeItem("codesymphony.debugLog.threadId");
location.reload();
```

## Makefile shortcuts

```bash
make help
make install
make stop-dev      # kills common dev processes (use carefully if you share a machine)
make dev
make dev-runtime
make dev-web
make dev-desktop
make setup-android-streaming
make start-android-streaming
make db-init
make setup-worktree PORT=<runtime-port>
make lint
make test
make build
make run
```

Use `make help` to see the current shortcut list and any workflow-specific options.

The packaged desktop bundle can include the Android `ws-scrcpy` sidecar under the runtime bundle so macOS builds are not tied to this repo’s `scripts/` directory on disk.

## Core user flow

1. Add a repository (path or picker).
2. Select the repository and create or select a worktree branch.
3. Bind a chat thread to that worktree.
4. Send prompts; the agent executes in that worktree.
5. Observe streaming text, tools, permissions, and plan steps in the timeline.

## HTTP API overview

Base URL: `http://127.0.0.1:4331/api`

High-level groups (non-exhaustive — see `apps/runtime/src/routes/*.ts`):

- **Repositories & worktrees** — `GET/POST /repositories`, `POST /repositories/:id/worktrees`, `GET /worktrees/:id`, git and file helpers under `/worktrees/:id/git/*`, `/worktrees/:id/files/*`, setup runners, reviews.
- **Chat** — `GET/POST …/threads`, `GET /threads/:id`, messages, `GET /threads/:id/events`, `GET /threads/:id/events/stream`, timeline/snapshot, stop, plan approve/dismiss/revise, `POST /threads/:id/permissions/resolve`, questions.
- **Workspace** — `GET /workspace/events/stream` for cross-panel updates.
- **Devices** — `GET /devices`, `GET /devices/stream`, stream start/stop/control, Android viewer proxy, iOS native bridge hooks.
- **Models & providers** — `GET /model-providers`, Cursor/OpenCode model discovery, create/activate custom providers (Claude/Codex/OpenCode), activation tests.
- **System & filesystem** — `POST /system/pick-directory`, clipboard, `GET /filesystem/browse`, attachments.
- **Debug** — `POST /debug/log`, `GET /debug/log-buffer`, `GET /debug/runtime-info`.
- **Health** — `GET /health` on the runtime host root (same port as `/api`, no `/api` prefix).

## Test, lint, and build

```bash
pnpm test
pnpm lint
pnpm build
pnpm knip          # optional: unused exports/deps scan (see knip.ts)
```

Single-package examples:

```bash
pnpm --filter @codesymphony/runtime test -- chatService.permissions.test.ts
pnpm --filter @codesymphony/web test -- WorkspacePage.test.tsx
```

## Permission approval testing

Automated:

```bash
pnpm --filter @codesymphony/runtime test -- chatService.permissions.test.ts chats.stream.test.ts
pnpm --filter @codesymphony/web test -- WorkspacePage.test.tsx
pnpm test
```

Manual end-to-end:

1. Start with `make dev`.
2. Open the web app, pick repository → worktree → thread.
3. Send a prompt that triggers a gated tool (e.g. a shell read of a system file).
4. Confirm the permission card shows tool/command/reason; **Deny** and verify the stream continues with deny context.
5. Retry; **Approve** and verify `tool.*` events and completion.
6. Reload while a permission is pending and confirm the pending state replays from history.

Edge cases: duplicate approve/deny should no-op after the first decision; unknown `requestId` on resolve should `400`; no tool execution before resolution; restart during pending should fail clearly rather than hang.

**Exit criteria:** no spurious `runtime-integrity-warning` in assistant output; gated work only proceeds after UI approve/deny; stream reaches a terminal `chat.completed` / `chat.failed`; `permission.requested` / `permission.resolved` events replay after reload.
last updated: 2026-05-03
