# Polling Audit

Date: 2026-05-18

Scope:
- Audit ini fokus ke request API dari client `apps/web` yang dipicu berkala oleh `refetchInterval` atau `setInterval`.
- Timer server-side seperti scheduler automation atau SSE keepalive tidak dihitung sebagai "API polling client".
- Path `../supersetsh` tidak ada di sibling workspace saat audit dijalankan; perbandingan dilakukan terhadap `../superset`.

## Ringkasan

Saat ini `codesymphony` punya tiga pola live-update:
- Push/event-driven untuk chat dan workspace-wide invalidation via SSE.
- Push-first untuk automations dan worktree git/file state, dengan fallback polling lambat.
- Polling berkala untuk snapshot/telemetry atau area yang memang belum punya event source.

Pola yang paling mahal saat ini:
- Android clipboard polling setiap 250 ms.
- Resource monitor polling setiap 2 s saat popover dibuka.

Pola yang paling layak dipertimbangkan untuk diubah:
- Android clipboard, jika transport viewer nanti bisa mengirim clipboard change dengan andal.
- Repository branches/reviews, jika nanti ada event source yang lebih spesifik untuk perubahan branch/review metadata.

## Status Setelah Implementasi

Per 2026-05-18, hasil implementasi audit ini:
- Automation sekarang emit event SSE spesifik: `automation.created`, `automation.updated`, `automation.deleted`, `automation.run.updated`.
- `useWorkspaceSyncStream()` sekarang meng-invalidate cache automation langsung dari event tersebut, jadi polling automation turun menjadi fallback: list/detail `60 s`, runs `30 s`, versions `5 m`.
- Runtime sekarang punya `worktreeWatchService` yang mengawasi root worktree dan `.git`, lalu emit `worktree.files.updated` dan `worktree.git.updated`.
- Saat watcher mendeteksi perubahan eksternal, runtime juga meng-invalidate cache git/file internal lebih dulu supaya refetch berikutnya tidak terkena data stale.
- Client sekarang refresh `git status`, `git diff`, `branch diff summary`, `file index`, `file tree`, dan `slash commands` dari event granular itu. Polling area worktree turun menjadi fallback: `git status 60 s`, `branch diff summary 60 s`, `file index 5 m`, `slash commands 5 m`.

## Inventory Polling Di `codesymphony`

### 1. High-frequency polling

| Area | Caller | Endpoint | Interval | Catatan |
| --- | --- | --- | --- | --- |
| Automations list | `apps/web/src/pages/automations/AutomationsPage.tsx` | `GET /automations` | 60 s fallback | Primary refresh sekarang lewat workspace SSE automation events. |
| Automation detail | `apps/web/src/pages/automations/AutomationsPage.tsx` | `GET /automations/:id` | 60 s fallback | Detail status sekarang push-first via SSE. |
| Automation runs | `apps/web/src/pages/automations/AutomationsPage.tsx` | `GET /automations/:id/runs` | 30 s fallback | Run aktif/baru selesai sekarang di-refresh dari `automation.run.updated`. |
| Automation versions | `apps/web/src/pages/automations/AutomationsPage.tsx` | `GET /automations/:id/versions` | 5 m fallback | Histori version tetap punya safety net, tapi bukan jalur utama lagi. |
| Resource monitor | `apps/web/src/components/workspace/ResourceMonitor.tsx` | `GET /resource-monitor/snapshot` | 2 s saat panel terbuka, 15 s saat tertutup | Wajar sebagai snapshot metrik, tapi tetap salah satu polling terpadat. |
| Android clipboard autosync | `apps/web/src/components/workspace/AndroidDeviceViewer.tsx` | `GET /device-streams/:sessionId/android/clipboard` | 250 ms | Ini fallback karena transport viewer lama belum push clipboard change dengan andal. |

### 2. Workspace-state safety-net polling

| Area | Caller | Endpoint | Interval | Catatan |
| --- | --- | --- | --- | --- |
| Git status | `apps/web/src/collections/gitStatus.ts` | `GET /worktrees/:id/git/status` | 60 s fallback | Primary refresh sekarang dari `worktree.git.updated` / `worktree.files.updated`. |
| File index | `apps/web/src/collections/fileIndex.ts` | `GET /worktrees/:id/files/index` | 5 m fallback | Primary refresh sekarang dari `worktree.files.updated`. |
| Slash commands | `apps/web/src/hooks/queries/useSlashCommandsQuery.ts` | `GET /worktrees/:id/slash-commands?agent=...` | 5 m fallback | Di-invalidate dari `worktree.files.updated` karena perubahan skill/command file biasanya ikut lewat jalur ini. |
| Git branch diff summary | `apps/web/src/hooks/queries/useGitBranchDiffSummary.ts` | `GET /worktrees/:id/git/branch-diff-summary` | 60 s fallback | Di-invalidate dari `worktree.git.updated` / `worktree.files.updated`. |
| Repository reviews | `apps/web/src/hooks/queries/useRepositoryReviews.ts` | `GET /repositories/:id/reviews` | 30 s | Sudah di-invalidate oleh workspace/thread streams pada event tertentu. |
| Repository branches | `apps/web/src/hooks/queries/useRepositoryBranches.ts` | `GET /repositories/:id/branches` | 60 s | Polling murni untuk daftar branch repo. |

### 3. Low-frequency background polling

| Area | Caller | Endpoint | Interval | Catatan |
| --- | --- | --- | --- | --- |
| Runtime info | `apps/web/src/hooks/queries/useRuntimeInfo.ts` | `GET /debug/runtime-info` | 60 s | Ringan, tapi global. |
| Codex model catalog | `apps/web/src/hooks/queries/useCodexModels.ts` | `GET /codex/models` | 10 m | Snapshot konfigurasi/model. |
| Cursor model catalog | `apps/web/src/hooks/queries/useCursorModels.ts` | `GET /cursor/models` | 10 m | Snapshot konfigurasi/model. |
| OpenCode model catalog | `apps/web/src/hooks/queries/useOpencodeModels.ts` | `GET /opencode/models` | 10 m | Snapshot konfigurasi/model. |

## Temuan Penting Di `codesymphony`

### 1. Automation sekarang sudah push-first; polling tinggal fallback

Kedua halaman automation memanggil `useWorkspaceSyncStream()`:
- [apps/web/src/pages/automations/AutomationsPage.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/pages/automations/AutomationsPage.tsx:1339)
- [apps/web/src/pages/automations/AutomationsPage.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/pages/automations/AutomationsPage.tsx:1819)

Sekarang handler SSE workspace juga meng-invalidate cache automation:
- [apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts:93)
- [apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts:126)

Di sisi runtime, automation service sekarang mem-broadcast event automation yang spesifik:
- [apps/runtime/src/services/automationService.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/services/automationService.ts:459)

Efeknya:
- refresh normal bergerak lewat SSE lebih dulu,
- polling automation sekarang benar-benar hanya safety net reconnect / missed event.

### 2. Git/file worktree sekarang push-first untuk perubahan eksternal juga

Client sudah punya workspace SSE:
- [apps/runtime/src/routes/workspaceEvents.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/workspaceEvents.ts:27)
- [apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/pages/workspace/hooks/useWorkspaceSyncStream.ts:221)

Sekarang runtime juga punya watcher file/git umum:
- [apps/runtime/src/services/worktreeWatchService.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/services/worktreeWatchService.ts:1)
- [apps/runtime/src/index.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/index.ts:111)

Watcher ini menangani dua hal:
- perubahan file worktree dari terminal/editor eksternal,
- perubahan metadata `.git` seperti commit, checkout, sync, fetch, atau staging dari luar aplikasi.

Akibatnya polling `git/status`, `branch-diff-summary`, `files/index`, dan `slash-commands` turun posisi menjadi fallback, bukan mekanisme utama.

### 3. Android clipboard polling sangat agresif, tapi kodenya memang sudah mengaku ini fallback

Komentar sumbernya eksplisit:
- [apps/web/src/components/workspace/AndroidDeviceViewer.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/AndroidDeviceViewer.tsx:78)

Implementasinya:
- request berkala ke `api.readAndroidClipboard(sessionId)` [apps/web/src/components/workspace/AndroidDeviceViewer.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/AndroidDeviceViewer.tsx:575)
- dipicu tiap 250 ms [apps/web/src/components/workspace/AndroidDeviceViewer.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/AndroidDeviceViewer.tsx:705)
- endpoint runtime-nya adalah [apps/runtime/src/routes/devices.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/devices.ts:506)

Yang menarik: viewer sebenarnya sudah bisa menerima packet clipboard push pada jalur tertentu:
- [apps/web/src/components/workspace/AndroidDeviceViewer.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/AndroidDeviceViewer.tsx:1115)

Artinya polling ini bukan desain ideal, tapi compatibility fallback.

### 4. Resource monitor polling termasuk wajar

`ResourceMonitor` mengambil snapshot teragregasi dari runtime dan desktop:
- [apps/web/src/components/workspace/ResourceMonitor.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/ResourceMonitor.tsx:264)

Polling 2 s hanya saat popover terbuka:
- [apps/web/src/components/workspace/ResourceMonitor.tsx](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/components/workspace/ResourceMonitor.tsx:283)

Ini cukup masuk akal karena sifat datanya memang snapshot metric, bukan domain event log.

## Endpoint Dan Sumber Kode Utama

- Automation endpoints: [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:441), [apps/runtime/src/routes/automations.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/automations.ts:55)
- Git status / branch diff / file index / slash commands: [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:809), [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:847), [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:853), [apps/runtime/src/routes/repositories.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/repositories.ts:556), [apps/runtime/src/routes/repositories.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/repositories.ts:678), [apps/runtime/src/routes/chats.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/chats.ts:151)
- Runtime info / resource monitor / model catalogs: [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:879), [apps/runtime/src/routes/debug.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/debug.ts:246), [apps/runtime/src/routes/resourceMonitor.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/resourceMonitor.ts:3), [apps/runtime/src/routes/models.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/models.ts:121)
- Android clipboard: [apps/web/src/lib/api.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/web/src/lib/api.ts:954), [apps/runtime/src/routes/devices.ts](/Users/dwirandyh/Work/Personal/codesymphony/apps/runtime/src/routes/devices.ts:506)

## Perbandingan Dengan `../superset`

### Gambaran umum

`superset` punya fondasi push-first yang lebih kuat untuk workspace liveness:
- unified WebSocket event bus di host-service,
- client helper `useWorkspaceEvent(...)`,
- invalidation atau patch cache berbasis event,
- polling dipakai sebagai fallback atau untuk domain yang belum pindah ke stream.

Referensi utama:
- event bus client: [../superset/packages/workspace-client/src/lib/eventBus.ts](/Users/dwirandyh/Work/Personal/superset/packages/workspace-client/src/lib/eventBus.ts:12)
- event bus server: [../superset/packages/host-service/src/events/event-bus.ts](/Users/dwirandyh/Work/Personal/superset/packages/host-service/src/events/event-bus.ts:58)
- hook subscription: [../superset/apps/desktop/src/renderer/hooks/host-service/useWorkspaceEvent/useWorkspaceEvent.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/hooks/host-service/useWorkspaceEvent/useWorkspaceEvent.ts:17)

### Yang lebih baik di `superset`

### 1. Git/live workspace state sudah push-first

`superset` punya `GitWatcher` di host-service yang mengamati `.git/` dan file worktree, lalu mem-broadcast `git:changed`:
- [../superset/packages/host-service/src/events/git-watcher.ts](/Users/dwirandyh/Work/Personal/superset/packages/host-service/src/events/git-watcher.ts:38)
- [../superset/packages/host-service/src/events/event-bus.ts](/Users/dwirandyh/Work/Personal/superset/packages/host-service/src/events/event-bus.ts:81)

Di client, `useGitStatus` tidak pakai `refetchInterval`; dia invalidate query ketika `git:changed` masuk:
- [../superset/apps/desktop/src/renderer/hooks/host-service/useGitStatus/useGitStatus.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/hooks/host-service/useGitStatus/useGitStatus.ts:25)
- [../superset/apps/desktop/src/renderer/hooks/host-service/useGitStatus/useGitStatus.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/hooks/host-service/useGitStatus/useGitStatus.ts:38)

Ini lebih baik dari `codesymphony` untuk kasus git/file changes karena perubahan dari luar aplikasi tetap bisa didorong ke client tanpa menunggu polling berikutnya.

### 2. Port sidebar sudah hybrid yang rapi: event-driven + slow fallback

`superset` masih punya fallback polling 30 s:
- [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarPortsList/hooks/useDashboardSidebarPortsData/useDashboardSidebarPortsData.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarPortsList/hooks/useDashboardSidebarPortsData/useDashboardSidebarPortsData.ts:77)

Tapi dia langsung patch cache dari event `port:changed`:
- [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarPortsList/hooks/useDashboardSidebarPortsData/useDashboardSidebarPortsData.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarPortsList/hooks/useDashboardSidebarPortsData/useDashboardSidebarPortsData.ts:125)
- komentar server-side juga eksplisit menyebut fallback refetch sebagai safety net: [../superset/packages/host-service/src/events/event-bus.ts](/Users/dwirandyh/Work/Personal/superset/packages/host-service/src/events/event-bus.ts:185)

Ini pola yang paling relevan untuk ditiru: push-first, polling hanya fallback reconnect/version-skew.

### Yang masih polling juga di `superset`

`superset` belum sepenuhnya bebas polling.

Masih ada polling murni untuk:
- chat snapshot berbasis FPS: [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatPane/hooks/useWorkspaceChatDisplay/useWorkspaceChatDisplay.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/hooks/usePaneRegistry/components/ChatPane/hooks/useWorkspaceChatDisplay/useWorkspaceChatDisplay.ts:120)
- branch list: [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/useChangesTab/useChangesTab.tsx](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/useChangesTab/useChangesTab.tsx:94)
- PR metadata dan review threads: [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/useReviewTab/useReviewTab.tsx](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/useReviewTab/useReviewTab.tsx:29)
- PR flow state: [../superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/usePRFlowState/usePRFlowState.ts](/Users/dwirandyh/Work/Personal/superset/apps/desktop/src/renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/components/WorkspaceSidebar/hooks/usePRFlowState/usePRFlowState.ts:15)

Jadi kesimpulannya bukan "superset tidak polling", tapi:
- untuk workspace reactivity generik, `superset` sudah lebih baik karena event bus-nya matang,
- untuk beberapa domain spesifik, `superset` masih polling juga.

### Kesimpulan Perbandingan

Kalau fokusnya adalah "bagaimana menangani state yang berubah karena aktivitas workspace", pendekatan `superset` lebih baik dari `codesymphony` karena:
- ada watcher host-side,
- event bus tunggal,
- invalidation cache berbasis event,
- polling diposisikan sebagai fallback.

Kalau fokusnya adalah "chat stream real-time", `codesymphony` justru sudah lebih baik di area itu karena memakai SSE thread/workspace, sedangkan `superset` chat display yang aktif di desktop masih polling snapshot per interval.

## Rekomendasi Lanjutan

1. Pertahankan `ResourceMonitor` sebagai polling snapshot.
   - Ini tetap masuk akal karena data metrik memang time-series snapshot.

2. Pertahankan Android clipboard polling sebagai fallback sampai transport viewer diperbarui.
   - Jika viewer/bridge bisa menjamin `clipboard` push event, polling 250 ms bisa dihapus atau minimal dibuat adaptif.

3. Evaluasi domain `repository branches` dan `repository reviews`.
   - Dua area ini masih polling karena belum punya event source yang cukup spesifik.
