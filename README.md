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

Both clients connect to runtime on port `4321` by default.

## Docker Compose

Run web + runtime together with one command:

```bash
pnpm docker:up
```

Or directly:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

Endpoints:

- Web: `http://127.0.0.1:5173`
- Runtime: `http://127.0.0.1:4321`

Stop services:

```bash
pnpm docker:down
```

Important notes for Docker mode:

- Runtime runs in Linux container, so macOS `Browse` folder picker is unavailable.
- Use manual repository path input in the UI.
- Host project directory is mounted to `/workspace/repos`, so this repo is available at `/workspace/repos`.
- Worktrees and SQLite DB are persisted in Docker volume `runtime_data`.

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
RUNTIME_HOST=0.0.0.0
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

Or using `make` shortcuts:

```bash
make dev
```

- Web (same machine): `http://127.0.0.1:5173`
- Runtime (same machine): `http://127.0.0.1:4321`

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

## Makefile Shortcuts

```bash
make help
make install
make dev
make dev-runtime
make dev-web
make db-init
make lint
make test
make build
```

## Core Flow

1. Add a repository by local path in the sidebar.
2. Select the repository and create a worktree branch.
3. Select that worktree and open/create a chat thread.
4. Send prompts; Claude executes in that worktree `cwd`.
5. Watch message deltas and tool logs stream in real time.

## API Quick Reference

Base URL (same machine): `http://127.0.0.1:4321/api`

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
