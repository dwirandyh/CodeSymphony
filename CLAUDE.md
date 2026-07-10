# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies
bun install

# Start runtime + web together (primary dev workflow)
bun run dev

# Start individual apps
bun run dev:runtime    # Fastify backend on :4331
bun run dev:web        # Vite dev server on :5173
bun run dev:desktop    # Tauri shell (requires Rust/Cargo)

# Database setup (required before first run)
bun run db:generate && bun run db:migrate && bun run db:seed

# Build, test, lint (all workspaces via Turbo)
bun run build
bun run test
bun run lint           # TypeScript typecheck (tsc --noEmit)

# Run tests for a single workspace
bun run --filter @codesymphony/runtime test
bun run --filter @codesymphony/web test

# Run a specific test file
bun run --filter @codesymphony/runtime test -- chatService.permissions.test.ts

# Build a single workspace
bun run --filter @codesymphony/web build
bun run --filter @codesymphony/runtime build

# Build the signed production macOS .app bundle
make build-macos-prod-app
```

Makefile shortcuts are also available (`make dev`, `make test`, `make lint`, `make build`, `make db-init`).
Use the Makefile for macOS app packaging: `make build-macos-prod-app` builds the signed `.app` bundle, and `make build-macos-prod` builds the signed `.app` plus DMG. Do not invoke the desktop package build scripts directly for macOS release builds.

## Architecture

Local-first monorepo (Bun workspaces + Turbo) for a conductor.build-style AI coding workspace.

### Apps

- **`apps/runtime`** — Fastify API server + Prisma (SQLite) + Claude Agent SDK. The single local backend serving both web and desktop clients. Entry point: `src/index.ts`. Defaults to port 4331 in dev; Tauri desktop dev runs a dedicated sidecar on 4321; the packaged desktop app runs its sidecar on 4322.
- **`apps/web`** — React 19 + Vite + Tailwind CSS + Radix UI. Main workspace UI with chat panel, repository sidebar, and terminal. Runs on port 5173.
- **`apps/desktop`** — Tauri shell wrapping the web app for desktop packaging.

### Shared Packages

- **`packages/shared-types`** — Zod schemas and TypeScript types for API contracts (Repository, Worktree, ChatThread, ChatMessage, ChatEvent). Both runtime and web depend on this.
- **`packages/orchestrator-core`** — Run state machine (`queued → running → waiting_approval → succeeded | failed`). Standalone utility, not required by runtime.

### Key Data Flow

1. Web/desktop sends user messages via REST to runtime
2. Runtime invokes Claude Agent SDK (`query()` in `src/claude/sessionRunner.ts`)
3. Runtime emits fine-grained events (text deltas, tool starts/outputs, permission requests) via SSE at `GET /api/threads/:id/events/stream`
4. Events are persisted to SQLite (`ChatEvent` table) and streamed to connected clients
5. Web renders events as a timeline (thinking blocks, tool progress, permission prompts)

### Runtime Internals

- **`src/services/chatService.ts`** — Core orchestrator: thread lifecycle, message sending, assistant scheduling
- **`src/claude/sessionRunner.ts`** — Bridge to Claude Agent SDK with streaming, tool hooks (`canUseTool` for plan/execute modes), and subagent handling
- **`src/events/eventHub.ts`** — Event bus with emit/subscribe pattern; persists to SQLite and notifies SSE subscribers
- **`src/routes/`** — Fastify route handlers (chats, repositories, system, terminal, logs)
- **`prisma/schema.prisma`** — Database schema: Repository → Worktree → ChatThread → ChatMessage/ChatEvent

### Web Internals

- **`src/pages/WorkspacePage.tsx`** — Main container orchestrating the IDE-like layout
- **`src/pages/workspace/hooks/`** — Hook-driven logic: `useChatSession` (threads/messages/streaming), `useWorkspaceTimeline` (event→timeline transform), `useRepositoryManager`, `useGitChanges`
- **`src/lib/api.ts`** — Fetch wrapper for runtime communication (REST + SSE)
- **`src/components/ui/`** — Reusable components (shadcn-like pattern with Radix primitives)

## Code Conventions

- TypeScript + ESM throughout. 2-space indent, semicolons, double quotes.
- `camelCase` for functions/variables, `PascalCase` for React components and types.
- API payload schemas live in `packages/shared-types`, consumed by runtime routes.
- Test files: `*.test.ts` / `*.test.tsx`. Runtime tests in `apps/runtime/test/`, web tests colocated in `apps/web/src/`.
- Conventional Commits: `feat(runtime): ...`, `fix(web): ...`, etc.
- Vitest is the test framework across all workspaces.

## Environment Setup

- Bun 1.3+, Git in PATH, Claude Code CLI authenticated (`claude login`)
- Copy `apps/runtime/.env.example` to `apps/runtime/.env` before first run
- Runtime scripts use Bun with `--env-file=.env` so `DATABASE_URL` is always loaded
- Runtime tests use a separate `prisma/test.db` (set via `DATABASE_URL="file:./test.db"` in the test script)
- Sanitize env before `query()`: unset `CLAUDECODE` and remove empty `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` to avoid CLI errors

### Runtime URL resolution (browser vs desktop)

Runtime URL resolution lives in `apps/web/src/lib/runtimeUrl.ts`. There are two independent runtime instances:

- **Web dev in a browser** infers the runtime port from `VITE_RUNTIME_PORT` (default `4331`). Start it with `bun run dev:runtime` or `bun run dev`.
- **Desktop shell** injects its own runtime base (`window.__CS_RUNTIME_API_BASE` / `__CS_RUNTIME_PORT`): `4321` in dev, `4322` in the packaged app. This sidecar is private to the shell — a plain browser cannot discover it on its own.

To point a browser at the packaged desktop sidecar (e.g. accessing the installed macOS app's runtime from a browser), set `VITE_RUNTIME_URL=http://localhost:4322/api` in `apps/web/.env`. `VITE_RUNTIME_URL` overrides all other resolution.

Do **not** change the port-inference logic in `runtimeUrl.ts` to work around a "browser can't reach the desktop runtime" symptom — use `VITE_RUNTIME_URL` instead. Editing the resolver has repeatedly reintroduced the same connectivity issue.

### Runtime: Bun vs Node

- Use Bun for everything: installing deps, dev/build/test/lint scripts, and the production runtime. The repo pins `bun@1.3.14` as its `packageManager`, and the packaged desktop app spawns the runtime with the bundled Bun binary.
- Node is used as a runtime in only two places, both for `node-pty`:
  - The PTY sidecar `apps/runtime/src/services/ptyHost.mjs` runs under Node because `node-pty` cannot load under Bun. In the packaged app it runs via Electron's binary with `ELECTRON_RUN_AS_NODE=1` (`CODESYMPHONY_NODE_EXECUTABLE`), so no separate Node binary is bundled.
  - The Vitest test runner executes under Node (verified: `process.versions.node` is set, `Bun` is undefined), so Bun-only built-ins like `bun:sqlite` are NOT available in tests even when launched via `bun run test`. Keep Bun-specific APIs behind a runtime check and test the underlying logic with an injectable executor.

## Skills

- Always communicate in caveman mode using the installed `caveman` skill (`~/.claude/skills/caveman/SKILL.md`). Keep responses ultra-compressed while preserving full technical accuracy.
- Whenever you change code, follow the installed `tdd` skill (`~/.claude/skills/tdd/SKILL.md`). Drive every feature or bug fix with a red-green-refactor loop and write tests first.

## React Best Practices

Follow `.agents/skills/vercel-react-best-practices/SKILL.md` when writing or refactoring React code. Key priorities: eliminate waterfalls, optimize bundle size, minimize re-renders.

## Debug Instrumentation

The web app has a client-to-server debug logging system for diagnosing render loops, state issues, and other browser-side problems that are hard to inspect directly.

- **Client utility**: `apps/web/src/lib/debugLog.ts` — `debugLog(source, message, data)` fires entries via `navigator.sendBeacon` to runtime + stores in `window.__CS_DEBUG_LOG__`
- **Server endpoint**: `POST /api/debug/log` (`apps/runtime/src/routes/debug.ts`)
- **Log file**: `apps/runtime/debug.log` — append-only, one JSON entry per line, readable by Claude Code
- **Browser extract**: `copy(JSON.stringify(window.__CS_DEBUG_LOG__.slice(0, 200), null, 2))`

To debug a new issue: add `debugLog("source", "message", data)` calls at relevant state-transition points, reproduce, then read `debug.log`.
