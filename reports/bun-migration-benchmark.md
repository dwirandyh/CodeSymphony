# Bun Migration Benchmark

Date: 2026-05-23

## Scope

Compared the Bun migration branch at `/Users/dwirandyh/Work/Personal/codesymphony` against a `main` worktree at `/Users/dwirandyh/Work/Personal/codesymphony-main-benchmark`.

Measured:

- dependency install with warm caches (`install_noop`)
- runtime build from a cleaned build state
- web build from a cleaned build state
- desktop runtime bundle build from a cleaned build state

## Environment

- machine: local macOS arm64 workstation
- Bun: `1.3.14`
- pnpm: `10.5.0` via `/tmp/cs-bench-pnpm/node_modules/.bin/pnpm`
- benchmark note: for build timings, `dist/` and `tsconfig.tsbuildinfo` were removed before each run so the timings reflect actual rebuild work

## Commands

### Bun branch

- `bun install --no-progress`
- `bun run --filter @codesymphony/runtime build`
- `bun run --filter @codesymphony/web build`
- `bash apps/desktop/scripts/bundle-runtime.sh`

### Main worktree

- `pnpm install --frozen-lockfile`
- `pnpm --filter @codesymphony/runtime build`
- `pnpm --filter @codesymphony/web build`
- `bash apps/desktop/scripts/bundle-runtime.sh`

## Raw timings

| Branch | Benchmark | Run | Result | Elapsed |
| --- | --- | --- | --- | --- |
| bun | install_noop | 1 | success | 32 ms |
| bun | install_noop | 2 | success | 28 ms |
| bun | install_noop | 3 | success | 28 ms |
| main | install_noop | 1 | success | 588 ms |
| main | install_noop | 2 | success | 559 ms |
| main | install_noop | 3 | success | 555 ms |
| bun | runtime_build | 1 | success | 5671 ms |
| bun | runtime_build | 2 | success | 5523 ms |
| bun | runtime_build | 3 | success | 5550 ms |
| main | runtime_build | 1 | success | 6122 ms |
| main | runtime_build | 2 | success | 5245 ms |
| main | runtime_build | 3 | success | 5226 ms |
| bun | web_build | 1 | success | 15851 ms |
| bun | web_build | 2 | success | 15616 ms |
| bun | web_build | 3 | success | 15586 ms |
| main | web_build | 1 | failed | 9697 ms |
| main | web_build_bootstrapped | 1 | success | 16447 ms |
| main | web_build_bootstrapped | 2 | success | 16022 ms |
| main | web_build_bootstrapped | 3 | success | 16166 ms |
| bun | desktop_bundle_runtime | 1 | success | 33443 ms |
| main | desktop_bundle_runtime_bootstrapped | 1 | success | 47107 ms |

## Averages

| Benchmark | Bun avg | Main avg | Delta |
| --- | --- | --- | --- |
| install_noop | 29 ms | 567 ms | Bun faster by 538 ms, about 19.3x |
| runtime_build | 5581 ms | 5531 ms | main faster by 50 ms, about 0.9% |
| web_build | 15684 ms | 16212 ms | Bun faster by 527 ms, about 3.3% |
| desktop_bundle_runtime | 33443 ms | 47107 ms | Bun faster by 13664 ms, about 29.0% |

## Findings

1. Bun materially improves repeated install time. On this machine, the no-op install path was effectively instantaneous compared with pnpm's roughly half-second warm install.
2. Runtime build performance is effectively a wash. The difference was about 50 ms across ~5.5 s runs.
3. Bun is modestly faster for the web build and clearly faster for the desktop runtime bundle path.
4. The desktop path benefits the most from the migration because the branch now bundles and launches Bun directly instead of carrying the older Node-centric flow.

## Important caveats

1. `main` did not clean-build the web app on first attempt. The initial failure happened after `9697 ms` because:
   - `apps/web/src/routeTree.gen.ts` was missing in the clean worktree
   - `apps/web/src/lib/workspacePersistence.ts` imported `@standard-schema/spec`, but that dependency was not declared in `apps/web/package.json`
2. To get comparable web and desktop numbers for `main`, I bootstrapped only the benchmark worktree by:
   - adding `@standard-schema/spec`
   - populating `apps/web/src/routeTree.gen.ts`
3. `pnpm install --frozen-lockfile` on `main` emitted the pnpm 10 `Ignored build scripts` warning. I had already generated Prisma client state separately so runtime benchmarks could run.
4. These numbers are local-machine timings with warm caches. They are useful for relative comparison, not absolute CI guarantees.

## Migration verification status

- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`: passed
- clean `bun run --filter @codesymphony/runtime build`: passed
- clean `bun run --filter @codesymphony/web build`: passed
- desktop runtime bundle with Bun path: passed
- post-fix `bun run --filter @codesymphony/web test` on 2026-05-24: passed (`133` files, `1783` tests, `73.02s`, peak memory footprint `3392832 KB`)
- post-fix `bun run test` on 2026-05-24: passed (`7` tasks, wall time `1m18.214s`, peak memory footprint `2655296 KB`)
