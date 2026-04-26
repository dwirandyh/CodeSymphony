# Workspace Performance Baseline

Date: 2026-04-26

Target URL:
`http://localhost:5173/?repoId=cmm5hkkmr002bm9f44ocaqax7&worktreeId=cmnonq88x0001m9bpkdncl8i4`

Measured state:
- Local dev server on `localhost:5173`
- Active thread: `Implement ADR and Dogfood`
- Right panel: `Explorer` opened
- Viewport observed during scroll capture: `1280x577`

## Summary Comparison

### Startup To Conversation Ready

| Metric | Original baseline | Earlier optimized | Latest optimized | Change vs original |
| --- | ---: | ---: | ---: | ---: |
| Conversation-ready median | `5814ms` | `3829ms` | `3431ms` | `-2383ms` |
| Improvement | `-` | `-1985ms` | `-2383ms` | `40.99% faster` |

Notes:
- `Earlier optimized` is the first chat-bootstrap optimization pass.
- `Latest optimized` is the current `New Thread` startup path after removing eager file-index and empty-thread remote bootstrap work.
- Latest fresh runs: `3282ms`, `3431ms`, `4470ms`.

### Timeline Scroll

| Metric | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| Average FPS | `17.6` | `58.75` | `+41.15` |
| Average frame gap | `56.92ms` | `17.02ms` | `-39.90ms` |
| P95 frame gap | `258.4ms` | `16.8ms` | `-241.6ms` |
| Frames over `33.3ms` | `14` | `2` | `-12` |
| Frames over `50ms` | `14` | `0` | `-14` |
| Long task count | `54` | `32` | `-22` |
| Total long-task time | `8234ms` | `3729ms` | `-4505ms` |

### Startup Request Profile

| Request / work | Before | Now |
| --- | --- | --- |
| `/api/worktrees/:id/files/index` | eager on startup | on-demand only |
| `/api/threads/:id/queue` for empty new thread | eager on startup | removed from startup |
| `/api/threads/:id/timeline` for empty new thread | eager on startup | removed from startup |
| `/api/threads/:id/events/stream` for empty new thread | eager on startup | removed from startup |
| background inactive-thread snapshots | multi-MB `/snapshot` payloads | tiny `/status-snapshot` payloads |

## Method

- Load metrics: Lighthouse desktop, `3` runs, `--throttling-method=provided`
- Scroll metrics: synthetic continuous scroll against the actual timeline container and Explorer container while the page was `visible` and `focused`
- Focus area: timeline scrolling smoothness, jank, frame pacing, long tasks, and main-thread cost

## Load Baseline

Median across 3 Lighthouse runs:

| Metric | Value |
| --- | ---: |
| Performance score | `69` |
| FCP | `1.37s` |
| LCP | `1.37s` |
| Speed Index | `1.59s` |
| TBT | `494ms` |
| TTI | `4.47s` |
| CLS | `0.003` |
| Main-thread work | `2.64s` |
| Bootup time | `1.64s` |
| Render-blocking resources | `89ms` |
| DOM size | `541` nodes |

Per-run summary:

| Run | Score | FCP | LCP | Speed Index | TBT | TTI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `65` | `1665ms` | `1665ms` | `1939ms` | `466ms` | `4473ms` |
| 2 | `69` | `1360ms` | `1360ms` | `1531ms` | `512ms` | `7984ms` |
| 3 | `69` | `1373ms` | `1373ms` | `1590ms` | `494ms` | `4199ms` |

## Scroll Baseline

### Main Timeline

Median across 3 runs:

| Metric | Value |
| --- | ---: |
| Average FPS | `17.6` |
| Average frame gap | `56.92ms` |
| P95 frame gap | `258.4ms` |
| P99 frame gap | `400.1ms` |
| Max frame gap | `400.1ms` |
| Frames over `16.7ms` | `21` |
| Frames over `33.3ms` | `14` |
| Frames over `50ms` | `14` |
| Long task count | `54` |
| Total long-task time | `8234ms` |
| Max long task | `501ms` |
| Script duration delta | `3.154s` |
| Layout duration delta | `0.006s` |

Interpretation:
- Primary bottleneck is script work in the timeline container.
- Layout and style recalculation cost are comparatively small.
- Scroll jank is severe enough to be visible as lag/stutter.

### Explorer Panel

Median across 3 runs:

| Metric | Value |
| --- | ---: |
| Average FPS | `60.3` |
| Average frame gap | `16.58ms` |
| P95 frame gap | `16.7ms` |
| P99 frame gap | `16.8ms` |
| Max frame gap | `16.8ms` |
| Frames over `33.3ms` | `0` |
| Script duration delta | `0.021s` |
| Layout duration delta | `0s` |

Interpretation:
- Explorer scrolling is effectively smooth.
- The performance problem is localized to the main timeline content, not the workspace shell.

## Initial Findings

- The dominant hotspot is the central chat timeline.
- Script work is much heavier than layout work during timeline scroll.
- The most likely optimization targets are heavy collapsed cards in the timeline, especially diff/output-heavy rows that still incur render and parse cost even before expansion.

## Optimization Applied

- Heavy collapsed timeline cards now lazy-mount their bodies instead of rendering diff/tool/subagent/explore content up front.
- Assistant render-debug signature work now runs only when render-debug is explicitly enabled.
- Controlled `details` rows were fixed so expand/collapse still works after the performance refactor.

Files changed:
- `apps/web/src/components/workspace/chat-message-list/TimelineItem.tsx`
- `apps/web/src/components/workspace/chat-message-list/ChatMessageList.tsx`
- `apps/web/src/components/workspace/ChatMessageList.render.test.tsx`
- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.ts`
- `apps/web/src/components/workspace/composer/Composer.tsx`
- `apps/web/src/pages/WorkspacePage.tsx`
- `apps/web/src/pages/workspace/WorkspaceSidebar.tsx`
- `apps/web/src/components/workspace/RepositoryPanel.tsx`
- `apps/web/src/pages/workspace/hooks/chat-session/useChatSession.render.test.tsx`
- `apps/runtime/src/routes/chats.ts`
- `apps/runtime/src/services/chat/chatService.ts`
- `apps/runtime/src/services/chat/chatThreadStatus.ts`
- `apps/web/src/hooks/queries/useWorktreeStatuses.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/pages/workspace/hooks/useBackgroundWorktreeStatusStream.ts`
- `apps/web/src/pages/workspace/hooks/worktreeThreadStatus.ts`
- `packages/shared-types/src/workflow.ts`

## Post-Optimization Validation

Manual browser validation on the same thread:
- `Edited Composer.tsx +85 -20` expands correctly and mounts the diff body on demand.
- `Ran pnpm --filter @codesymphony/web lint for 6s` expands correctly and reveals tool output.

Automated validation:
- `pnpm --filter @codesymphony/web exec vitest run src/components/workspace/ChatMessageList.render.test.tsx src/pages/workspace/hooks/chat-session/useChatSession.render.test.tsx`
- `pnpm --filter @codesymphony/web lint`

## Scroll Re-Measurement After Optimization

Targeted container:
- `[data-testid="chat-scroll"] > div` (the actual inner `virtua` scroller)

Median across 3 runs:

| Metric | Baseline | After | Change |
| --- | ---: | ---: | ---: |
| Average FPS | `17.6` | `58.75` | `+41.15` |
| Average frame gap | `56.92ms` | `17.02ms` | `-39.90ms` |
| P95 frame gap | `258.4ms` | `16.8ms` | `-241.6ms` |
| P99 frame gap | `400.1ms` | `33.4ms` | `-366.7ms` |
| Max frame gap | `400.1ms` | `50.0ms` | `-350.1ms` |
| Frames over `33.3ms` | `14` | `2` | `-12` |
| Frames over `50ms` | `14` | `0` | `-14` |
| Long task count | `54` | `32` | `-22` |
| Total long-task time | `8234ms` | `3729ms` | `-4505ms` |
| Max long task | `501ms` | `386ms` | `-115ms` |

Per-run post-optimization summary:

| Run | Average FPS | Average frame gap | P95 gap | Frames over `33.3ms` | Long task count |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `58.54` | `17.08ms` | `16.7ms` | `2` | `32` |
| 2 | `58.75` | `17.02ms` | `16.8ms` | `2` | `32` |
| 3 | `58.75` | `17.02ms` | `16.7ms` | `1` | `32` |

Interpretation:
- The original user-visible lag in the main timeline is no longer the dominant problem.
- Frame pacing is now close to steady 60 FPS in the optimized path.
- The improvement comes from removing collapsed-card render/parse work from the hot scroll path rather than from layout changes.

## Load Re-Check Note

- Additional Lighthouse runs on the live Vite dev server were noisy and not suitable as acceptance metrics after this change.
- The workspace keeps active SSE/HMR traffic, so dev-mode Lighthouse scores were unstable and did not track the user-facing scroll improvement reliably.
- For future load regression tracking, use a production-style build or a quieter runtime profile.

## Conversation Readiness

Definition used for this pass:
- The loading skeleton is gone
- Timeline content for the selected thread is rendered
- The composer is editable and ready for the next user message

Baseline before this pass:
- Spot measurement: `5814ms` from navigation start to conversation-ready
- Dominant behavior: the selected thread timeline was blocked behind extra bootstrap work while non-critical workspace queries also started early

What changed:
- Seed the requested thread earlier during worktree bootstrap
- Avoid clearing URL thread selection while the requested thread is still bootstrapping
- Accept authoritative server timeline data during bootstrap when the snapshot already contains canonical messages/events
- Defer non-critical sidebar, background status, review, branch, and open-in-app work until after the chat path is ready

Confirmed post-optimization runs:

| Run | Conversation-ready time |
| --- | ---: |
| 1 | `3670ms` |
| 2 | `3829ms` |
| 3 | `4044ms` |

Median:
- `3829ms`

Before/after:

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Conversation-ready time | `5814ms` | `3829ms` | `-1985ms` |

Latest request profile before readiness:
- Still expected: `/api/model-providers`, `/api/repositories`, `/api/opencode/models`, `/api/debug/runtime-info`, `/api/threads/:id/queue`, `/api/threads/:id/timeline`
- Reduced non-critical work before readiness to a small remainder instead of the earlier flood of cross-worktree thread/diff/review requests
- The main remaining bottleneck is now the selected thread timeline request itself, not broad workspace chrome initialization

## Background Metadata Optimization

What changed in the latest pass:
- Replaced sidebar/background worktree-status fetches from full `/api/threads/:id/snapshot` payloads to lightweight `/api/threads/:id/status-snapshot` payloads
- The new status endpoint returns only the derived status plus newest event index, which is enough for worktree badges and background SSE resume cursors

Observed effect:
- Before this pass, background metadata could trigger multiple full thread snapshots with payloads in the multi-megabyte range for inactive threads
- After this pass, those requests are now `status-snapshot` calls with `content-length` around `42-43` bytes each in the same flow
- This removes a large amount of background serialization and client parse work even after the chat path is already interactive

Current-state spot checks:
- These runs were taken after the status-snapshot optimization on the current app behavior where the URL opens into a ready-to-use `New Thread` state

| Run | Conversation-ready time |
| --- | ---: |
| 1 | `3345ms` |
| 2 | `3393ms` |
| 3 | `3332ms` |

Median:
- `3345ms`

Notes:
- These spot checks are useful as a current sanity check, but they are not a strict apples-to-apples replacement for the earlier selected-thread median because the workspace now lands in a `New Thread` ready state for this URL
- The new spot checks confirmed that the heavy background `/snapshot` burst is gone and replaced by lightweight `/status-snapshot` requests

## Further Startup Grinding

What changed in this pass:
- The composer file index is now loaded on demand when `@mention` is actually used, instead of loading during initial chat readiness.
- The workspace-wide file index is now only requested when file-specific UI is used, such as the file view, mobile Files sheet, or quick file picker.
- A freshly auto-created empty `New Thread` no longer bootstraps remote queue, timeline snapshot, or thread SSE until the thread actually gains local activity.
- Non-critical workspace data resumes via `requestIdleCallback` when available, instead of always resuming on a fixed timer.

Observed startup request-profile change for the empty `New Thread` path:
- Removed from startup: `/api/worktrees/:id/files/index`
- Removed from startup: `/api/threads/:id/queue`
- Removed from startup: `/api/threads/:id/timeline`
- Removed from startup: `/api/threads/:id/events/stream`
- Still expected on startup: `/api/model-providers`, `/api/repositories`, `/api/cursor/models`, `/api/opencode/models`, `/api/debug/runtime-info`, `POST /api/worktrees/:id/threads`
- Manual browser validation confirmed that typing `@` in the composer immediately triggers `/api/worktrees/:id/files/index` on demand, preserving file-mention behavior.

Fresh-session readiness runs after this pass on the live Vite dev server:

| Run | Conversation-ready time |
| --- | ---: |
| 1 | `3282ms` |
| 2 | `3431ms` |
| 3 | `4470ms` |

Median:
- `3431ms`

Additional noisy spot checks on the same dev server:
- `3596ms`
- `4087ms`

Interpretation:
- The final dev-mode timings are still noisy because the localhost Vite workflow keeps HMR and SSE traffic alive, but the startup request footprint is materially smaller than before this pass.
- The strongest confirmed improvement in this pass is not just the median timing but the removal of heavyweight startup work that previously happened before the user typed anything.
- Relative to the original `5814ms` readiness baseline, the current startup path is still substantially faster while doing less unnecessary work before the composer is usable.

## Post-Simplifier Sanity Check

Purpose:
- Confirm the behavior-preserving simplification pass did not reintroduce startup regressions.

Fresh-session readiness runs after the simplifier pass:

| Run | Conversation-ready time |
| --- | ---: |
| 1 | `3292ms` |
| 2 | `3366ms` |
| 3 | `3685ms` |

Median:
- `3366ms`

Comparison to the latest pre-simplifier median:

| Metric | Pre-simplifier | Post-simplifier | Change |
| --- | ---: | ---: | ---: |
| Conversation-ready median | `3431ms` | `3366ms` | `-65ms` |

Startup request profile remained aligned with the optimized path:
- Still absent from startup: `/api/worktrees/:id/files/index`
- Still absent from startup: `/api/threads/:id/queue` for empty `New Thread`
- Still absent from startup: `/api/threads/:id/timeline` for empty `New Thread`
- Still absent from startup: `/api/threads/:id/events/stream` for empty `New Thread`
- Still present as the main remaining startup-specific thread cost: `POST /api/worktrees/:id/threads`

Interpretation:
- No startup regression was observed after the simplification pass.
- The post-simplifier median is effectively flat relative to the already-optimized path and remains far below the original `5814ms` baseline.

## Temporary Artifacts

- `/tmp/codesymphony-lh-1.json`
- `/tmp/codesymphony-lh-2.json`
- `/tmp/codesymphony-lh-3.json`
- `/tmp/codesymphony-baseline-full.png`
- `/tmp/codesymphony-lh-after-1.json`
- `/tmp/codesymphony-lh-after-2.json`
- `/tmp/codesymphony-lh-after-3.json`
