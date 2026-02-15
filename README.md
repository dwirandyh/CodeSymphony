# CodeSymphony Workspace MVP

Local-first conductor.build-style workspace with:

- Repository onboarding from local filesystem paths
- Git worktree branch creation per repository
- Threaded Claude chat sessions bound to a selected worktree
- Live chat + tool events over SSE
- Web client (React + Vite) and optional desktop shell (Tauri)

## Architecture

- `apps/runtime` - local API service (Fastify + Prisma + SQLite + Claude Agent SDK)
- `apps/web` - web UI with repository sidebar and chat panel
- `apps/desktop` - Tauri shell
- `packages/shared-types` - shared API schemas/types
- `packages/orchestrator-core` - standalone utility package (not required by runtime)

Both clients connect to `http://127.0.0.1:4321` by default.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Git installed and available in PATH
- Claude Code CLI installed and authenticated (`claude login`)

Optional:
- Rust + Cargo + Tauri prerequisites (desktop)

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure runtime:

```bash
cp apps/runtime/.env.example apps/runtime/.env
```

Recommended `.env` values:

```env
RUNTIME_HOST=127.0.0.1
RUNTIME_PORT=4321
DATABASE_URL="file:./dev.db"
CLAUDE_CODE_EXECUTABLE=claude
WORKTREE_ROOT="~/.codesymphony/worktrees"
```

3. Initialize database:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

## Run

Web + runtime:

```bash
pnpm dev
```

- Web: `http://127.0.0.1:5173`
- Runtime: `http://127.0.0.1:4321`

Runtime only:

```bash
pnpm dev:runtime
```

Web only:

```bash
pnpm dev:web
```

Desktop shell:

```bash
pnpm dev:desktop
```

## Core Flow

1. Add a repository by local path in the sidebar.
2. Select the repository and create a worktree branch.
3. Select that worktree and open/create a chat thread.
4. Send prompts; Claude executes in that worktree `cwd`.
5. Watch message deltas and tool logs stream in real time.

## API Quick Reference

Base URL: `http://127.0.0.1:4321/api`

- `GET /repositories`
- `GET /repositories/:id`
- `POST /repositories`
- `POST /repositories/:id/worktrees`
- `GET /worktrees/:id`
- `DELETE /worktrees/:id`
- `GET /worktrees/:id/threads`
- `POST /worktrees/:id/threads`
- `GET /threads/:id`
- `GET /threads/:id/messages`
- `POST /threads/:id/messages`
- `GET /threads/:id/events`
- `GET /threads/:id/events/stream`
- `GET /health`

## Test and Build

```bash
pnpm test
pnpm lint
pnpm build
```
