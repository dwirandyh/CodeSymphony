# Dogfood Report: CodeSymphony Cursor CLI

| Field | Value |
|-------|-------|
| **Date** | 2026-04-24 |
| **App URL** | http://localhost:5173/?repoId=cmnzpvd7r0000m9ex7uw3yltq&worktreeId=cmnzpvd810002m9exnqzkfxan |
| **Session** | `cursor-cli-20260424-074931` |
| **Scope** | Cursor CLI integration verification against `docs/cli-agent-spec.md` |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Checklist Verification

- Clean Cursor thread works and refresh preserves session continuity.
  Evidence: `screenshots/cursor-smoke-thread.png`, `screenshots/cursor-followup-before-send.png`, `screenshots/cursor-smoke-after-refresh.png`
  Notes: thread `cmobk7l100009m9byk2c3eyf8` kept the same Cursor session across follow-up + refresh.

- Slash command discovery works from the UI while keeping `/skill` syntax.
  Evidence: `screenshots/cursor-slash-suggestions.png`, `screenshots/cursor-slash-suggestions-live.png`
  Notes: runtime slash catalog returned Cursor skills and the composer kept `/dogfood`, `/Excel`, and other `/skill` suggestions.

- Default permission mode honors deny and allow paths.
  Evidence: `screenshots/cursor-default-command-pending.png`, `screenshots/cursor-default-command-denied.png`, `screenshots/cursor-default-command-allow-prompt.png`, `screenshots/cursor-default-command-allowed.png`
  Notes: thread `cmoc7ltfe0001m9ss12kml5xg` showed approval UI, deny prevented file creation, and allow created `tmp-cursor-cmd-final.txt` with `cmd-default`.

- Fresh permission allow / reject flows work end-to-end in the current Cursor build.
  Evidence: `screenshots/cursor-permission-allow-full-before.png`, `screenshots/cursor-permission-allow-full-after.png`, `screenshots/cursor-permission-reject-full-before.png`, `screenshots/cursor-permission-reject-full-after.png`
  Notes: thread `cmocav63l0007m9k3mzsplkt8` showed the permission card, `Allow once`, and then created `tmp-cursor-permission-allow-full-20260424.txt` with `allow full`. Thread `cmocav64j0009m9k3py2yqjnb` showed the same permission gate, `Deny`, and left `tmp-cursor-permission-reject-full-20260424.txt` absent.

- Full Access mode runs mutations without approval prompts.
  Evidence: `screenshots/cursor-full-access-command-no-prompt.png`
  Notes: thread `cmobksrct000pm9uf0afe8r4s` created `tmp-cursor-full-access-2.txt` with `full-access-2` and no approval card appeared on the successful rerun.

- Plan mode persists after refresh and remains reviewable in the timeline.
  Evidence: `screenshots/cursor-plan-thread.png`, `screenshots/cursor-plan-before-refresh.png`, `screenshots/cursor-plan-after-refresh.png`
  Notes: thread `cmobksrct000rm9uf3cglqtse` preserved the plan response after reload. The persisted event stream contains canonical `plan.created` output for `/Users/dwirandyh/.cursor/plans/Create Plan Write Check-5ded775e.plan.md`.

- Cursor plan cards render with review controls in the web UI.
  Evidence: `screenshots/cursor-plan-card-full-before-revise.png`
  Notes: thread `cmocav5zi0001m9k3yi2vs7cn` showed the plan heading, `Choose accept plan`, `Choose revise plan`, `Dismiss plan decision`, and `Submit plan acceptance`.

- Revise plan now emits a fresh canonical plan and re-renders the updated plan card.
  Evidence: `screenshots/cursor-plan-revise-full-feedback-filled.png`, `screenshots/cursor-plan-revise-full-after.png`
  Notes: thread `cmocav5zi0001m9k3yi2vs7cn` accepted revision feedback for `tmp-cursor-plan-revise-b-full-20260424.txt`, and the UI re-rendered the refreshed plan card with the updated file target after the second `plan.created`.

- Accept plan executes successfully and clears the review gate.
  Evidence: `screenshots/cursor-plan-accept-full-before.png`, `screenshots/cursor-plan-accept-full-after.png`
  Notes: thread `cmocav60u0003m9k32re04urj` showed the plan card before approval, then executed the plan after `Submit plan acceptance`. The review controls disappeared and `tmp-cursor-plan-accept-full-20260424.txt` was created with `accept full.`.

- Dismiss plan removes the review controls while keeping the plan content in history.
  Evidence: `screenshots/cursor-plan-dismiss-full-before.png`, `screenshots/cursor-plan-dismiss-full-after.png`
  Notes: thread `cmocav62j0005m9k3i7eozrm9` emitted `plan.dismissed`, removed the review buttons from the UI, and returned the composer to normal plan-mode input while keeping the prior plan message visible in the timeline.

- Stop/abort preserves partial output instead of dropping the timeline.
  Evidence: `screenshots/cursor-abort-cancelled-thread.png`, `screenshots/cursor-abort-cancelled-thread-after-refresh.png`
  Notes: thread `cmoc81an7035lm9misoswlmcy` still showed partial assistant text after cancellation and after refresh. Backend events for the same thread ended with `chat.completed.cancelled = true`.

- Narrow/mobile viewport still renders Cursor session chrome and composer.
  Evidence: `screenshots/cursor-mobile-smoke.png`
  Notes: at `390x844`, the mobile layout still exposed session tabs, composer actions, repo drawer, and bottom navigation without breaking the Cursor thread view.

## Automated Checks

- Shared types: `pnpm --filter @codesymphony/shared-types test`
- Runtime targeted suite: `pnpm --filter @codesymphony/runtime exec vitest run test/chatService.permissions.test.ts test/cursor.sessionRunner.test.ts test/chatService.agent-selection.test.ts test/routes.chats.test.ts test/routes.models.test.ts test/cursor.persistence.test.ts test/cursor.sessionRunner.abort.test.ts`
- Cursor web targeted suite:
  - `pnpm --filter @codesymphony/web exec vitest run src/components/workspace/Composer.test.tsx -t Cursor`
  - `pnpm --filter @codesymphony/web exec vitest run src/components/workspace/SettingsDialog.test.tsx -t Cursor`
  - `pnpm --filter @codesymphony/web exec vitest run src/pages/workspace/eventUtils.test.ts src/pages/workspace/hooks/usePendingGates.test.tsx src/pages/workspace/hooks/useWorkspaceTimeline.test.tsx`
  - `pnpm --filter @codesymphony/web test -- src/lib/api.test.ts`
  - `pnpm --filter @codesymphony/web test -- src/lib/queryKeys.test.ts`
  - `pnpm --filter @codesymphony/web test -- src/pages/workspace/hooks/chat-session/useChatSession.render.test.tsx`
  - `pnpm --filter @codesymphony/web test -- src/pages/workspace/hooks/useSlashCommands.test.tsx`
- Timeline shared package: `pnpm --filter @codesymphony/chat-timeline-core exec vitest run src/timelineAssembler.test.ts`

## Issues

No open product issues were found in the final Cursor verification pass.
