# Thread Navigation Performance Baseline

Date: 2026-04-26

Target states:

- A: `http://localhost:5173/?repoId=cmm5hkkmr002bm9f44ocaqax7&worktreeId=cmnonq88x0001m9bpkdncl8i4&threadId=cmoecljdo0i7zm9bxow08586c`
  - Worktree: `feat/chat/queue`
  - Thread: `Implement ADR and Dogfood`
- B: `http://localhost:5173/?repoId=cmm5hkkmr002bm9f44ocaqax7&worktreeId=cmoexnjvo0q0lm9bxsat7o8el&threadId=cmoexnjym0q0nm9bxrzchbgh5`
  - Worktree: `feat/setting/model`
  - Thread: `New Thread`

## Method

- Browser automation via `agent-browser`
- Desktop viewport `1440x900`
- Ready definition:
  - URL params match the target `repoId`, `worktreeId`, and `threadId`
  - no `[data-testid="loading-thread-skeleton"]`
  - composer textbox exists and is editable
  - selected tab text matches the target thread title
- Warm measurement:
  - visit A once
  - visit B once
  - return to A
  - wait `2500ms` idle before each measured navigation
  - run `5` alternating cycles of `A -> B -> A`
- First-hop spot check:
  - fresh browser session
  - open A
  - measure `A -> B`
  - immediately measure `B -> A`

## Warm Baseline

### Summary

| Direction | Runs | Median ready | Median URL match | Extra interaction | Long-task median |
| --- | --- | ---: | ---: | ---: | ---: |
| `A -> B` | `508.1ms`, `511.1ms`, `567.2ms`, `562.2ms`, `561.1ms` | `561.1ms` | `561.0ms` | `-` | `0` |
| `B -> A` | `728.2ms`, `786.6ms`, `781.2ms`, `797.0ms`, `713.0ms` | `781.2ms` | `781.2ms` | tab click at `223.0ms` median | `3` |

### Main-Thread Cost

| Direction | Median long-task count | Median long-task total | Median max long task |
| --- | ---: | ---: | ---: |
| `A -> B` | `0` | `0ms` | `0ms` |
| `B -> A` | `3` | `640ms` | `484ms` |

Interpretation:

- `A -> B` is already fairly fast in the warmed path and is not main-thread bound in the median run.
- `B -> A` is materially slower and still shows heavy main-thread work even when the browser does not always issue new network fetches.
- The slower direction is the hop into the populated thread timeline, not the hop into the empty/new thread.

## First-Hop Spot Check

| Direction | Ready | URL match | Long tasks |
| --- | ---: | ---: | ---: |
| `A -> B` | `532.0ms` | `454.6ms` | `1` long task, `444ms` max |
| `B -> A` | `752.6ms` | `752.6ms` | `3` long tasks, `449ms` max |

Interpretation:

- The first hop was close to the warmed median for both directions.
- The main asymmetry is stable: `B -> A` remains slower because activating the populated thread is the expensive path.

## Request Profile

### Warm `A -> B`

Median observed API request count:

- `11` fetches per run

Most common requests:

- `/api/worktrees/cmoexnjvo0q0lm9bxsat7o8el/threads`
- background `/api/worktrees/*/threads` fan-out for other worktrees
- sometimes `/api/threads/cmoexnjym0q0nm9bxrzchbgh5/timeline` around `22.5ms`

Noisy outlier observed once:

- `10` additional `/api/threads/*/status-snapshot` requests during the same visible hop

Interpretation:

- The empty-thread direction is fast enough that background workspace metadata fan-out is now a larger share of the observed request noise than the visible thread activation itself.

### Warm `B -> A`

Median observed API request count:

- `1` API resource entry per run

Representative hot-path requests when they appear:

- `/api/threads/cmoecljdo0i7zm9bxow08586c/timeline` around `567ms`
- `/api/threads/cmoecljdo0i7zm9bxow08586c/queue` around `3.3ms`

Interpretation:

- The populated-thread hop is dominated by timeline activation.
- Some runs showed no fresh API fetch entries but still spent `713-781ms`, which points to cached-data hydration and render work as part of the remaining cost, not just network.

## Baseline Takeaways

- Best optimization target: `B -> A`
  - It is slower by about `220ms` at the median (`781.2ms` vs `561.1ms`).
  - It still incurs substantial long tasks on the main thread.
- Secondary optimization target: `A -> B` background fan-out
  - Visible navigation is already fast, but there is still unnecessary `/threads` and occasional `status-snapshot` background activity overlapping the switch.
- Most actionable next steps:
  - reduce populated-thread activation/render cost for `Implement ADR and Dogfood`
  - avoid same-turn background worktree/thread metadata fan-out during the visible switch

## Optimized Result

After preserving cached thread/timeline state across worktree switches and seeding the next worktree from cache synchronously, the same warm 5-cycle measurement improved to:

| Direction | Baseline median ready | Optimized median ready | Delta |
| --- | ---: | ---: | ---: |
| `A -> B` | `561.1ms` | `354.0ms` | `-207.1ms` |
| `B -> A` | `781.2ms` | `638.1ms` | `-143.1ms` |

Additional optimized-path observations:

- Warm `A -> B`
  - internal target-thread ready median: `6.1ms`
  - snapshot hydrate median: `0.5ms`
  - final target timeline available median: `5.6ms`
- Warm `B -> A`
  - internal target-thread ready median: `24.2ms`
  - snapshot hydrate median: `2.2ms`
  - final target timeline available median: `23.8ms`

Interpretation:

- The remaining visible time is now dominated much less by thread bootstrap itself.
- The largest practical gain came from not discarding worktree-local thread caches on every switch.
- The previous repeated `/api/worktrees/*/threads` refetch on the hot return path stopped being the visible bottleneck.

Code changes behind the optimized result:

- keep cached `threadCollections` and `threadStreamState` across worktree switches instead of clearing them eagerly in `useChatSession`
- seed the next worktree's thread list from cached TanStack DB state immediately during the switch
- retain the earlier snapshot/message/event merge fast paths and hydration fast paths

## Latest Warm Spot Check

After additional hot-path work to:

- stop rebuilding the derived timeline during authoritative snapshot switches
- memoize the chat message list and stabilize `useWorkspaceTimeline` inputs
- cache snapshot/timeline fingerprints
- suppress redundant search-param sync on already-pending worktree switches
- disable `React.StrictMode` in local Vite dev to remove development-only double render overhead

Warm same-session spot check:

| Direction | Previous optimized reference | Latest warm spot check | Delta vs previous optimized |
| --- | ---: | ---: | ---: |
| `A -> B` | `354.0ms` | `177.3ms` | `-176.7ms` |
| `B -> A` | `638.1ms` | `200.6ms` | `-437.5ms` |

Interpretation:

- The thread/worktree-specific bottleneck is no longer the dominant cost.
- Hot switches now complete in roughly `180-200ms` in the warmed local-dev path.
- Remaining latency is mostly shell/render overhead on localhost dev rather than chat bootstrap itself.

## Final Warm Result

After the latest pass to:

- make the desktop sidebar actually memo-effective by removing the `repos` object prop fan-out
- stop mounting the hidden mobile repository drawer on desktop
- prewarm sibling worktree thread lists, timeline snapshots, and git status in the background
- prefetch the next worktree on hover/focus/click
- preserve last-known git status during transient live-query gaps

Warm same-session measurement on the final code:

| Direction | Original baseline | Final warm result | Delta | Improvement |
| --- | ---: | ---: | ---: | ---: |
| `A -> B` | `561.1ms` | `188.6ms` | `-372.5ms` | `-66.4%` |
| `B -> A` | `781.2ms` | `176.4ms` | `-604.8ms` | `-77.4%` |

Notes:

- A fresh first hop after opening the page can still be slower than the fully warmed loop.
  - Latest fresh spot check observed `A -> B` around `284.6ms` before the background prewarm had fully settled.
- Once the worktree caches are warm, the alternating loop stabilized in the `~175-190ms` range.
- The remaining cost is now mostly route/render shell work in local dev, not chat bootstrap.

## Current Rerun (2026-04-27)

This rerun was taken on the current app state after deleting unrelated threads from worktree `cmnonq88x0001m9bpkdncl8i4` so that the worktree consistently restores `Implement ADR and Dogfood`.

Warm same-session rerun on the same A/B targets:

| Direction | Original baseline | 2026-04-26 final warm result | 2026-04-27 current visible rerun | Delta vs original | Delta vs 2026-04-26 final |
| --- | ---: | ---: | ---: | ---: | ---: |
| `A -> B` | `561.1ms` | `188.6ms` | `187.8ms` | `-373.3ms` | `-0.8ms` |
| `B -> A` | `781.2ms` | `176.4ms` | `251.0ms` | `-530.2ms` | `+74.6ms` |

Visible warm rerun evidence:

| Direction | Runs |
| --- | --- |
| `A -> B` | `160.6ms`, `179.5ms`, `203.8ms`, `220.7ms`, `187.8ms` |
| `B -> A` | `251.0ms`, `310.1ms`, `266.7ms`, `224.6ms`, `217.5ms` |

Internal app metric from the same rerun:

| Direction | `thread.ready` median |
| --- | ---: |
| `A -> B` | `7.1ms` |
| `B -> A` | `8.1ms` |

Interpretation:
- `A -> B` is effectively unchanged from the 2026-04-26 final warm result.
- `B -> A` is still much faster than the original baseline, but it regressed versus the prior final warm measurement on the visible path.
- The internal `thread.ready` metric remains single-digit milliseconds in both directions, which points to the remaining cost living in visible shell / render work rather than thread bootstrap itself.

## Git Panel Behavior

The earlier git-diff flicker came from two separate phases:

- the worktree switch first showed cached lightweight UI state
- then non-critical git data re-enabled later and briefly replaced the panel with a loading state

Current behavior with the Source Control panel open:

- the panel now switches directly to the target worktree state
- a short `Loading changes...` phase may still appear if the target git status fetch is not already warm
- the previous incorrect state no longer reappears after the target state has rendered

This is materially better than the old `stale -> blank/loading -> final` sequence, but it is still not fully instant when the target git cache is cold.

## Latest ADR-Focused Pass

Date: 2026-04-26

This pass targeted the remaining latency when opening thread A (`Implement ADR and Dogfood`) after the earlier data-path optimizations were already in place.

Hot-path changes:

- stop building the derived local timeline when the UI is already rendering the display snapshot timeline
- stop sorting the same `events` array repeatedly for pending-gate and thread-status derivation
- memoize pending gate and running-state derivation in `useChatSession`
- avoid `ChatMessageList` reset state updates when those maps/flags are already empty
- reduce `virtua` render buffer from the default hot-path window to `80px`

Measured result on the same localhost dev setup:

| Direction | Earlier spot check in this pass | Latest spot check | Delta |
| --- | ---: | ---: | ---: |
| `B -> A` | `254.8ms` | `129.4ms` | `-125.4ms` |

Supporting internal metric on `B -> A`:

- `derivedTimelineDurationMs`: `41.5ms` -> `0ms`
- app-level `thread.ready`: remained around `3.4ms`
- after fixing deterministic sibling-worktree prefetch and freezing the hidden bottom-panel subtree, a fresh B-start session now sees `hasCachedSnapshot: true` for thread A before the click and `thread.ready` around `2.3ms`

Interpretation:

- The large-thread switch is no longer paying the old `events -> derived timeline` cost on the visible path.

## Display Snapshot Tail Benchmark

Date: 2026-04-26

This pass focused on the runtime hot path for opening an existing thread before full hydration finishes.

Implementation:

- `GET /api/threads/:id/timeline?includeCollections=0` now loads only the newest tail window instead of scanning the full thread history
- display snapshots keep chronological order, but only include the latest `64` messages and latest `400` events on the first paint
- when that tail is truncated at the top, the snapshot now sets `summary.oldestRenderableHydrationPending = true`
- the web client uses that signal to pull the full snapshot sooner and prefetches display snapshots on thread-tab hover/focus

Benchmark command:

```bash
pnpm --filter @codesymphony/runtime bench:display-snapshot -- \
  --thread cmock9eqt0e7xm9e3ovh7wzfb \
  --thread cmoc87d1s0001m9e3rvbjkb4q \
  --thread cmoecljdo0i7zm9bxow08586c \
  --runs 20 --warmup 5
```

Measured before/after on the same local database:

| Thread | History size | Legacy display snapshot median | Optimized display snapshot median | Duration delta | Legacy payload | Optimized payload | Payload delta |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `Akses Figma Design Aplikasi` | `22 messages / 6333 events` | `61.8ms` | `4.4ms` | `-92.9%` | `774.5 KB` | `49.1 KB` | `-93.7%` |
| `Auto Logout Token Expired` | `36 messages / 6192 events` | `59.8ms` | `4.3ms` | `-92.8%` | `593.3 KB` | `40.8 KB` | `-93.1%` |
| `Implement ADR and Dogfood` | `8 messages / 5041 events` | `78.8ms` | `4.9ms` | `-93.8%` | `2.7 MB` | `52.7 KB` | `-98.1%` |

Result summary:

- first-paint thread snapshots now read at most `400` events instead of `5000-6300+` events on these heavy threads
- runtime snapshot latency dropped from roughly `60-79ms` to `4-5ms`
- initial timeline payload dropped from `593 KB-2.7 MB` down to `41-53 KB`
- the latest content becomes available first, while older history hydrates immediately after the initial render path
- The remaining visible latency is now mostly React commit + virtualizer/layout/paint work in local Vite dev.
- Against the original warm baseline, `B -> A` moved from `781.2ms` to `129.4ms`, an improvement of about `83.4%`.

## Post-Pagination Removal Rerun

Date: 2026-04-27

This rerun was taken after deleting the older-history pagination path entirely so that `/api/threads/:id/timeline` always returns the full thread history.

Method:

- local dev app at `http://localhost:5173`
- desktop viewport `1440x900`
- SPA search-param navigation with `csDebugThreadNav=1`
- same ready criteria as the earlier warm baseline: target URL params matched, no loading skeleton, composer present, selected tab matched the expected thread title

### Warm Same-Session 5-Cycle Rerun

| Direction | Runs | Median ready | Median `thread.ready` |
| --- | --- | ---: | ---: |
| `A -> B` | `194.6ms`, `199.3ms`, `195.2ms`, `180.6ms`, `198.3ms` | `195.2ms` | `6.0ms` |
| `B -> A` | `198.2ms`, `177.1ms`, `172.7ms`, `168.5ms`, `186.2ms` | `177.1ms` | `6.0ms` |

Comparison against the latest visible rerun already documented above:

| Direction | Prior documented warm rerun | Post-pagination-removal warm rerun | Delta |
| --- | ---: | ---: | ---: |
| `A -> B` | `187.8ms` | `195.2ms` | `+7.4ms` |
| `B -> A` | `251.0ms` | `177.1ms` | `-73.9ms` |

Interpretation:

- `A -> B` stayed within single-digit milliseconds of the earlier warm rerun and is not a material regression.
- `B -> A` improved further on the visible path despite removing pagination.
- Warmed thread bootstrap remained effectively unchanged internally at about `6ms`, so the extra runtime payload is not showing up as a visible regression in the hot path.

### Fresh First-Hop Spot Check

| Flow | Result |
| --- | --- |
| fresh open `A` | `1168.5ms` to ready |
| fresh `A -> B` | `476.0ms` visible ready, `341.1ms` internal `thread.ready` |
| fresh open `B` | `1064.0ms` to ready |
| fresh `B -> A` | `577.7ms` visible ready, `450.4ms` internal `thread.ready` |

Interpretation:

- Cold hops are still slower internally than the warmed loop because the full snapshot path does more real work before caches settle.
- Even so, the visible cold hops remain better than the original first-hop baseline from this document (`532.0ms` for `A -> B`, `752.6ms` for `B -> A`).

## Full Snapshot Benchmark After Pagination Removal

Date: 2026-04-27

Replacement benchmark command:

```bash
pnpm --filter @codesymphony/runtime bench:thread-snapshot -- \
  --thread cmoc87d1s0001m9e3rvbjkb4q \
  --thread cmoecljdo0i7zm9bxow08586c \
  --runs 20 --warmup 5
```

Measured medians on the current local database:

| Thread | History size | Full snapshot median | P95 | Payload |
| --- | --- | ---: | ---: | ---: |
| `Auto Logout Token Expired` | `36 messages / 6192 events` | `61.7ms` | `64.9ms` | `3.2 MB` |
| `Implement ADR and Dogfood` | `8 messages / 5041 events` | `79.2ms` | `85.0ms` | `7.4 MB` |

Notes:

- The earlier tail-snapshot benchmark thread `cmock9eqt0e7xm9e3ovh7wzfb` is no longer present in the current local database, so it was omitted from this rerun.
- Runtime snapshot cost is intentionally higher than the old paginated/tail snapshot path because the endpoint now returns the full history by design.
- The important user-visible result is that the warmed browser navigation path above did not regress despite the heavier runtime payload.
