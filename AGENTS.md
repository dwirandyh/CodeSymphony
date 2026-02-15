# Repository Guidelines

## Project Structure & Module Organization
- `apps/runtime`: Fastify runtime API (Prisma + SQLite + Claude SDK integration).
- `apps/web`: React + Vite client with repository/worktree sidebar and chat panel.
- `apps/desktop`: Tauri shell for desktop packaging.
- `packages/shared-types`: shared Zod schemas and TypeScript DTOs for API contracts.
- `packages/orchestrator-core`: standalone utility package; not required by runtime flow.

## Build, Test, and Development Commands
- `pnpm install`: install all workspace dependencies.
- `pnpm dev`: start runtime + web together.
- `pnpm dev:runtime`, `pnpm dev:web`, `pnpm dev:desktop`: run a single app.
- `pnpm db:generate && pnpm db:migrate && pnpm db:seed`: initialize Prisma schema.
- `pnpm build`: compile all workspace packages/apps.
- `pnpm test`: run Vitest suites across workspaces.
- `pnpm lint`: run TypeScript typecheck-based lint tasks.

## Coding Style & Naming Conventions
- TypeScript + ESM throughout; prefer explicit types at API boundaries.
- Formatting in repo: 2-space indentation, semicolons, double quotes.
- Naming: `camelCase` for functions/variables, `PascalCase` for React components/types.
- Keep HTTP payload schemas in `packages/shared-types` and consume them in runtime routes.

## Testing Guidelines
- Framework: Vitest for runtime, web, and packages.
- Test naming: `*.test.ts` / `*.test.tsx`.
- Place runtime tests in `apps/runtime/test`, UI tests in `apps/web/src/**`, package tests in `packages/*/test`.
- Run targeted suite example: `pnpm --filter @codesymphony/runtime test`.

## Commit & Pull Request Guidelines
- Use Conventional Commits (example: `feat(runtime): add worktree create endpoint`).
- Keep commits focused to one logical change with corresponding tests.
- PRs should include summary, linked issue/task, commands run, and UI screenshots for frontend changes.

## Security & Configuration Tips
- Copy `apps/runtime/.env.example` to `.env`; never commit secrets.
- Ensure `claude login` is done for the same user running runtime.
- `WORKTREE_ROOT` controls where app-managed git worktrees are created.
