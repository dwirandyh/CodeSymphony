import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isRenderDebugEnabled, copyRenderDebugLog } from "../../../lib/renderDebug";
import { debugLog } from "../../../lib/debugLog";
import { VList, type VListHandle } from "virtua";
import type { ChatMessageListProps, ChatTimelineItem, TimelineCtx } from "./ChatMessageList.types";
import { getTimelineItemKey, isExplicitNoGrowthResult } from "./toolEventUtils";
import { TimelineItem, ThinkingPlaceholder } from "./TimelineItem";

const TOP_LOAD_REARM_COOLDOWN_MS = 180;
const AT_BOTTOM_THRESHOLD = 48;
const TOP_LOAD_ENTER_THRESHOLD = 180;
const TOP_LOAD_LEAVE_THRESHOLD = 280;
const TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX = 2;
const TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX = 4;
const TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX = 96;
const TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX = 8;
const TOP_LOAD_RELEASE_ANCHOR_LOCK_MS = 600;
const TOP_LOAD_RELEASE_ANCHOR_WATCH_MS = 1500;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_GUARD_MS = 2800;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_MIN_PREV_OFFSET_PX = 16;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_USER_INPUT_GRACE_MS = 140;
const TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_RESTORE_COOLDOWN_MS = 240;
const PROGRAMMATIC_SCROLL_TARGET_TOLERANCE_PX = 2;
const PROGRAMMATIC_SCROLL_FRAME_WINDOW_MS = 24;

export function ChatMessageList({
  items,
  timelineSummary,
  showThinkingPlaceholder = false,
  sendingMessage = false,
  onOpenReadFile,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  topPaginationInteractionReady = false,
  onLoadOlderHistory,
}: ChatMessageListProps) {
  const vlistRef = useRef<VListHandle>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
  const loadingOlderRef = useRef(false);
  const topLoadArmedRef = useRef(true);
  const topLoadCooldownUntilRef = useRef(0);
  const topLoadRearmTimeoutRef = useRef<number | null>(null);
  const topLoadPostReleaseCooldownUntilRef = useRef(0);
  const [rawOutputMessageIds, setRawOutputMessageIds] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [bashExpandedById, setBashExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [editedExpandedById, setEditedExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [exploreActivityExpandedById, setExploreActivityExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExpandedById, setSubagentExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentPromptExpandedById, setSubagentPromptExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExploreExpandedById, setSubagentExploreExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const lastRenderSignatureByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDebugEnabled = isRenderDebugEnabled();

  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const userScrolledAwayRef = useRef(false);
  const lastItemCountChangeRef = useRef(0);
  const [atTop, setAtTop] = useState(false);
  const atTopRef = useRef(atTop);
  const leftTopZoneRef = useRef(true);
  const loadCycleCounterRef = useRef(0);
  const loadCycleInFlightRef = useRef(false);
  const [shiftActive, setShiftActive] = useState(false);
  const shiftReleasePendingRef = useRef(false);
  const pendingShiftReleaseRef = useRef<{
    cycleId: number;
    requestId: string;
    baselineRenderableCount: number;
    baselineFirstRenderableKey: string | null;
    completionReason: string | null;
    messagesAdded: number;
    eventsAdded: number;
    estimatedRenderableGrowth: boolean | null;
    loadFinished: boolean;
    releaseQueued: boolean;
    releaseAnchorOffset: number | null;
    releaseAnchorDistanceFromTop: number | null;
  } | null>(null);
  const shiftReleaseTimeoutRef = useRef<number | null>(null);
  const shiftDeactivateTokenRef = useRef(0);
  const shiftForceDisabledRef = useRef(false);
  const shiftReleaseAnchorWatchTimeoutRef = useRef<number | null>(null);
  const shiftReleaseAnchorWatchRafRef = useRef<number | null>(null);
  const eventsOnlyLateDriftGuardUntilRef = useRef(0);
  const eventsOnlyLateDriftRestoreCooldownUntilRef = useRef(0);
  const lastUserScrollIntentAtRef = useRef(0);
  const pendingShiftAnchorRestoreRef = useRef<{
    reason: string;
    targetOffset: number;
    releaseAnchorDistanceFromTop: number;
    lockUntilAt: number;
    watchUntilAt: number;
    suppressRestore?: boolean;
  } | null>(null);
  const pendingShiftRestoreFrameRef = useRef(false);
  const shiftPendingVisibilityHideRef = useRef(false);
  const shiftBaselineDfbRef = useRef<number | null>(null);
  const scrollJumpCompensationActiveRef = useRef(false);
  const scrollFreezeActiveRef = useRef(false);
  const scrollFreezeCleanupRef = useRef<(() => void) | null>(null);
  const remeasureSettledCountRef = useRef(0);
  const remeasureSettledTimerRef = useRef<number | null>(null);
  const programmaticScrollRef = useRef<{
    targetOffset: number;
    issuedAt: number;
    reason: string;
  } | null>(null);

  const freezeScrollInertia = useCallback(() => {
    if (scrollFreezeActiveRef.current) return;
    scrollFreezeActiveRef.current = true;
    scrollFreezeCleanupRef.current = () => {
      scrollFreezeActiveRef.current = false;
      scrollFreezeCleanupRef.current = null;
    };
  }, []);

  const unfreezeScrollInertia = useCallback(() => {
    if (!scrollFreezeActiveRef.current) return;
    scrollFreezeCleanupRef.current?.();
  }, []);

  const clearProgrammaticScrollGuard = useCallback(() => {
    programmaticScrollRef.current = null;
  }, []);

  const performProgrammaticScroll = useCallback((
    handle: VListHandle,
    targetOffset: number,
    reason: string,
  ) => {
    const now = Date.now();
    const currentOffset = handle.scrollOffset;
    const currentDelta = Math.abs(currentOffset - targetOffset);
    if (currentDelta <= PROGRAMMATIC_SCROLL_TARGET_TOLERANCE_PX) {
      clearProgrammaticScrollGuard();
      return false;
    }

    const previous = programmaticScrollRef.current;
    if (
      previous
      && now - previous.issuedAt <= PROGRAMMATIC_SCROLL_FRAME_WINDOW_MS
      && Math.abs(previous.targetOffset - targetOffset) <= PROGRAMMATIC_SCROLL_TARGET_TOLERANCE_PX
    ) {
      return false;
    }
    programmaticScrollRef.current = {
      targetOffset,
      issuedAt: now,
      reason,
    };
    handle.scrollTo(targetOffset);
    return true;
  }, [clearProgrammaticScrollGuard]);

  const topLoadTransactionActiveRef = useRef(false);
  const hasOlderHistoryRef = useRef(hasOlderHistory);
  const loadingOlderHistoryPropRef = useRef(loadingOlderHistory);
  const topPaginationInteractionReadyRef = useRef(topPaginationInteractionReady);
  const onLoadOlderHistoryRef = useRef(onLoadOlderHistory);
  const renderableCountRef = useRef(0);
  const renderableFirstKeyRef = useRef<string | null>(null);

  const readScrollSnapshot = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle) {
      return {
        scrollHandleReady: false,
        scrollOffset: null,
        scrollSize: null,
        viewportSize: null,
        maxScroll: null,
        distanceFromTop: null,
        distanceFromBottom: null,
      };
    }

    const { scrollOffset, scrollSize, viewportSize } = handle;
    const maxScroll = Math.max(scrollSize - viewportSize, 0);
    const distanceFromTop = Math.max(scrollOffset, 0);
    const distanceFromBottom = Math.max(maxScroll - scrollOffset, 0);

    return {
      scrollHandleReady: true,
      scrollOffset,
      scrollSize,
      viewportSize,
      maxScroll,
      distanceFromTop,
      distanceFromBottom,
    };
  }, []);


  const clearPendingShiftAnchorRestore = useCallback(() => {
    pendingShiftAnchorRestoreRef.current = null;
    topLoadPostReleaseCooldownUntilRef.current = 0;
    if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
      window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
      shiftReleaseAnchorWatchTimeoutRef.current = null;
    }
    if (shiftReleaseAnchorWatchRafRef.current != null) {
      window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
      shiftReleaseAnchorWatchRafRef.current = null;
    }
  }, []);

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = Date.now();
  }, []);

  const releaseShift = useCallback((reason: string) => {
    const pending = pendingShiftReleaseRef.current;
    pendingShiftReleaseRef.current = null;
    topLoadTransactionActiveRef.current = false;
    if (shiftReleaseTimeoutRef.current != null) {
      window.clearTimeout(shiftReleaseTimeoutRef.current);
      shiftReleaseTimeoutRef.current = null;
    }

    const anchorOffset = pending?.releaseAnchorOffset ?? null;
    const anchorDistanceFromTop = pending?.releaseAnchorDistanceFromTop ?? null;
    const now = Date.now();

    eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
    if (
      reason === "events-only-growth"
      && anchorDistanceFromTop != null
      && anchorDistanceFromTop <= TOP_LOAD_ENTER_THRESHOLD
    ) {
      eventsOnlyLateDriftGuardUntilRef.current = now + TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_GUARD_MS;
    } else {
      eventsOnlyLateDriftGuardUntilRef.current = 0;
    }

    debugLog("ChatMessageList", "chat.topLoad.shiftReleased", {
      reason,
      cycleId: pending?.cycleId ?? null,
      requestId: pending?.requestId ?? null,
      completionReason: pending?.completionReason ?? null,
      messagesAdded: pending?.messagesAdded ?? null,
      eventsAdded: pending?.eventsAdded ?? null,
      estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
      releaseAnchorOffset: anchorOffset,
      releaseAnchorDistanceFromTop: anchorDistanceFromTop,
      ...readTopLoadState(),
    });

    const shouldArmAnchorRestore = true;
    if (shouldArmAnchorRestore && anchorOffset != null && anchorDistanceFromTop != null) {
      pendingShiftAnchorRestoreRef.current = {
        reason,
        targetOffset: anchorOffset,
        releaseAnchorDistanceFromTop: anchorDistanceFromTop,
        lockUntilAt: now + TOP_LOAD_RELEASE_ANCHOR_LOCK_MS,
        watchUntilAt: now + TOP_LOAD_RELEASE_ANCHOR_WATCH_MS,
      };
      topLoadPostReleaseCooldownUntilRef.current = now + TOP_LOAD_RELEASE_ANCHOR_WATCH_MS;
      if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
        shiftReleaseAnchorWatchTimeoutRef.current = null;
      }
      shiftReleaseAnchorWatchTimeoutRef.current = window.setTimeout(() => {
        shiftReleaseAnchorWatchTimeoutRef.current = null;
        clearPendingShiftAnchorRestore();
      }, TOP_LOAD_RELEASE_ANCHOR_WATCH_MS);
      if (shiftReleaseAnchorWatchRafRef.current != null) {
        window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
        shiftReleaseAnchorWatchRafRef.current = null;
      }
      const tickAnchorWatch = () => {
        const pendingRestore = pendingShiftAnchorRestoreRef.current;
        if (!pendingRestore) {
          shiftReleaseAnchorWatchRafRef.current = null;
          return;
        }
        const nowTick = Date.now();
        if (nowTick >= pendingRestore.watchUntilAt) {
          clearPendingShiftAnchorRestore();
          shiftReleaseAnchorWatchRafRef.current = null;
          return;
        }
        const handle = vlistRef.current;
        if (handle && !topLoadTransactionActiveRef.current && !pendingRestore.suppressRestore) {
          const currentOffset = handle.scrollOffset;
          const delta = Math.abs(currentOffset - pendingRestore.targetOffset);
          const withinLockWindow = nowTick <= pendingRestore.lockUntilAt;
          const lockTolerancePx = pendingRestore.reason === "events-only-growth"
            ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
            : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
          const severeTopCollapse =
            pendingRestore.reason === "events-only-growth"
            && currentOffset <= TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX
            && delta > TOP_LOAD_ENTER_THRESHOLD;
          const shouldRestore = pendingRestore.reason === "events-only-growth"
            ? severeTopCollapse
            : withinLockWindow
              ? delta > lockTolerancePx
              : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
          if (shouldRestore) {
            debugLog("ChatMessageList", "chat.topLoad.anchorRestore", {
              reason: pendingRestore.reason,
              restoreMode: severeTopCollapse
                ? "raf-collapse"
                : withinLockWindow
                  ? "raf-lock"
                  : "raf-watch",
              fromOffset: currentOffset,
              targetOffset: pendingRestore.targetOffset,
              delta,
              releaseAnchorDistanceFromTop: pendingRestore.releaseAnchorDistanceFromTop,
              ...readTopLoadState(),
            });
            performProgrammaticScroll(handle, pendingRestore.targetOffset, "top-load-anchor-restore-raf");
          }
        }
        shiftReleaseAnchorWatchRafRef.current = window.requestAnimationFrame(tickAnchorWatch);
      };
      shiftReleaseAnchorWatchRafRef.current = window.requestAnimationFrame(tickAnchorWatch);
      const keepShiftDuringAnchorLock = reason !== "events-only-growth"
        || (anchorDistanceFromTop != null && anchorDistanceFromTop <= TOP_LOAD_ENTER_THRESHOLD);
      shiftReleasePendingRef.current = keepShiftDuringAnchorLock;
      pendingShiftRestoreFrameRef.current = keepShiftDuringAnchorLock;
      if (!keepShiftDuringAnchorLock) {
        shiftForceDisabledRef.current = true;
        shiftDeactivateTokenRef.current += 1;
        setShiftActive(false);
        return;
      }
      shiftForceDisabledRef.current = false;
      const nextToken = shiftDeactivateTokenRef.current + 1;
      shiftDeactivateTokenRef.current = nextToken;
      const shiftDeactivateDelayMs = TOP_LOAD_RELEASE_ANCHOR_WATCH_MS;
      debugLog("ChatMessageList", "shift-deactivate-scheduled", {
        reason,
        delayMs: shiftDeactivateDelayMs,
        token: nextToken,
        releaseAnchorOffset: anchorOffset,
        releaseAnchorDistanceFromTop: anchorDistanceFromTop,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        stickyBottom: stickyBottomRef.current,
        topLoadTransactionActive: topLoadTransactionActiveRef.current,
      });
      window.setTimeout(() => {
        if (shiftDeactivateTokenRef.current !== nextToken) {
          return;
        }
        shiftForceDisabledRef.current = true;
        debugLog("ChatMessageList", "shift-deactivate-fired", {
          reason,
          delayMs: shiftDeactivateDelayMs,
          token: nextToken,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
          topLoadTransactionActive: topLoadTransactionActiveRef.current,
        });
        setShiftActive(false);
        if (scrollWrapperRef.current) {
          const scrollerEl = scrollWrapperRef.current.firstElementChild as HTMLElement | null;
          if (scrollerEl) scrollerEl.style.visibility = "";
        }
      }, shiftDeactivateDelayMs);
      return;
    }

    clearPendingShiftAnchorRestore();
    shiftReleasePendingRef.current = false;
    pendingShiftRestoreFrameRef.current = false;
    shiftForceDisabledRef.current = true;
    shiftDeactivateTokenRef.current += 1;
    setShiftActive(false);
  }, [clearPendingShiftAnchorRestore, readScrollSnapshot]);

  const renderableItems = useMemo(
    () => items.filter((item) => item.kind !== "activity"),
    [items],
  );
  const firstRenderableKey = useMemo(
    () => (renderableItems.length > 0 ? getTimelineItemKey(renderableItems[0]) : null),
    [renderableItems],
  );

  const displayItems = useMemo(() => {
    const result: (ChatTimelineItem | "thinking-placeholder")[] = [...renderableItems];
    if (showThinkingPlaceholder) {
      result.push("thinking-placeholder");
    }
    return result;
  }, [renderableItems, showThinkingPlaceholder]);
  const stableHeadKey = timelineSummary?.oldestRenderableKey ?? firstRenderableKey;
  const stableHeadIdentity = timelineSummary?.oldestRenderableMessageId ?? firstRenderableKey;
  const headIdentityStable = timelineSummary?.headIdentityStable ?? true;
  const oldestRenderableHydrationPending = timelineSummary?.oldestRenderableHydrationPending ?? false;

  const stickyBottomRef = useRef(true);

  function readHeadSummary() {
    return renderableItems.slice(0, 3).map((item) => ({
      key: getTimelineItemKey(item),
      kind: item.kind,
    }));
  }

  function readTopLoadState() {
    return {
      renderableCount: renderableItems.length,
      firstRenderableKey,
      stableHeadKey,
      stableHeadIdentity,
      headIdentityStable,
      oldestRenderableHydrationPending,
      displayCount: displayItems.length,
      head: readHeadSummary(),
      shiftActive,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
      pendingShiftRestore: pendingShiftAnchorRestoreRef.current != null,
      stickyBottom: stickyBottomRef.current,
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      ...readScrollSnapshot(),
    };
  }

  useEffect(() => {
    hasOlderHistoryRef.current = hasOlderHistory;
    loadingOlderHistoryPropRef.current = loadingOlderHistory;
    topPaginationInteractionReadyRef.current = topPaginationInteractionReady;
    onLoadOlderHistoryRef.current = onLoadOlderHistory;
  }, [
    hasOlderHistory,
    loadingOlderHistory,
    topPaginationInteractionReady,
    onLoadOlderHistory,
  ]);

  useEffect(() => {
    renderableCountRef.current = renderableItems.length;
    renderableFirstKeyRef.current = stableHeadKey;
  }, [renderableItems.length, stableHeadKey]);

  const prevDisplayCountRef = useRef(displayItems.length);
  useLayoutEffect(() => {
    const prevCount = prevDisplayCountRef.current;
    if (displayItems.length !== prevCount) {
      lastItemCountChangeRef.current = Date.now();
      prevDisplayCountRef.current = displayItems.length;
    }

    if (shiftPendingVisibilityHideRef.current && displayItems.length > prevCount) {
      shiftPendingVisibilityHideRef.current = false;
      const wrapper = scrollWrapperRef.current;
      if (wrapper) {
        const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
        if (scrollerEl) {
          scrollerEl.style.visibility = "hidden";
          requestAnimationFrame(() => {
            if (scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
              const pendingAnchor = pendingShiftAnchorRestoreRef.current;
              if (pendingAnchor && !pendingAnchor.suppressRestore) {
                pendingAnchor.suppressRestore = true;
              }
            }
          });
        }
      }
    }

    if (pendingShiftRestoreFrameRef.current) {
      pendingShiftRestoreFrameRef.current = false;
    }

    const pendingAnchorRestore = pendingShiftAnchorRestoreRef.current;
    if (pendingAnchorRestore) {
      const now = Date.now();
      if (now >= pendingAnchorRestore.watchUntilAt) {
        clearPendingShiftAnchorRestore();
      } else {
        const handle = vlistRef.current;
        if (handle) {
          const currentOffset = handle.scrollOffset;
          const prevGeomLayout = lastScrollGeometryRef.current;
          const layoutSizeDelta = prevGeomLayout ? handle.scrollSize - prevGeomLayout.scrollSize : 0;
          const layoutOffsetDelta = prevGeomLayout ? currentOffset - prevGeomLayout.offset : 0;
          if (
            pendingAnchorRestore.reason === "events-only-growth"
            && prevGeomLayout
            && layoutSizeDelta > 50
            && Math.abs(layoutOffsetDelta - layoutSizeDelta) < 100
            && currentOffset > pendingAnchorRestore.targetOffset + 50
          ) {
            pendingAnchorRestore.suppressRestore = true;
            shiftBaselineDfbRef.current = null;
            const wrapper = scrollWrapperRef.current;
            if (wrapper) {
              const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
              if (scrollerEl && scrollerEl.style.visibility === "hidden") {
                scrollerEl.style.visibility = "";
              }
            }
          }
          if (pendingAnchorRestore?.suppressRestore) {
            // Shift mode is handling visual stability; skip all restore logic.
          } else {
            const movedAwayFromTopDuringEventsGrowth = pendingAnchorRestore.reason === "events-only-growth"
              && currentOffset > pendingAnchorRestore.targetOffset + TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            if (movedAwayFromTopDuringEventsGrowth && !topLoadTransactionActiveRef.current) {
              debugLog("ChatMessageList", "chat.topLoad.anchorRestoreCancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: "events-growth-away-from-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: currentOffset,
                deltaFromTarget: Math.abs(currentOffset - pendingAnchorRestore.targetOffset),
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
              return;
            }
            const movedTowardTop = currentOffset
              < pendingAnchorRestore.targetOffset - TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const shouldCancelTowardTop = movedTowardTop
              && !topLoadTransactionActiveRef.current
              && pendingAnchorRestore.reason !== "events-only-growth";
            if (shouldCancelTowardTop) {
              debugLog("ChatMessageList", "chat.topLoad.anchorRestoreCancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: "toward-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: currentOffset,
                deltaFromTarget: Math.abs(currentOffset - pendingAnchorRestore.targetOffset),
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
              return;
            }
            const delta = Math.abs(currentOffset - pendingAnchorRestore.targetOffset);
            const withinLockWindow = now <= pendingAnchorRestore.lockUntilAt;
            const prevGeometry = lastScrollGeometryRef.current;
            const currentScrollSize = handle.scrollSize;
            const currentViewportSize = handle.viewportSize;
            const currentMaxScroll = Math.max(currentScrollSize - currentViewportSize, 0);
            const sizeDelta = prevGeometry ? currentScrollSize - prevGeometry.scrollSize : 0;
            const maxScrollDelta = prevGeometry ? currentMaxScroll - prevGeometry.maxScroll : 0;
            const layoutShrinkDetected = prevGeometry != null
              && (sizeDelta < -1 || maxScrollDelta < -1);
            const lockTolerancePx = pendingAnchorRestore.reason === "events-only-growth"
              ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
              : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const eventsOnlyShrinkRestore = pendingAnchorRestore.reason === "events-only-growth"
              && layoutShrinkDetected
              && delta > lockTolerancePx;
            const shouldRestore = pendingAnchorRestore.reason === "events-only-growth"
              ? eventsOnlyShrinkRestore
              : withinLockWindow
                ? delta > lockTolerancePx
                : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
            if (shouldRestore) {
              debugLog("ChatMessageList", "chat.topLoad.anchorRestore", {
                reason: pendingAnchorRestore.reason,
                restoreMode: eventsOnlyShrinkRestore
                  ? "layout-events-shrink"
                  : withinLockWindow
                    ? "layout-lock"
                    : "layout-watch",
                fromOffset: currentOffset,
                targetOffset: pendingAnchorRestore.targetOffset,
                delta,
                sizeDelta,
                maxScrollDelta,
                releaseAnchorDistanceFromTop: pendingAnchorRestore.releaseAnchorDistanceFromTop,
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              if (performProgrammaticScroll(handle, pendingAnchorRestore.targetOffset, "top-load-anchor-restore-layout")) {
                return;
              }
            }
          }
        }
      }
    }

    if (shiftReleasePendingRef.current) {
      shiftReleasePendingRef.current = false;
    }

    const pending = pendingShiftReleaseRef.current;
    if (!pending || !pending.loadFinished || pending.releaseQueued) {
      return;
    }

    const renderableGrew = renderableItems.length > pending.baselineRenderableCount;
    const firstKeyChanged = stableHeadKey !== pending.baselineFirstRenderableKey;
    const prependCommitted = firstKeyChanged;
    const nonPrependGrowth = renderableGrew && !firstKeyChanged;
    const canReleaseOnNonPrependGrowth = headIdentityStable && !oldestRenderableHydrationPending;
    const hasExplicitNoGrowth = isExplicitNoGrowthResult({
      completionReason: pending.completionReason,
      estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
      messagesAdded: pending.messagesAdded,
      eventsAdded: pending.eventsAdded,
    });
    const noGrowthFinal = hasExplicitNoGrowth && !prependCommitted && !nonPrependGrowth;

    if (!prependCommitted && !nonPrependGrowth && !noGrowthFinal) {
      return;
    }

    if (nonPrependGrowth && !canReleaseOnNonPrependGrowth) {
      debugLog("ChatMessageList", "chat.topLoad.prependEvaluationDeferred", {
        cycleId: pending.cycleId,
        requestId: pending.requestId,
        baselineRenderableCount: pending.baselineRenderableCount,
        baselineFirstRenderableKey: pending.baselineFirstRenderableKey,
        renderableGrew,
        firstKeyChanged,
        prependCommitted,
        nonPrependGrowth,
        noGrowthFinal,
        headIdentityStable,
        oldestRenderableHydrationPending,
        completionReason: pending.completionReason,
        messagesAdded: pending.messagesAdded,
        eventsAdded: pending.eventsAdded,
        estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
        ...readTopLoadState(),
      });
      return;
    }

    const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
    const releaseAnchorDistanceFromTop = releaseAnchorOffset;
    pending.releaseAnchorOffset = releaseAnchorOffset;
    pending.releaseAnchorDistanceFromTop = releaseAnchorDistanceFromTop;

    debugLog("ChatMessageList", "chat.topLoad.prependEvaluation", {
      cycleId: pending.cycleId,
      requestId: pending.requestId,
      baselineRenderableCount: pending.baselineRenderableCount,
      baselineFirstRenderableKey: pending.baselineFirstRenderableKey,
      prependCommitted,
      nonPrependGrowth,
      canReleaseOnNonPrependGrowth,
      noGrowthFinal,
      completionReason: pending.completionReason,
      messagesAdded: pending.messagesAdded,
      eventsAdded: pending.eventsAdded,
      estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
      releaseAnchorOffset,
      releaseAnchorDistanceFromTop,
      ...readTopLoadState(),
    });

    pending.releaseQueued = true;
    releaseShift(nonPrependGrowth
      ? "non-prepend-growth"
      : prependCommitted
        ? "prepend-commit"
        : "no-growth");
  }, [
    clearPendingShiftAnchorRestore,
    displayItems.length,
    headIdentityStable,
    oldestRenderableHydrationPending,
    performProgrammaticScroll,
    readScrollSnapshot,
    releaseShift,
    renderableItems.length,
    shiftActive,
    stableHeadKey,
  ]);

  const handleScroll = useCallback((offset: number) => {
    const handle = vlistRef.current;
    if (!handle) return;

    const pendingProgrammaticScroll = programmaticScrollRef.current;
    if (pendingProgrammaticScroll) {
      const now = Date.now();
      const settledAtTarget = Math.abs(offset - pendingProgrammaticScroll.targetOffset) <= PROGRAMMATIC_SCROLL_TARGET_TOLERANCE_PX;
      const expired = now - pendingProgrammaticScroll.issuedAt > PROGRAMMATIC_SCROLL_FRAME_WINDOW_MS;
      if (settledAtTarget || expired) {
        clearProgrammaticScrollGuard();
      }
    }

    const { scrollSize, viewportSize } = handle;
    const maxScroll = scrollSize - viewportSize;
    const prevGeometry = lastScrollGeometryRef.current;

    if (
      prevGeometry
      && !scrollJumpCompensationActiveRef.current
      && !pendingShiftAnchorRestoreRef.current
      && !topLoadTransactionActiveRef.current
    ) {
      const jumpDelta = offset - prevGeometry.offset;
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const isRemeasureJump = Math.abs(sizeDelta) > 80 && Math.abs(jumpDelta) > 80 && Math.abs(jumpDelta - sizeDelta) < 50;

      if (isRemeasureJump) {
        const scroller = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
        const innerContainer = scroller?.firstElementChild as HTMLElement | null;
        if (innerContainer) {
          scrollJumpCompensationActiveRef.current = true;
          innerContainer.style.visibility = "hidden";
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              innerContainer.style.visibility = "";
              scrollJumpCompensationActiveRef.current = false;
            });
          });
        }
      }
    }

    const pendingAnchorRestore = pendingShiftAnchorRestoreRef.current;
    if (pendingAnchorRestore) {
      const now = Date.now();
      const withinLockWindow = now <= pendingAnchorRestore.lockUntilAt;
      if (now >= pendingAnchorRestore.watchUntilAt) {
        clearPendingShiftAnchorRestore();
      } else {
        const sizeDeltaForAnchorAdj = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
        const offsetDeltaForAnchorAdj = prevGeometry ? offset - prevGeometry.offset : 0;
        const shiftGrowthDetected =
          pendingAnchorRestore.reason === "events-only-growth"
          && prevGeometry
          && sizeDeltaForAnchorAdj > 50
          && Math.abs(offsetDeltaForAnchorAdj - sizeDeltaForAnchorAdj) < 100
          && offset > pendingAnchorRestore.targetOffset + 50;
        if (shiftGrowthDetected && !pendingAnchorRestore.suppressRestore) {
          pendingAnchorRestore.suppressRestore = true;
          shiftBaselineDfbRef.current = null;
          const wrapper = scrollWrapperRef.current;
          if (wrapper) {
            const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
            if (scrollerEl && scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
            }
          }
        }
        if (!shiftGrowthDetected && !pendingAnchorRestore.suppressRestore) {
          const movedAwayFromTopDuringEventsGrowth = pendingAnchorRestore.reason === "events-only-growth"
            && offset > pendingAnchorRestore.targetOffset + TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
          const allowEventsGrowthUserCancel = pendingAnchorRestore.reason !== "events-only-growth"
            || !withinLockWindow;
          if (
            movedAwayFromTopDuringEventsGrowth
            && !topLoadTransactionActiveRef.current
            && allowEventsGrowthUserCancel
          ) {
            debugLog("ChatMessageList", "chat.topLoad.anchorRestoreCancelled", {
              reason: pendingAnchorRestore.reason,
              cancelMode: "events-growth-away-from-top",
              targetOffset: pendingAnchorRestore.targetOffset,
              fromOffset: offset,
              deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
              ...readTopLoadState(),
            });
            clearPendingShiftAnchorRestore();
          } else {
            const sizeDelta = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
            const maxScrollDelta = prevGeometry ? maxScroll - prevGeometry.maxScroll : 0;
            const viewportDelta = prevGeometry ? viewportSize - prevGeometry.viewportSize : 0;
            const offsetDelta = prevGeometry ? offset - prevGeometry.offset : 0;
            const layoutShrinkDetected = prevGeometry != null
              && (sizeDelta < -1 || maxScrollDelta < -1);
            const movedTowardTop = offset
              < pendingAnchorRestore.targetOffset - TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            const shouldCancelTowardTop = movedTowardTop
              && !topLoadTransactionActiveRef.current
              && pendingAnchorRestore.reason !== "events-only-growth"
              && (
                !layoutShrinkDetected
                || allowEventsGrowthUserCancel
              );
            if (shouldCancelTowardTop) {
              debugLog("ChatMessageList", "chat.topLoad.anchorRestoreCancelled", {
                reason: pendingAnchorRestore.reason,
                cancelMode: pendingAnchorRestore.reason === "events-only-growth"
                  ? "toward-top-user-intent"
                  : "toward-top",
                targetOffset: pendingAnchorRestore.targetOffset,
                fromOffset: offset,
                deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
                sizeDelta,
                maxScrollDelta,
                viewportDelta,
                offsetDelta,
                ...readScrollSnapshot(),
                atTop: atTopRef.current,
                atBottom: atBottomRef.current,
                stickyBottom: stickyBottomRef.current,
                topLoadTransactionActive: topLoadTransactionActiveRef.current,
              });
              clearPendingShiftAnchorRestore();
            } else {
              const movingAwayFromAnchor = prevGeometry
                ? Math.abs(offset - pendingAnchorRestore.targetOffset)
                > Math.abs(prevGeometry.offset - pendingAnchorRestore.targetOffset) + 0.5
                : false;
              const likelyUserScrollIntent = prevGeometry != null
                && Math.abs(sizeDelta) <= 1
                && Math.abs(maxScrollDelta) <= 1
                && Math.abs(viewportDelta) <= 1
                && Math.abs(offsetDelta) > TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX
                && movingAwayFromAnchor;
              if (
                likelyUserScrollIntent
                && !topLoadTransactionActiveRef.current
                && allowEventsGrowthUserCancel
              ) {
                debugLog("ChatMessageList", "chat.topLoad.anchorRestoreCancelled", {
                  reason: pendingAnchorRestore.reason,
                  cancelMode: "user-scroll-intent",
                  targetOffset: pendingAnchorRestore.targetOffset,
                  fromOffset: offset,
                  deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
                  offsetDelta,
                  sizeDelta,
                  maxScrollDelta,
                  viewportDelta,
                  ...readScrollSnapshot(),
                  atTop: atTopRef.current,
                  atBottom: atBottomRef.current,
                  stickyBottom: stickyBottomRef.current,
                  topLoadTransactionActive: topLoadTransactionActiveRef.current,
                });
                clearPendingShiftAnchorRestore();
              } else {
                const delta = Math.abs(offset - pendingAnchorRestore.targetOffset);
                const lockTolerancePx = pendingAnchorRestore.reason === "events-only-growth"
                  ? TOP_LOAD_RELEASE_ANCHOR_EVENTS_LOCK_TOLERANCE_PX
                  : TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
                const eventsOnlyShrinkRestore = pendingAnchorRestore.reason === "events-only-growth"
                  && layoutShrinkDetected
                  && delta > lockTolerancePx;
                const shouldRestore = pendingAnchorRestore.reason === "events-only-growth"
                  ? eventsOnlyShrinkRestore
                  : withinLockWindow
                    ? delta > lockTolerancePx
                    : delta > TOP_LOAD_RELEASE_ANCHOR_SCROLL_WATCH_TOLERANCE_PX;
                if (shouldRestore) {
                  debugLog("ChatMessageList", "chat.topLoad.anchorRestore", {
                    reason: pendingAnchorRestore.reason,
                    restoreMode: eventsOnlyShrinkRestore
                      ? "on-scroll-events-shrink"
                      : withinLockWindow
                        ? "on-scroll-lock"
                        : "on-scroll-watch",
                    fromOffset: offset,
                    targetOffset: pendingAnchorRestore.targetOffset,
                    delta,
                    releaseAnchorDistanceFromTop: pendingAnchorRestore.releaseAnchorDistanceFromTop,
                    ...readScrollSnapshot(),
                    atTop: atTopRef.current,
                    atBottom: atBottomRef.current,
                    stickyBottom: stickyBottomRef.current,
                    topLoadTransactionActive: topLoadTransactionActiveRef.current,
                  });
                  if (performProgrammaticScroll(handle, pendingAnchorRestore.targetOffset, "top-load-anchor-restore-scroll")) {
                    return;
                  }
                }
              }
            }
          }
        }
      }
    }

    const now = Date.now();
    if (
      !pendingAnchorRestore
      && now <= eventsOnlyLateDriftGuardUntilRef.current
      && now >= eventsOnlyLateDriftRestoreCooldownUntilRef.current
      && prevGeometry
      && !topLoadTransactionActiveRef.current
    ) {
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const maxScrollDelta = maxScroll - prevGeometry.maxScroll;
      const viewportDelta = viewportSize - prevGeometry.viewportSize;
      const offsetDelta = offset - prevGeometry.offset;
      const noLayoutChange =
        Math.abs(sizeDelta) <= 1
        && Math.abs(maxScrollDelta) <= 1
        && Math.abs(viewportDelta) <= 1;
      const collapseToAbsoluteTop =
        offset <= TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX
        && prevGeometry.offset >= TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_MIN_PREV_OFFSET_PX
        && offsetDelta <= -TOP_LOAD_RELEASE_ANCHOR_USER_INTENT_DELTA_PX;
      const recentUserScrollIntent =
        now - lastUserScrollIntentAtRef.current <= TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_USER_INPUT_GRACE_MS;
      if (noLayoutChange && collapseToAbsoluteTop && !recentUserScrollIntent) {
        eventsOnlyLateDriftRestoreCooldownUntilRef.current = now + TOP_LOAD_EVENTS_ONLY_LATE_DRIFT_RESTORE_COOLDOWN_MS;
        debugLog("ChatMessageList", "load-older-post-release-drift-restore", {
          restoreMode: "events-only-late-drift",
          fromOffset: offset,
          targetOffset: prevGeometry.offset,
          offsetDelta,
          sizeDelta,
          maxScrollDelta,
          viewportDelta,
          guardUntil: eventsOnlyLateDriftGuardUntilRef.current,
          lastUserScrollIntentAt: lastUserScrollIntentAtRef.current,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
          topLoadTransactionActive: topLoadTransactionActiveRef.current,
        });
        if (performProgrammaticScroll(handle, prevGeometry.offset, "events-only-late-drift-restore")) {
          return;
        }
      }
    }

    const prevAtTop = atTopRef.current;
    const isAtTop = prevAtTop
      ? offset <= TOP_LOAD_LEAVE_THRESHOLD
      : offset <= TOP_LOAD_ENTER_THRESHOLD;
    const isAtBottom = maxScroll > 0 ? offset >= maxScroll - AT_BOTTOM_THRESHOLD : true;

    const prevSize = lastScrollSizeRef.current;
    const contentGrew = scrollSize > prevSize && prevSize > 0;

    const distFromBottom = maxScroll > 0 ? maxScroll - offset : 0;
    const STICKY_OFF_THRESHOLD = viewportSize * 0.25;
    if (!isAtBottom && distFromBottom > STICKY_OFF_THRESHOLD && !contentGrew) {
      stickyBottomRef.current = false;
    }
    if (isAtBottom) {
      stickyBottomRef.current = true;
    }

    if (prevGeometry) {
      const sizeDelta = scrollSize - prevGeometry.scrollSize;
      const maxScrollDelta = maxScroll - prevGeometry.maxScroll;
      const offsetDelta = offset - prevGeometry.offset;
      const viewportDelta = viewportSize - prevGeometry.viewportSize;
      const geometryChanged = Math.abs(sizeDelta) > 1
        || Math.abs(maxScrollDelta) > 1
        || Math.abs(offsetDelta) > 1
        || Math.abs(viewportDelta) > 1;
      const suspiciousShrinkRebound =
        prevGeometry.scrollSize > scrollSize
        && prevGeometry.distanceFromTop <= TOP_LOAD_LEAVE_THRESHOLD
        && Math.abs(offsetDelta) > 120;
      const suspiciousScrollOnlyDrift =
        Math.abs(sizeDelta) <= 1
        && Math.abs(maxScrollDelta) <= 1
        && Math.abs(offsetDelta) >= 12
        && prevGeometry.distanceFromTop <= TOP_LOAD_LEAVE_THRESHOLD;

      if (geometryChanged) {
        debugLog("ChatMessageList", "chat.scroll.geometryChanged", {
          prevOffset: prevGeometry.offset,
          prevScrollSize: prevGeometry.scrollSize,
          prevViewportSize: prevGeometry.viewportSize,
          prevMaxScroll: prevGeometry.maxScroll,
          prevDistanceFromTop: prevGeometry.distanceFromTop,
          prevDistanceFromBottom: prevGeometry.distanceFromBottom,
          offsetDelta,
          sizeDelta,
          maxScrollDelta,
          viewportDelta,
          suspiciousShrinkRebound,
          suspiciousScrollOnlyDrift,
          pendingShiftRestoreFrame: pendingShiftRestoreFrameRef.current,
          topLoadPostReleaseCooldownUntil: topLoadPostReleaseCooldownUntilRef.current,
          eventsOnlyLateDriftGuardUntil: eventsOnlyLateDriftGuardUntilRef.current,
          ...readTopLoadState(),
        });
      }
    }

    if (contentGrew && stickyBottomRef.current && !isAtBottom && viewportSize > 0) {
      if (topLoadTransactionActiveRef.current) {
        debugLog("ChatMessageList", "sticky-bottom-correction-skipped", {
          reason: "top-load-transaction-active",
          offset,
          ...readTopLoadState(),
        });
      } else {
        debugLog("ChatMessageList", "chat.scroll.stickyBottomCorrection", {
          reason: "content-grew-while-sticky",
          offset,
          beforeScrollOffset: handle.scrollOffset,
          targetScrollOffset: maxScroll,
          ...readTopLoadState(),
        });
        performProgrammaticScroll(handle, maxScroll, "sticky-bottom-correction-scroll");
      }
    }

    lastScrollSizeRef.current = scrollSize;
    lastScrollGeometryRef.current = {
      scrollSize,
      viewportSize,
      maxScroll,
      offset,
      distanceFromTop: Math.max(offset, 0),
      distanceFromBottom: Math.max(maxScroll - offset, 0),
      timestamp: Date.now(),
    };

    const nowForBottom = Date.now();
    const msSinceItemChange = nowForBottom - lastItemCountChangeRef.current;
    const suppressBottom = isAtBottom && userScrolledAwayRef.current && msSinceItemChange < 300;

    if (!suppressBottom) {
      if (!isAtBottom) userScrolledAwayRef.current = true;
      if (isAtBottom) userScrolledAwayRef.current = false;
      if (atBottomRef.current !== isAtBottom) {
        atBottomRef.current = isAtBottom;
        setAtBottom(isAtBottom);
      }
    }

    if (atTopRef.current !== isAtTop) {
      if (!isAtTop) {
        leftTopZoneRef.current = true;
      }
      atTopRef.current = isAtTop;
      setAtTop(isAtTop);
    }
  }, [clearPendingShiftAnchorRestore, clearProgrammaticScrollGuard, performProgrammaticScroll, readScrollSnapshot, readTopLoadState]);

  useEffect(() => {
    atTopRef.current = atTop;
  }, [atTop]);

  const scrollToBottom = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle || displayItems.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      if (!vlistRef.current) return;
      vlistRef.current.scrollToIndex(displayItems.length - 1, { align: "end" });
    });
  }, [displayItems.length]);

  const mountedRef = useRef(false);
  const lastScrollSizeRef = useRef(0);
  const lastScrollGeometryRef = useRef<{
    scrollSize: number;
    viewportSize: number;
    maxScroll: number;
    offset: number;
    distanceFromTop: number;
    distanceFromBottom: number;
    timestamp: number;
  } | null>(null);
  useEffect(() => {
    if (mountedRef.current) return;
    if (displayItems.length === 0) return;
    mountedRef.current = true;
    stickyBottomRef.current = true;
    scrollToBottom();
  }, [displayItems.length, scrollToBottom]);

  const handleScrollEnd = useCallback(() => {
    const baselineDfb = shiftBaselineDfbRef.current;
    if (baselineDfb != null) {
      const h = vlistRef.current;
      if (h) {
        const curOff = h.scrollOffset;
        const curMax = h.scrollSize - h.viewportSize;
        const targetOff = curMax - baselineDfb;
        const correction = targetOff - curOff;
        shiftBaselineDfbRef.current = null;
        if (Math.abs(correction) > 3 && targetOff >= 0 && targetOff <= curMax) {
          performProgrammaticScroll(h, targetOff, "scroll-end-baseline-restore");
        }
      }
    }
    if (topLoadTransactionActiveRef.current) {
      debugLog("ChatMessageList", "sticky-bottom-correction-skipped", {
        reason: "top-load-transaction-active-scroll-end",
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        shiftActive: topLoadTransactionActiveRef.current,
        stickyBottom: stickyBottomRef.current,
      });
      return;
    }
    if (!stickyBottomRef.current) return;
    const h = vlistRef.current;
    if (!h) return;
    const { scrollSize, viewportSize, scrollOffset } = h;
    const maxScroll = scrollSize - viewportSize;
    if (viewportSize > 0 && maxScroll > 0 && scrollOffset < maxScroll - AT_BOTTOM_THRESHOLD) {
      debugLog("ChatMessageList", "chat.scroll.stickyBottomCorrection", {
        reason: "scroll-end-not-at-bottom",
        beforeScrollOffset: scrollOffset,
        targetScrollOffset: maxScroll,
        ...readTopLoadState(),
      });
      performProgrammaticScroll(h, maxScroll, "scroll-end-sticky-bottom-correction");
    }
  }, [readScrollSnapshot]);

  useEffect(() => {
    if (!mountedRef.current) return;
    if ((!atBottomRef.current && !stickyBottomRef.current) || displayItems.length === 0) return;
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayItems.length, scrollToBottom]);

  useEffect(() => {
    if (sendingMessage && displayItems.length > 0) {
      userScrolledAwayRef.current = false;
      atBottomRef.current = true;
      stickyBottomRef.current = true;
      setAtBottom(true);
      scrollToBottom();
    }
  }, [sendingMessage, displayItems.length, scrollToBottom]);

  useEffect(() => {
    if (topLoadRearmTimeoutRef.current != null) return;

    const now = Date.now();
    const cooldownUntil = Math.max(
      topLoadCooldownUntilRef.current,
      topLoadPostReleaseCooldownUntilRef.current,
    );

    if (!atTop && now >= cooldownUntil) {
      topLoadArmedRef.current = true;
      return;
    }

    const waitMs = Math.max(cooldownUntil - now, 0);
    if (waitMs === 0) {
      if (!atTop) topLoadArmedRef.current = true;
      return;
    }

    topLoadRearmTimeoutRef.current = window.setTimeout(() => {
      topLoadRearmTimeoutRef.current = null;
      if (!atTopRef.current) topLoadArmedRef.current = true;
    }, waitMs);

    return () => {
      if (topLoadRearmTimeoutRef.current != null) {
        window.clearTimeout(topLoadRearmTimeoutRef.current);
        topLoadRearmTimeoutRef.current = null;
      }
    };
  }, [atTop]);

  const loadOlder = useCallback(async () => {
    const hasOlderHistoryCurrent = hasOlderHistoryRef.current;
    const loadingOlderHistoryCurrent = loadingOlderHistoryPropRef.current;
    const onLoadOlderHistoryCurrent = onLoadOlderHistoryRef.current;
    const renderableCount = renderableCountRef.current;
    const baselineFirstRenderableKey = renderableFirstKeyRef.current;

    if (loadCycleInFlightRef.current) return;
    if (!hasOlderHistoryCurrent || loadingOlderHistoryCurrent || loadingOlderRef.current) return;
    if (!onLoadOlderHistoryCurrent) return;

    const now = Date.now();
    const cooldownUntil = Math.max(
      topLoadCooldownUntilRef.current,
      topLoadPostReleaseCooldownUntilRef.current,
    );
    if (now < cooldownUntil) return;

    const cycleId = loadCycleCounterRef.current + 1;
    loadCycleCounterRef.current = cycleId;
    const requestId = `older-${cycleId}`;

    loadCycleInFlightRef.current = true;
    loadingOlderRef.current = true;
    topLoadArmedRef.current = false;
    topLoadCooldownUntilRef.current = now + TOP_LOAD_REARM_COOLDOWN_MS;

    if (topLoadRearmTimeoutRef.current != null) {
      window.clearTimeout(topLoadRearmTimeoutRef.current);
      topLoadRearmTimeoutRef.current = null;
    }

    shiftForceDisabledRef.current = false;
    eventsOnlyLateDriftGuardUntilRef.current = 0;
    eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
    setShiftActive(true);
    topLoadTransactionActiveRef.current = true;
    pendingShiftReleaseRef.current = {
      cycleId,
      requestId,
      baselineRenderableCount: renderableCount,
      baselineFirstRenderableKey,
      completionReason: null,
      messagesAdded: 0,
      eventsAdded: 0,
      estimatedRenderableGrowth: null,
      loadFinished: false,
      releaseQueued: false,
      releaseAnchorOffset: null,
      releaseAnchorDistanceFromTop: null,
    };

    debugLog("ChatMessageList", "chat.topLoad.started", {
      cycleId,
      requestId,
      baselineRenderableCount: renderableCount,
      baselineFirstRenderableKey,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
      ...readTopLoadState(),
    });

    try {
      const result = await onLoadOlderHistoryCurrent({ cycleId, requestId });
      const pending = pendingShiftReleaseRef.current;
      const isCurrentCyclePending =
        pending != null && pending.cycleId === cycleId && pending.requestId === requestId;

      if (isCurrentCyclePending && result) {
        pending.completionReason = result.completionReason ?? null;
        pending.messagesAdded = result.messagesAdded ?? 0;
        pending.eventsAdded = result.eventsAdded ?? 0;
        pending.estimatedRenderableGrowth = result.estimatedRenderableGrowth ?? null;
      }

      if (isCurrentCyclePending) {
        pending.loadFinished = true;

        const explicitNoGrowthResult = isExplicitNoGrowthResult({
          completionReason: pending.completionReason,
          estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
          messagesAdded: pending.messagesAdded,
          eventsAdded: pending.eventsAdded,
        });

        if (explicitNoGrowthResult) {
          pending.releaseQueued = true;
          requestAnimationFrame(() => {
            releaseShift("no-growth");
          });
        } else {
          const likelyNonPrependGrowth = pending.completionReason === "applied"
            && pending.messagesAdded <= 0
            && pending.eventsAdded > 0
            && pending.estimatedRenderableGrowth !== false;
          if (likelyNonPrependGrowth && headIdentityStable && !oldestRenderableHydrationPending) {
            const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
            pending.releaseAnchorOffset = releaseAnchorOffset;
            pending.releaseAnchorDistanceFromTop = releaseAnchorOffset;
            pending.releaseQueued = true;
            debugLog("ChatMessageList", "chat.topLoad.result", {
              cycleId,
              requestId,
              reason: "events-only-growth",
              completionReason: pending.completionReason,
              messagesAdded: pending.messagesAdded,
              eventsAdded: pending.eventsAdded,
              estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
              releaseAnchorOffset,
              headIdentityStable,
              oldestRenderableHydrationPending,
              ...readTopLoadState(),
            });
            releaseShift("events-only-growth");
          }
        }
      }
    } catch (error) {
      debugLog("ChatMessageList", "load-older-error", {
        cycleId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      releaseShift("load-error");
      throw error;
    } finally {
      loadCycleInFlightRef.current = false;
      loadingOlderRef.current = false;
      const pending = pendingShiftReleaseRef.current;
      const isCurrentCyclePending =
        pending != null && pending.cycleId === cycleId && pending.requestId === requestId;
      if (isCurrentCyclePending) {
        if (shiftReleaseTimeoutRef.current != null) {
          window.clearTimeout(shiftReleaseTimeoutRef.current);
        }
        shiftReleaseTimeoutRef.current = window.setTimeout(() => {
          shiftReleaseTimeoutRef.current = null;
          releaseShift("timeout-fallback");
        }, 220);
      }
      debugLog("ChatMessageList", "chat.topLoad.result", {
        cycleId,
        requestId,
        reason: "load-finished",
        completionReason: pending?.completionReason ?? null,
        messagesAdded: pending?.messagesAdded ?? null,
        eventsAdded: pending?.eventsAdded ?? null,
        estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
        ...readTopLoadState(),
      });
    }
  }, [readScrollSnapshot, releaseShift]);

  useEffect(() => {
    if (!atTop) {
      if (
        Date.now() >= topLoadCooldownUntilRef.current
        && Date.now() >= topLoadPostReleaseCooldownUntilRef.current
        && topLoadRearmTimeoutRef.current == null
      ) {
        topLoadArmedRef.current = true;
      }
      return;
    }

    if (!leftTopZoneRef.current) return;
    if (!hasOlderHistoryRef.current || loadingOlderHistoryPropRef.current || !onLoadOlderHistoryRef.current) return;
    if (!topPaginationInteractionReadyRef.current) {
      debugLog("ChatMessageList", "top-load-skipped", {
        reason: "interaction-not-ready",
        atTop,
        hasOlderHistory: hasOlderHistoryRef.current,
        loadingOlderHistory: loadingOlderHistoryPropRef.current,
      });
      return;
    }
    if (loadCycleInFlightRef.current || !topLoadArmedRef.current) return;

    topLoadArmedRef.current = false;
    leftTopZoneRef.current = false;
    const triggeredAt = new Date();
    const triggeredAtIso = triggeredAt.toISOString();
    const triggeredAtDisplay = triggeredAt.toLocaleString();

    debugLog("ChatMessageList", "chat.topLoad.triggered", {
      trigger: "user-scroll-top",
      hasOlderHistory: hasOlderHistoryRef.current,
      loadingOlderHistory: loadingOlderHistoryPropRef.current,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
      triggeredAtIso,
      triggeredAtDisplay,
      ...readTopLoadState(),
    });

    void loadOlder();
  }, [atTop, loadOlder]);

  useEffect(() => {
    return () => {
      shiftForceDisabledRef.current = true;
      shiftDeactivateTokenRef.current += 1;
      if (shiftReleaseTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseTimeoutRef.current);
        shiftReleaseTimeoutRef.current = null;
      }
      if (shiftReleaseAnchorWatchTimeoutRef.current != null) {
        window.clearTimeout(shiftReleaseAnchorWatchTimeoutRef.current);
        shiftReleaseAnchorWatchTimeoutRef.current = null;
      }
      if (shiftReleaseAnchorWatchRafRef.current != null) {
        window.cancelAnimationFrame(shiftReleaseAnchorWatchRafRef.current);
        shiftReleaseAnchorWatchRafRef.current = null;
      }
      pendingShiftAnchorRestoreRef.current = null;
      topLoadPostReleaseCooldownUntilRef.current = 0;
      eventsOnlyLateDriftGuardUntilRef.current = 0;
      eventsOnlyLateDriftRestoreCooldownUntilRef.current = 0;
      lastScrollGeometryRef.current = null;
      if (topLoadRearmTimeoutRef.current != null) {
        window.clearTimeout(topLoadRearmTimeoutRef.current);
        topLoadRearmTimeoutRef.current = null;
      }
    };
  }, []);

  function toggleRawOutput(messageId: string) {
    setRawOutputMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }

  function copyOutput(messageId: string, content: string) {
    if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
      return;
    }

    void navigator.clipboard.writeText(content);
    setCopiedMessageId(messageId);
    setTimeout(() => {
      setCopiedMessageId((current) => (current === messageId ? null : current));
    }, 1200);
  }

  async function copyDebugLog() {
    const copied = await copyRenderDebugLog();
    setCopiedDebug(copied);
    if (!copied) {
      return;
    }
    setTimeout(() => {
      setCopiedDebug(false);
    }, 1200);
  }

  const timelineCtx = useMemo<TimelineCtx>(
    () => ({
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      toggleRawOutput,
      copyOutput,
      copyDebugLog,
      onOpenReadFile,
      bashExpandedById,
      setBashExpandedById,
      editedExpandedById,
      setEditedExpandedById,
      exploreActivityExpandedById,
      setExploreActivityExpandedById,
      subagentExpandedById,
      setSubagentExpandedById,
      subagentPromptExpandedById,
      setSubagentPromptExpandedById,
      subagentExploreExpandedById,
      setSubagentExploreExpandedById,
      lastRenderSignatureByMessageIdRef,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      onOpenReadFile,
      bashExpandedById,
      editedExpandedById,
      exploreActivityExpandedById,
      subagentExpandedById,
      subagentPromptExpandedById,
      subagentExploreExpandedById,
    ],
  );

  const effectiveShiftActive = topLoadTransactionActiveRef.current
    || (shiftActive
      && !shiftForceDisabledRef.current
      && pendingShiftAnchorRestoreRef.current != null);

  return (
    <div
      ref={scrollWrapperRef}
      className="relative h-full min-h-0"
      data-testid="chat-scroll"
      onWheelCapture={markUserScrollIntent}
      onTouchStartCapture={markUserScrollIntent}
      onTouchMoveCapture={markUserScrollIntent}
      onPointerDownCapture={markUserScrollIntent}
    >
      {items.length === 0 && !showThinkingPlaceholder ? (
        <div className="py-10 text-center text-xs text-muted-foreground">No messages yet. Send a prompt to start.</div>
      ) : (
        <VList
          ref={vlistRef}
          shift={effectiveShiftActive}
          itemSize={50}
          style={{ height: "100%", overflowAnchor: "none" }}
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
        >
          {displayItems.map((item) => {
            if (item === "thinking-placeholder") {
              return (
                <div key="thinking-placeholder" className="mx-auto max-w-3xl px-3 pb-4">
                  <ThinkingPlaceholder />
                </div>
              );
            }
            return (
              <div key={getTimelineItemKey(item)} className="mx-auto max-w-3xl px-3 pb-4">
                <TimelineItem item={item} ctx={timelineCtx} />
              </div>
            );
          })}
        </VList>
      )}
    </div>
  );
}
