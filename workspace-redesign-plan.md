# Full shadcn Migration + Workspace/Worktree List Redesign

## Summary
- Migrate `apps/web` from custom global CSS styling to a real shadcn stack (Tailwind CSS + Radix primitives + `class-variance-authority`).
- Redesign workspace/worktree lists with a compact explorer UI and multi-expand behavior.
- Preserve current product behavior for attach, worktree actions, threads, chat, and tool logs.

## Context
- Current app has shadcn-style component names (`Button`, `Card`, etc.) but is not a real Tailwind/shadcn setup.
- Styling is mostly centralized in `apps/web/src/styles.css`.

## Goals
- Replace manual CSS-driven component styling with shadcn/Tailwind patterns across the whole web app in one PR.
- Redesign sidebar lists:
  - Workspace header: `Workspace (N)` with right-aligned attach `+`.
  - Worktree list: compact, scannable rows, multi-expand repositories.
- Preserve current product behavior:
  - Attach repository (picker first, fallback manual path for unsupported environments).
  - Create/delete/select worktrees.
  - Existing thread/chat/log flows.

## Scope
- In scope:
  - `apps/web` UI stack migration and component refactor.
  - Global stylesheet removal/reduction to Tailwind base tokens.
  - Workspace/worktree visual redesign with interaction parity.
- Out of scope:
  - Runtime API behavior changes.
  - Desktop/runtime picker backend changes.
  - Non-web apps (`apps/runtime`, `apps/desktop`) except compile compatibility.

## Interfaces and API Impact
- No HTTP API changes.
- Internal UI interface updates:
  - `RepositoryPanel` remains callback-driven.
  - Existing callback signatures are preserved unless strict type cleanup is required.
- Build/tooling additions in `apps/web`:
  - Tailwind config + PostCSS config.
  - shadcn component conventions and utility tokens.
  - Dependencies: `tailwindcss`, `postcss`, `autoprefixer`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and needed Radix packages.

## Implementation Plan
1. Set up real shadcn foundation in `apps/web`:
   - Add Tailwind + PostCSS tooling and config.
   - Define tokenized theme variables in Tailwind-compatible base layer.
   - Align `cn` helper with `clsx` + `tailwind-merge`.
   - Convert UI primitives in `apps/web/src/components/ui/*` to shadcn-compatible implementations.
2. Migrate app shell layout away from `styles.css`:
   - Refactor `WorkspacePage` layout to utility classes.
   - Preserve responsive behavior (single column mobile, 2/3-column desktop).
   - Remove matching legacy selectors from `apps/web/src/styles.css`.
3. Redesign workspace/worktree lists in `RepositoryPanel`:
   - Header: `Workspace (N)` + right-aligned attach `+`.
   - Repository rows: chevron + repo name + active count + add-worktree action.
   - Expanded worktree section: indented list, selected highlight, compact delete action.
   - Keep multi-expand behavior.
4. Migrate remaining workspace components:
   - `WorkspaceHeader`, `Composer`, `ChatMessageList`, `ToolLogsPanel`, `ActivityTabs`.
   - Replace global class dependencies with utility classes and shadcn primitives.
   - Keep functionality unchanged.
5. Remove legacy CSS debt:
   - Delete obsolete selectors from `apps/web/src/styles.css`.
   - Keep only minimal global reset and theme variables if needed.
   - Validate no dead class usage remains.
6. Validate and stabilize:
   - Update tests for labels/accessibility changes.
   - Add coverage for redesigned list behavior.
   - Run `pnpm --filter @codesymphony/web test`, `pnpm --filter @codesymphony/web lint`, and `pnpm --filter @codesymphony/web build`.

## UX and Behavior Spec
- Visual style: clean compact explorer.
- Interaction model: multi-expand repositories.
- Attach flow:
  - Click/tap workspace attach `+`.
  - Try runtime picker API first.
  - On failure/unavailable, fallback to manual path prompt.
  - On valid path, attach immediately.
- Counter semantics: `Workspace (N)` uses repository count.

## Edge Cases
- Picker unsupported (mobile/docker/linux runtime): show manual path fallback.
- Prompt canceled/blank: no-op.
- Invalid path/non-git path: surface existing backend error inline.
- Duplicate repository path: surface existing backend validation error.
- Large repository lists: keep scrolling and truncation stable.

## Test Cases and Scenarios
- Renders `Workspace (N)` correctly.
- Attach button triggers picker-first flow.
- Picker failure triggers manual prompt fallback.
- Empty/canceled prompt does not call repository create API.
- Repository expand/collapse supports multi-expand.
- Worktree select/create/delete calls correct APIs.
- Existing thread/chat/log flows remain functional after migration.

## Acceptance Criteria
- Web app runs with real Tailwind/shadcn pipeline.
- Core workspace UI no longer depends on legacy manual class map.
- Workspace/worktree lists match compact explorer design.
- Existing user flows continue to work without API changes.
- Mobile access remains usable via attach fallback.

## Assumptions and Defaults
- Stack direction: full shadcn migration.
- Migration scope: entire web app in one PR.
- List style: clean compact explorer.
- Interaction model: multi-expand repositories.
- Runtime API contracts and attach fallback semantics remain unchanged.
