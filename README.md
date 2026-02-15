# CodeSymphony MVP

Local-first conductor.build-inspired MVP with:

- Linear workflows
- Sequential step execution via Claude Agent SDK
- Live run logs (SSE)
- Approval checkpoints
- Web (React) and desktop (Tauri) local clients

## Architecture

- `apps/runtime` — local runtime service (Fastify + Prisma + SQLite + Claude Agent SDK)
- `apps/web` — web UI (React + Vite)
- `apps/desktop` — desktop shell (Tauri)
- `packages/shared-types` — shared schemas/types
- `packages/orchestrator-core` — deterministic run state machine
- `infra/docker` — optional Docker runtime setup

Both web and desktop connect to the same local runtime (`http://127.0.0.1:4321`).

---

## Prerequisites

- Node.js 22+
- pnpm 10+
- Claude runtime/auth configured for Agent SDK execution
  - Install Claude Code CLI and run `claude login`
- For desktop mode only: Rust + Cargo + Tauri prerequisites
- For Docker mode only: Docker + Docker Compose

---

## 1) Install dependencies

```bash
pnpm install
```

---

## 2) Configure runtime environment

```bash
cp apps/runtime/.env.example apps/runtime/.env
```

Edit `apps/runtime/.env`:

```env
RUNTIME_HOST=127.0.0.1
RUNTIME_PORT=4321
DATABASE_URL="file:./dev.db"
CLAUDE_CODE_EXECUTABLE=claude
```

Notes:
- `DATABASE_URL` is required.
- Runtime prompt steps use your installed Claude Code CLI session (`claude login`).
- Set `CLAUDE_CODE_EXECUTABLE` if `claude` is not on PATH for the runtime user.

---

## 3) Initialize database

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

This creates SQLite schema and seeds an example workflow.

---

## 4) Run the app

### Web + runtime (recommended)

```bash
pnpm dev
```

- Web: `http://127.0.0.1:5173`
- Runtime: `http://127.0.0.1:4321`

### Runtime only

```bash
pnpm dev:runtime
```

### Web only

```bash
pnpm dev:web
```

### Desktop (Tauri)

```bash
pnpm dev:desktop
```

Desktop auto-starts the runtime process from the workspace root.

---

## 5) Use the MVP

1. Open web UI (`/`) and create a workflow.
2. Add ordered steps:
   - `prompt`: sends prompt to Claude
   - `approval`: pauses run for human decision
3. Click **Run** on a workflow.
4. On run detail page:
   - Watch live event/log stream
   - Approve or reject when checkpoint appears
5. Run reaches terminal state:
   - `succeeded` if all steps complete
   - `failed` on step error or rejection

Run statuses:
- `queued`
- `running`
- `waiting_approval`
- `succeeded`
- `failed`

---

## API quick reference

Base URL: `http://127.0.0.1:4321/api`

- `GET /workflows`
- `GET /workflows/:id`
- `POST /workflows`
- `PUT /workflows/:id`
- `GET /runs`
- `GET /runs/:runId`
- `POST /runs`
- `GET /runs/:runId/events`
- `GET /runs/:runId/events/stream` (SSE)
- `POST /runs/:runId/approval`

Health:
- `GET /health`

---

## Testing

Run all tests:

```bash
pnpm test
```

Run lint/typecheck:

```bash
pnpm lint
```

Build all packages:

```bash
pnpm build
```

---

## Optional: Docker runtime

Run runtime in Docker:

```bash
docker compose -f infra/docker/docker-compose.yml up --build
```

Then point web/desktop to runtime at `http://127.0.0.1:4321`.

---

## Troubleshooting

### `Internal server error` with Prisma / `DATABASE_URL` missing
Ensure `apps/runtime/.env` exists and includes `DATABASE_URL`.

### Prompt step fails with `Claude Code process exited with code 1`
Usually Claude CLI/auth is not configured for the runtime user. Verify `claude` is installed and run `claude login`.

### Desktop build fails on Cargo/Rust
Install Rust toolchain and Tauri prerequisites, then re-run `pnpm dev:desktop`.
