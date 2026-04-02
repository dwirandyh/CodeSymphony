# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies
pnpm install

# Start runtime + web together (primary dev workflow)
pnpm dev

# Start individual apps
pnpm dev:runtime    # Fastify backend on :4331
pnpm dev:web        # Vite dev server on :5173
pnpm dev:desktop    # Tauri shell (requires Rust/Cargo)

# Database setup (required before first run)
pnpm db:generate && pnpm db:migrate && pnpm db:seed

# Build, test, lint (all workspaces via Turbo)
pnpm build
pnpm test
pnpm lint           # TypeScript typecheck (tsc --noEmit)

# Run tests for a single workspace
pnpm --filter @codesymphony/runtime test
pnpm --filter @codesymphony/web test

# Run a specific test file
pnpm --filter @codesymphony/runtime test -- chatService.permissions.test.ts

# Build a single workspace
pnpm --filter @codesymphony/web build
pnpm --filter @codesymphony/runtime build
```

Makefile shortcuts are also available (`make dev`, `make test`, `make lint`, `make build`, `make db-init`).

## Architecture

Local-first monorepo (pnpm workspaces + Turbo) for a conductor.build-style AI coding workspace.

### Apps

- **`apps/runtime`** — Fastify API server + Prisma (SQLite) + Claude Agent SDK. The single local backend serving both web and desktop clients. Entry point: `src/index.ts`. Defaults to port 4331 in dev; desktop bundle sets 4321 explicitly.
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

- Node.js 22+, pnpm 10+, Git in PATH, Claude Code CLI authenticated (`claude login`)
- Copy `apps/runtime/.env.example` to `apps/runtime/.env` before first run
- Runtime scripts use `tsx --env-file .env` so `DATABASE_URL` is always loaded
- Runtime tests use a separate `prisma/test.db` (set via `DATABASE_URL="file:./test.db"` in the test script)
- Sanitize env before `query()`: unset `CLAUDECODE` and remove empty `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` to avoid CLI errors

## React Best Practices

Follow `.agents/skills/vercel-react-best-practices/SKILL.md` when writing or refactoring React code. Key priorities: eliminate waterfalls, optimize bundle size, minimize re-renders.

## Debug Instrumentation

The web app has a client-to-server debug logging system for diagnosing render loops, state issues, and other browser-side problems that are hard to inspect directly.

- **Client utility**: `apps/web/src/lib/debugLog.ts` — `debugLog(source, message, data)` fires entries via `navigator.sendBeacon` to runtime + stores in `window.__CS_DEBUG_LOG__`
- **Server endpoint**: `POST /api/debug/log` (`apps/runtime/src/routes/debug.ts`)
- **Log file**: `apps/runtime/debug.log` — append-only, one JSON entry per line, readable by Claude Code
- **Browser extract**: `copy(JSON.stringify(window.__CS_DEBUG_LOG__.slice(0, 200), null, 2))`

To debug a new issue: add `debugLog("source", "message", data)` calls at relevant state-transition points, reproduce, then read `debug.log`.
