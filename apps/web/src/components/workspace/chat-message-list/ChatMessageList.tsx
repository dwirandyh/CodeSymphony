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

export function ChatMessageList({
  items,
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
    armedScrollSize?: number | null;
  } | null>(null);
  const pendingShiftRestoreFrameRef = useRef(false);
  const shiftPendingVisibilityHideRef = useRef(false);
  const shiftBaselineDfbRef = useRef<number | null>(null);
  // #region agent log
  const prePaginationDomGeoRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const frameTrackerActiveRef = useRef(false);
  const visualTrackerRafRef = useRef<number | null>(null);
  const visualTrackerActiveRef = useRef(false);
  const visualTrackerLastScrollTimeRef = useRef(0);
  const scrollJumpCompensationActiveRef = useRef(false);
  // #endregion
  const scrollFreezeActiveRef = useRef(false);
  const scrollFreezeCleanupRef = useRef<(() => void) | null>(null);
  const remeasureSettledCountRef = useRef(0);
  const remeasureSettledTimerRef = useRef<number | null>(null);

  const freezeScrollInertia = useCallback(() => {
    if (scrollFreezeActiveRef.current) return;
    scrollFreezeActiveRef.current = true;
    scrollFreezeCleanupRef.current = () => {
      scrollFreezeActiveRef.current = false;
      scrollFreezeCleanupRef.current = null;
    };
    // #region agent log
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:freezeScrollInertia',message:'freeze flag set',data:{},timestamp:Date.now(),hypothesisId:'H20'})}).catch(()=>{});
    // #endregion
  }, []);

  const unfreezeScrollInertia = useCallback(() => {
    if (!scrollFreezeActiveRef.current) return;
    scrollFreezeCleanupRef.current?.();
    // #region agent log
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:unfreezeScrollInertia',message:'scroll inertia unfrozen',data:{},timestamp:Date.now(),hypothesisId:'H15'})}).catch(()=>{});
    // #endregion
  }, []);

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
    // #region agent log
    const clrHandle = vlistRef.current;
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:clearPendingShiftAnchor',message:'clearing shift anchor',data:{scrollOffset:clrHandle?.scrollOffset,scrollSize:clrHandle?.scrollSize,viewportSize:clrHandle?.viewportSize,hadAnchor:pendingShiftAnchorRestoreRef.current!=null,suppressRestore:pendingShiftAnchorRestoreRef.current?.suppressRestore},timestamp:Date.now(),hypothesisId:'H7'})}).catch(()=>{});
    // #endregion
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

    debugLog("ChatMessageList", "load-older-release-shift", {
      reason,
      cycleId: pending?.cycleId ?? null,
      requestId: pending?.requestId ?? null,
      completionReason: pending?.completionReason ?? null,
      messagesAdded: pending?.messagesAdded ?? null,
      eventsAdded: pending?.eventsAdded ?? null,
      estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
      releaseAnchorOffset: anchorOffset,
      releaseAnchorDistanceFromTop: anchorDistanceFromTop,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
    });

    const shouldArmAnchorRestore = true;
    if (shouldArmAnchorRestore && anchorOffset != null && anchorDistanceFromTop != null) {
      // #region agent log
      const rlsHandle = vlistRef.current;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:releaseShift-arm-anchor',message:'arming anchor restore',data:{reason,anchorOffset,anchorDistFromTop:anchorDistanceFromTop,currentOffset:rlsHandle?.scrollOffset,currentScrollSize:rlsHandle?.scrollSize,lockMs:TOP_LOAD_RELEASE_ANCHOR_LOCK_MS,watchMs:TOP_LOAD_RELEASE_ANCHOR_WATCH_MS},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
      // #endregion
      pendingShiftAnchorRestoreRef.current = {
        reason,
        targetOffset: anchorOffset,
        releaseAnchorDistanceFromTop: anchorDistanceFromTop,
        armedScrollSize: rlsHandle?.scrollSize ?? null,
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
            debugLog("ChatMessageList", "load-older-release-anchor-restore", {
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
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
            });
            // #region agent log
            fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:rAF-anchor-scrollTo',message:'rAF anchor restore scrollTo',data:{from:currentOffset,to:pendingRestore.targetOffset,delta,scrollSize:handle.scrollSize,viewportSize:handle.viewportSize},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
            // #endregion
            handle.scrollTo(pendingRestore.targetOffset);
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
        // #region agent log
        const deactHandle = vlistRef.current;
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:shift-deactivate-timer',message:'shift deactivate timer fired',data:{reason,delayMs:shiftDeactivateDelayMs,token:nextToken,scrollOffset:deactHandle?.scrollOffset,scrollSize:deactHandle?.scrollSize,viewportSize:deactHandle?.viewportSize,pendingAnchor:pendingShiftAnchorRestoreRef.current!=null},timestamp:Date.now(),hypothesisId:'H7'})}).catch(()=>{});
        // #endregion
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
    renderableFirstKeyRef.current = firstRenderableKey;
  }, [firstRenderableKey, renderableItems.length]);

  // #region agent log — continuous visual position tracker (H10/H11)
  useEffect(() => {
    const wrapper = scrollWrapperRef.current;
    if (!wrapper) return;

    let prevSt = 0;
    let prevSh = 0;
    let prevItemTops: number[] = [];
    let idleFrames = 0;
    let rafId: number | null = null;
    let started = false;

    const tick = () => {
      const scroller = wrapper.firstElementChild as HTMLElement | null;
      if (!scroller) { rafId = requestAnimationFrame(tick); return; }

      if (!started) {
        started = true;
        prevSt = scroller.scrollTop;
        prevSh = scroller.scrollHeight;
      }

      const st = scroller.scrollTop;
      const sh = scroller.scrollHeight;
      const stDelta = st - prevSt;
      const shDelta = sh - prevSh;

      const children = scroller.children;
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleItems: { idx: number; top: number }[] = [];
      for (let i = 0; i < children.length; i++) {
        const r = children[i].getBoundingClientRect();
        if (r.bottom > scrollerRect.top && r.top < scrollerRect.bottom) {
          visibleItems.push({ idx: i, top: r.top - scrollerRect.top });
        }
      }

      let maxItemShift = 0;
      if (prevItemTops.length > 0 && visibleItems.length > 0) {
        for (const vi of visibleItems) {
          const prevTop = prevItemTops[vi.idx];
          if (prevTop !== undefined) {
            const itemVisualDelta = (vi.top - prevTop) + stDelta;
            if (Math.abs(itemVisualDelta) > Math.abs(maxItemShift)) {
              maxItemShift = itemVisualDelta;
            }
          }
        }
      }

      const hasSignificant = Math.abs(stDelta) > 50 || Math.abs(shDelta) > 50 || Math.abs(maxItemShift) > 15;

      if (hasSignificant) {
        idleFrames = 0;
        const sample = visibleItems.slice(0, 3).map(v => ({ i: v.idx, t: Math.round(v.top) }));
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:visual-tracker',message:'vt',data:{st:Math.round(st),sh:Math.round(sh),stD:Math.round(stDelta),shD:Math.round(shDelta),mis:Math.round(maxItemShift),vis:sample,nVis:visibleItems.length},timestamp:Date.now(),hypothesisId:'H10'})}).catch(()=>{});
      } else if (stDelta !== 0 || shDelta !== 0) {
        idleFrames = 0;
      } else {
        idleFrames++;
      }

      const newTops: number[] = [];
      for (const vi of visibleItems) { newTops[vi.idx] = vi.top; }
      prevItemTops = newTops;
      prevSt = st;
      prevSh = sh;

      if (idleFrames < 600) {
        rafId = requestAnimationFrame(tick);
      } else {
        visualTrackerActiveRef.current = false;
      }
    };

    visualTrackerActiveRef.current = true;
    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      visualTrackerActiveRef.current = false;
    };
  }, []);
  // #endregion

  const prevDisplayCountRef = useRef(displayItems.length);
  useLayoutEffect(() => {
    const prevCount = prevDisplayCountRef.current;
    if (displayItems.length !== prevCount) {
      lastItemCountChangeRef.current = Date.now();
      prevDisplayCountRef.current = displayItems.length;
      // #region agent log
      const leH = vlistRef.current;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:layoutEffect-items-changed',message:'displayItems count changed',data:{prevCount,newCount:displayItems.length,delta:displayItems.length-prevCount,scrollOffset:leH?.scrollOffset,scrollSize:leH?.scrollSize,viewportSize:leH?.viewportSize,shiftActive,topLoadTxActive:topLoadTransactionActiveRef.current,effectiveShift:topLoadTransactionActiveRef.current||(shiftActive&&!shiftForceDisabledRef.current&&pendingShiftAnchorRestoreRef.current!=null)},timestamp:Date.now(),hypothesisId:'H2'})}).catch(()=>{});
      if (displayItems.length > prevCount && !frameTrackerActiveRef.current) {
        const ftContainer = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
        if (ftContainer) {
          frameTrackerActiveRef.current = true;
          const preGeo = prePaginationDomGeoRef.current;
          prePaginationDomGeoRef.current = null;
          const leScrollTop = ftContainer.scrollTop;
          const leScrollHeight = ftContainer.scrollHeight;
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:frame-track-init',message:'frame tracker start (layoutEffect)',data:{preScrollTop:preGeo?.scrollTop??null,preScrollHeight:preGeo?.scrollHeight??null,leScrollTop,leScrollHeight,heightGrowth:preGeo?leScrollHeight-preGeo.scrollHeight:null,topShift:preGeo?leScrollTop-preGeo.scrollTop:null,itemDelta:displayItems.length-prevCount},timestamp:Date.now(),hypothesisId:'H8'})}).catch(()=>{});
          let prevFt = leScrollTop;
          let prevFh = leScrollHeight;
          let fi = 0;
          const trackFrame = () => {
            if (fi > 25) { frameTrackerActiveRef.current = false; return; }
            const ct = ftContainer.scrollTop;
            const ch = ftContainer.scrollHeight;
            const td = ct - prevFt;
            const hd = ch - prevFh;
            fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:frame-track',message:'frame '+fi,data:{f:fi,scrollTop:ct,scrollHeight:ch,topDelta:td,heightDelta:hd,visualShift:hd-td,cumTopFromPre:preGeo?ct-preGeo.scrollTop:null,cumHeightFromPre:preGeo?ch-preGeo.scrollHeight:null},timestamp:Date.now(),hypothesisId:'H8'})}).catch(()=>{});
            prevFt = ct;
            prevFh = ch;
            fi++;
            requestAnimationFrame(trackFrame);
          };
          requestAnimationFrame(trackFrame);
        }
      }
      // #endregion
    }

    if (shiftPendingVisibilityHideRef.current && displayItems.length > prevCount) {
      shiftPendingVisibilityHideRef.current = false;
      const wrapper = scrollWrapperRef.current;
      if (wrapper) {
        const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
        if (scrollerEl) {
          scrollerEl.style.visibility = "hidden";
          // #region agent log
          const h = vlistRef.current;
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:layoutEffect-hide',message:'hiding scroller before paint',data:{prevCount,newCount:displayItems.length,scrollSize:h?.scrollSize,offset:h?.scrollOffset,viewportSize:h?.viewportSize},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
          // #endregion
          requestAnimationFrame(() => {
            if (scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
              const pendingAnchor = pendingShiftAnchorRestoreRef.current;
              if (pendingAnchor && !pendingAnchor.suppressRestore) {
                pendingAnchor.suppressRestore = true;
              }
              // #region agent log
              fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:layoutEffect-rAF-fallback',message:'rAF fallback unhide',data:{},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
              // #endregion
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
          // #region agent log
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
          // #endregion
          if (pendingAnchorRestore?.suppressRestore) {
            // Shift mode is handling visual stability; skip all restore logic.
          } else {
            const movedAwayFromTopDuringEventsGrowth = pendingAnchorRestore.reason === "events-only-growth"
              && currentOffset > pendingAnchorRestore.targetOffset + TOP_LOAD_RELEASE_ANCHOR_TOLERANCE_PX;
            if (movedAwayFromTopDuringEventsGrowth && !topLoadTransactionActiveRef.current) {
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
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
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
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
              debugLog("ChatMessageList", "load-older-release-anchor-restore", {
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
              handle.scrollTo(pendingAnchorRestore.targetOffset);
              return;
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
    const firstKeyChanged = firstRenderableKey !== pending.baselineFirstRenderableKey;
    const prependCommitted = firstKeyChanged;
    const nonPrependGrowth = renderableGrew && !firstKeyChanged;
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

    const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
    const releaseAnchorDistanceFromTop = releaseAnchorOffset;
    pending.releaseAnchorOffset = releaseAnchorOffset;
    pending.releaseAnchorDistanceFromTop = releaseAnchorDistanceFromTop;

    debugLog("ChatMessageList", "load-older-prepend-eval", {
      cycleId: pending.cycleId,
      requestId: pending.requestId,
      renderableCount: renderableItems.length,
      baselineRenderableCount: pending.baselineRenderableCount,
      firstRenderableKey,
      baselineFirstRenderableKey: pending.baselineFirstRenderableKey,
      prependCommitted,
      nonPrependGrowth,
      noGrowthFinal,
      completionReason: pending.completionReason,
      messagesAdded: pending.messagesAdded,
      eventsAdded: pending.eventsAdded,
      estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
      releaseAnchorOffset,
      releaseAnchorDistanceFromTop,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      shiftActive,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
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
    firstRenderableKey,
    readScrollSnapshot,
    releaseShift,
    renderableItems.length,
    shiftActive,
  ]);

  const handleScroll = useCallback((offset: number) => {
    const handle = vlistRef.current;
    if (!handle) return;

    const { scrollSize, viewportSize } = handle;
    const maxScroll = scrollSize - viewportSize;
    const prevGeometry = lastScrollGeometryRef.current;

    // #region agent log
    const shiftJustFired = prevGeometry && Math.abs(offset - prevGeometry.offset) > 200;
    const recentShift = prevGeometry && prevGeometry.scrollSize > 5500 && scrollSize > 5500;
    const scrollSizeChanged = prevGeometry && Math.abs(scrollSize - prevGeometry.scrollSize) > 1;
    const inAnchorWindow = pendingShiftAnchorRestoreRef.current != null;
    const scrollSizeDelta = prevGeometry ? scrollSize - prevGeometry.scrollSize : 0;
    if (offset <= 500 || shiftJustFired || recentShift || scrollSizeChanged || inAnchorWindow) {
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-track',message:'scroll track',data:{offset,prevOffset:prevGeometry?.offset??null,jumpDelta:prevGeometry?offset-prevGeometry.offset:null,scrollSize,scrollSizeDelta,viewportSize,maxScroll,shiftTxActive:topLoadTransactionActiveRef.current,pendingAnchor:inAnchorWindow,pendingAnchorTarget:pendingShiftAnchorRestoreRef.current?.targetOffset??null,driftGuardActive:Date.now()<=eventsOnlyLateDriftGuardUntilRef.current,scrollSizeChanged:!!scrollSizeChanged,shiftActive},timestamp:Date.now(),hypothesisId:'H6'})}).catch(()=>{});
    }
    if (scrollSizeChanged && Math.abs(scrollSizeDelta) > 50 && !inAnchorWindow) {
      const ftC = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
      const innerEl = ftC?.firstElementChild as HTMLElement | null;
      const innerStyle = innerEl ? (innerEl.style.top || innerEl.style.transform || '') : '';
      const innerRect = innerEl?.getBoundingClientRect();
      const parentRect = ftC?.getBoundingClientRect();
      const innerVisualTop = innerRect && parentRect ? innerRect.top - parentRect.top : null;
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-remeasure',message:'remeasure event',data:{offset,prevOffset:prevGeometry?.offset??null,jumpDelta:prevGeometry?offset-prevGeometry.offset:null,scrollSize,scrollSizeDelta,innerStyle,innerVisualTop},timestamp:Date.now(),hypothesisId:'H10'})}).catch(()=>{});
    }
    // #endregion

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

          // #region agent log
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:jump-hide',message:'hiding inner for remeasure',data:{jumpDelta,sizeDelta},timestamp:Date.now(),hypothesisId:'H13'})}).catch(()=>{});
          // #endregion

          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              innerContainer.style.visibility = "";
              scrollJumpCompensationActiveRef.current = false;
              // #region agent log
              fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:jump-reveal',message:'revealing inner after re-render',data:{},timestamp:Date.now(),hypothesisId:'H13'})}).catch(()=>{});
              // #endregion
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
        // #region agent log
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
          // #region agent log
          fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-shift-suppress',message:'shift growth: suppress restore, let VList shift handle remeasurement',data:{oldTarget:pendingAnchorRestore.targetOffset,sizeDelta:sizeDeltaForAnchorAdj,offsetDelta:offsetDeltaForAnchorAdj,offset,prevOffset:prevGeometry.offset},timestamp:Date.now(),hypothesisId:'FIX4'})}).catch(()=>{});
          // #endregion
          const wrapper = scrollWrapperRef.current;
          if (wrapper) {
            const scrollerEl = wrapper.firstElementChild as HTMLElement | null;
            if (scrollerEl && scrollerEl.style.visibility === "hidden") {
              scrollerEl.style.visibility = "";
            }
          }
        }
        // #endregion
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
            debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
              reason: pendingAnchorRestore.reason,
              cancelMode: "events-growth-away-from-top",
              targetOffset: pendingAnchorRestore.targetOffset,
              fromOffset: offset,
              deltaFromTarget: Math.abs(offset - pendingAnchorRestore.targetOffset),
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
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
              debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
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
                debugLog("ChatMessageList", "load-older-release-anchor-cancelled", {
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
                  debugLog("ChatMessageList", "load-older-release-anchor-restore", {
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
                  // #region agent log
                  fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-anchor-scrollTo',message:'handleScroll anchor restore scrollTo',data:{from:offset,to:pendingAnchorRestore.targetOffset,reason:pendingAnchorRestore.reason,scrollSize,maxScroll},timestamp:Date.now(),hypothesisId:'H3'})}).catch(()=>{});
                  // #endregion
                  handle.scrollTo(pendingAnchorRestore.targetOffset);
                  return;
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
        // #region agent log
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:lateDriftGuard-scrollTo',message:'late drift guard scrollTo',data:{from:offset,to:prevGeometry.offset,offsetDelta,guardUntil:eventsOnlyLateDriftGuardUntilRef.current,recentUserIntent:now-lastUserScrollIntentAtRef.current},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
        // #endregion
        handle.scrollTo(prevGeometry.offset);
        return;
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
        debugLog("ChatMessageList", "scroll-geometry-update", {
          offset,
          scrollSize,
          viewportSize,
          maxScroll,
          distanceFromTop: Math.max(offset, 0),
          distanceFromBottom: Math.max(maxScroll - offset, 0),
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
          shiftActive: topLoadTransactionActiveRef.current,
          pendingShiftRestore: pendingShiftAnchorRestoreRef.current != null,
          pendingShiftRestoreFrame: pendingShiftRestoreFrameRef.current,
          topLoadPostReleaseCooldownUntil: topLoadPostReleaseCooldownUntilRef.current,
          eventsOnlyLateDriftGuardUntil: eventsOnlyLateDriftGuardUntilRef.current,
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          stickyBottom: stickyBottomRef.current,
        });
      }
    }

    if (contentGrew && stickyBottomRef.current && !isAtBottom && viewportSize > 0) {
      if (topLoadTransactionActiveRef.current) {
        debugLog("ChatMessageList", "sticky-bottom-correction-skipped", {
          reason: "top-load-transaction-active",
          offset,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          shiftActive: topLoadTransactionActiveRef.current,
          stickyBottom: stickyBottomRef.current,
        });
      } else {
        debugLog("ChatMessageList", "sticky-bottom-correction-applied", {
          reason: "content-grew-while-sticky",
          offset,
          beforeScrollOffset: handle.scrollOffset,
          targetScrollOffset: maxScroll,
          ...readScrollSnapshot(),
          atTop: atTopRef.current,
          atBottom: atBottomRef.current,
          shiftActive: topLoadTransactionActiveRef.current,
          stickyBottom: stickyBottomRef.current,
        });
        handle.scrollTo(maxScroll);
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
      // #region agent log
      fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:handleScroll-atTop-change',message:'atTop transition',data:{from:atTopRef.current,to:isAtTop,offset,scrollSize,viewportSize,maxScroll,shiftActive:topLoadTransactionActiveRef.current},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
      // #endregion
      if (!isAtTop) {
        leftTopZoneRef.current = true;
      }
      atTopRef.current = isAtTop;
      setAtTop(isAtTop);
    }
  }, []);

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
  const stickyBottomRef = useRef(true);
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
          h.scrollTo(targetOff);
        }
        // #region agent log
        fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0a3070'},body:JSON.stringify({sessionId:'0a3070',location:'ChatMessageList.tsx:scrollEnd-correction',message:'scrollEnd drift correction',data:{baselineDfb,correction,targetOff,currentOffset:curOff},timestamp:Date.now(),hypothesisId:'H22A'})}).catch(()=>{});
        // #endregion
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
      debugLog("ChatMessageList", "sticky-bottom-correction-applied", {
        reason: "scroll-end-not-at-bottom",
        beforeScrollOffset: scrollOffset,
        targetScrollOffset: maxScroll,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        shiftActive: topLoadTransactionActiveRef.current,
        stickyBottom: stickyBottomRef.current,
      });
      h.scrollTo(maxScroll);
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

  useEffect(() => {
    debugLog("ChatMessageList", "list-state", {
      itemCount: displayItems.length,
      renderableCount: renderableItems.length,
      loadingOlderHistory,
      hasOlderHistory,
      topPaginationInteractionReady,
      atTop,
      atBottom,
      shiftActive,
      effectiveShiftActive: topLoadTransactionActiveRef.current
        || (shiftActive
          && !shiftForceDisabledRef.current
          && pendingShiftAnchorRestoreRef.current != null),
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
      ...readScrollSnapshot(),
      stickyBottom: stickyBottomRef.current,
      leftTopZone: leftTopZoneRef.current,
      topLoadArmed: topLoadArmedRef.current,
      topLoadCooldownUntil: topLoadCooldownUntilRef.current,
      pendingShiftRestore: pendingShiftAnchorRestoreRef.current != null,
      pendingShiftRestoreFrame: pendingShiftRestoreFrameRef.current,
      shiftForceDisabled: shiftForceDisabledRef.current,
      topLoadPostReleaseCooldownUntil: topLoadPostReleaseCooldownUntilRef.current,
      eventsOnlyLateDriftGuardUntil: eventsOnlyLateDriftGuardUntilRef.current,
    });
  }, [
    atBottom,
    atTop,
    hasOlderHistory,
    topPaginationInteractionReady,
    displayItems.length,
    loadingOlderHistory,
    readScrollSnapshot,
    renderableItems.length,
    shiftActive,
  ]);

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
    // #region agent log
    const preShiftHandle = vlistRef.current;
    fetch('http://127.0.0.1:7409/ingest/eaaa0f37-f591-4ab7-b144-0dd9e5e2527b',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6c0c5f'},body:JSON.stringify({sessionId:'6c0c5f',location:'ChatMessageList.tsx:loadOlder-pre-shift',message:'about to enable shift',data:{scrollOffset:preShiftHandle?.scrollOffset,scrollSize:preShiftHandle?.scrollSize,viewportSize:preShiftHandle?.viewportSize,cycleId,renderableCount},timestamp:Date.now(),hypothesisId:'H1'})}).catch(()=>{});
    const prePagContainer = scrollWrapperRef.current?.firstElementChild as HTMLElement | null;
    if (prePagContainer) {
      prePaginationDomGeoRef.current = { scrollTop: prePagContainer.scrollTop, scrollHeight: prePagContainer.scrollHeight };
    }
    // #endregion
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

    debugLog("ChatMessageList", "load-older-start", {
      cycleId,
      requestId,
      renderableCount,
      baselineFirstRenderableKey,
      ...readScrollSnapshot(),
      atTop: atTopRef.current,
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
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
          if (likelyNonPrependGrowth) {
            const releaseAnchorOffset = (vlistRef.current?.scrollOffset ?? null);
            pending.releaseAnchorOffset = releaseAnchorOffset;
            pending.releaseAnchorDistanceFromTop = releaseAnchorOffset;
            pending.releaseQueued = true;
            debugLog("ChatMessageList", "load-older-preemptive-release", {
              cycleId,
              requestId,
              reason: "events-only-growth",
              completionReason: pending.completionReason,
              messagesAdded: pending.messagesAdded,
              eventsAdded: pending.eventsAdded,
              estimatedRenderableGrowth: pending.estimatedRenderableGrowth,
              releaseAnchorOffset,
              ...readScrollSnapshot(),
              atTop: atTopRef.current,
              atBottom: atBottomRef.current,
              stickyBottom: stickyBottomRef.current,
              topLoadTransactionActive: topLoadTransactionActiveRef.current,
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
      debugLog("ChatMessageList", "load-older-finished", {
        cycleId,
        requestId,
        completionReason: pending?.completionReason ?? null,
        messagesAdded: pending?.messagesAdded ?? null,
        eventsAdded: pending?.eventsAdded ?? null,
        estimatedRenderableGrowth: pending?.estimatedRenderableGrowth ?? null,
        ...readScrollSnapshot(),
        atTop: atTopRef.current,
        atBottom: atBottomRef.current,
        stickyBottom: stickyBottomRef.current,
        topLoadTransactionActive: topLoadTransactionActiveRef.current,
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

    debugLog("ChatMessageList", "top-trigger-load-older", {
      trigger: "user-scroll-top",
      atTop,
      hasOlderHistory: hasOlderHistoryRef.current,
      loadingOlderHistory: loadingOlderHistoryPropRef.current,
      topPaginationInteractionReady: topPaginationInteractionReadyRef.current,
      triggeredAtIso,
      triggeredAtDisplay,
      ...readScrollSnapshot(),
      atBottom: atBottomRef.current,
      stickyBottom: stickyBottomRef.current,
      topLoadTransactionActive: topLoadTransactionActiveRef.current,
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
