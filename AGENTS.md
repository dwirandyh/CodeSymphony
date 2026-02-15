# Repository Guidelines

## Project Structure & Module Organization
- `apps/runtime`: Fastify + Prisma runtime API (SQLite, SSE, approval/run routes).
- `apps/web`: React + Vite frontend (`src/pages`, `src/lib`, `src/styles.css`).
- `apps/desktop`: Tauri desktop shell (`src-tauri` for Rust config/entrypoint).
- `packages/shared-types`: shared TypeScript types/schemas used across apps.
- `packages/orchestrator-core`: deterministic orchestration/state-machine logic.
- `infra/docker`: optional Docker assets for runtime-only local deployment.

## Build, Test, and Development Commands
- `pnpm install`: install workspace dependencies.
- `pnpm dev`: run runtime + web together via Turbo.
- `pnpm dev:runtime` / `pnpm dev:web` / `pnpm dev:desktop`: run a single app.
- `pnpm build`: build all workspaces.
- `pnpm test`: run all tests across the monorepo.
- `pnpm lint`: run typecheck-based lint tasks across workspaces.
- `pnpm db:generate && pnpm db:migrate && pnpm db:seed`: initialize runtime database.

## Coding Style & Naming Conventions
- Language: TypeScript-first across apps/packages; keep modules ESM.
- Formatting observed in repo: 2-space indentation, semicolons, double quotes.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, kebab/feature naming for files (for example `runService.ts`, `WorkflowsPage.tsx`).
- Keep shared contracts in `packages/shared-types`; avoid duplicating API types in apps.

## Testing Guidelines
- Framework: Vitest (`apps/runtime`, `apps/web`, `packages/*`).
- Test file naming: `*.test.ts` / `*.test.tsx`.
- Typical locations:
  - runtime/integration-style tests in `apps/runtime/test`
  - package/unit tests in each package `test` folder
  - component/page tests alongside frontend code
- Run targeted tests with filters, for example: `pnpm --filter @codesymphony/runtime test`.

## Commit & Pull Request Guidelines
- Repository currently has no commit history on `master`, so no legacy pattern exists yet.
- Use Conventional Commits going forward (for example `feat(runtime): add approval retry`).
- Keep commits scoped to one logical change and include related tests.
- PRs should include:
  - concise summary and rationale
  - linked issue/task (if available)
  - test evidence (commands run)
  - screenshots/GIFs for UI changes in `apps/web` or desktop flows

## Security & Configuration Tips
- Copy `apps/runtime/.env.example` to `.env`; never commit secrets.
- Ensure Claude CLI auth is configured locally (`claude login`) before testing prompt steps.
- Use local SQLite paths (`file:./dev.db` / `file:./test.db`) as defined by scripts.
