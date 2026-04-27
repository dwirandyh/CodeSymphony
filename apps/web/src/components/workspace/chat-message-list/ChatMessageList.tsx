import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { History, Loader2, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { isRenderDebugEnabled, copyRenderDebugLog } from "../../../lib/renderDebug";
import { debugLog } from "../../../lib/debugLog";
import { VList, type CacheSnapshot, type VListHandle } from "virtua";
import type {
  ChatMessageListEmptyState,
  ChatMessageListProps,
  ChatTimelineItem,
  TimelineCtx,
} from "./ChatMessageList.types";
import { getTimelineItemKey } from "./toolEventUtils";
import { TimelineItem, ThinkingPlaceholder } from "./TimelineItem";

const AT_BOTTOM_THRESHOLD = 64;
const AUTO_FOLLOW_SETTLE_BOTTOM_THRESHOLD = 120;
const MIN_LOAD_OLDER_HISTORY_THRESHOLD = 240;
const MAX_LOAD_OLDER_HISTORY_THRESHOLD = 720;
const LOAD_OLDER_HISTORY_THRESHOLD_VIEWPORT_RATIO = 1.25;
const LOAD_OLDER_HISTORY_EARLY_TRIGGER_OFFSET = 240;
const LOAD_OLDER_HISTORY_REARM_OFFSET = 200;
const VLIST_BUFFER_SIZE = 720;
const VLIST_EDGE_KEEP_MOUNT_COUNT = 6;
const THREAD_PAGINATION_SCROLL_SAMPLE_PX = 40;
const AUTO_FOLLOW_MEASUREMENT_RETRY_LIMIT = 6;

type ThreadListCacheEntry = {
  itemCount: number;
  cache: CacheSnapshot;
  signature: string;
  scrollOffset: number;
  scrollSize: number;
  viewportSize: number;
};

function roundScrollMetric(value: number | null | undefined): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  return Math.round(value * 10) / 10;
}

function summarizeTimelineEdges(items: ChatTimelineItem[]) {
  const first = items[0] ?? null;
  const last = items[items.length - 1] ?? null;

  return {
    firstKey: first ? getTimelineItemKey(first) : null,
    firstKind: first?.kind ?? null,
    lastKey: last ? getTimelineItemKey(last) : null,
    lastKind: last?.kind ?? null,
  };
}

function buildThreadCacheSignature(params: {
  threadId: string | null;
  displayItemCount: number;
  firstKey: string | null;
  lastKey: string | null;
  showOlderHistoryLoadingRow: boolean;
  showThinkingPlaceholder: boolean;
  shouldRenderFooter: boolean;
}) {
  return [
    params.threadId ?? "no-thread",
    params.displayItemCount,
    params.firstKey ?? "none",
    params.lastKey ?? "none",
    params.showOlderHistoryLoadingRow ? "older-loading" : "steady-head",
    params.showThinkingPlaceholder ? "thinking" : "steady",
    params.shouldRenderFooter ? "footer" : "no-footer",
  ].join(":");
}

function buildScrollMetrics(handle: VListHandle | null, offset: number) {
  const scrollSize = handle?.scrollSize ?? null;
  const viewportSize = handle?.viewportSize ?? null;
  const distanceFromBottom =
    typeof scrollSize === "number" && typeof viewportSize === "number"
      ? scrollSize - viewportSize - offset
      : null;

  return {
    offset: roundScrollMetric(offset),
    scrollSize: roundScrollMetric(scrollSize),
    viewportSize: roundScrollMetric(viewportSize),
    distanceFromBottom: roundScrollMetric(distanceFromBottom),
  };
}

function getViewportElement(container: HTMLDivElement | null) {
  const viewport = container?.firstElementChild;
  return viewport instanceof HTMLDivElement ? viewport : null;
}

function getEffectiveScrollSnapshot(
  handle: VListHandle | null,
  container: HTMLDivElement | null,
  offsetOverride?: number,
) {
  const viewport = getViewportElement(container);
  const hasInvalidHandleMeasurement =
    handle != null
    && ((handle.viewportSize ?? 0) <= 0 || (handle.scrollSize ?? 0) <= 0);
  const offset =
    typeof offsetOverride === "number"
      ? offsetOverride
      : hasInvalidHandleMeasurement
        ? viewport?.scrollTop ?? handle?.scrollOffset ?? 0
        : handle?.scrollOffset ?? viewport?.scrollTop ?? 0;
  const scrollSize = Math.max(handle?.scrollSize ?? 0, viewport?.scrollHeight ?? 0);
  const viewportSize = Math.max(handle?.viewportSize ?? 0, viewport?.clientHeight ?? 0);

  return {
    viewport,
    offset,
    scrollSize,
    viewportSize,
  };
}

function buildVirtualDomMetrics(container: HTMLDivElement | null) {
  const viewport = getViewportElement(container);
  const content = viewport?.firstElementChild;

  return {
    viewportChildCount: viewport?.childElementCount ?? null,
    contentChildCount: content?.childElementCount ?? null,
    viewportClientHeight: viewport instanceof HTMLElement ? roundScrollMetric(viewport.clientHeight) : null,
    viewportScrollHeight: viewport instanceof HTMLElement ? roundScrollMetric(viewport.scrollHeight) : null,
    contentHeight: content instanceof HTMLElement ? roundScrollMetric(content.getBoundingClientRect().height) : null,
  };
}

function clampScrollOffset(offset: number, scrollSize: number, viewportSize: number) {
  if (!Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(0, Math.min(offset, Math.max(0, scrollSize - viewportSize)));
}

function clampLoadOlderHistoryThreshold(viewportSize: number | null | undefined) {
  if (typeof viewportSize !== "number" || !Number.isFinite(viewportSize) || viewportSize <= 0) {
    return MIN_LOAD_OLDER_HISTORY_THRESHOLD;
  }

  return Math.max(
    MIN_LOAD_OLDER_HISTORY_THRESHOLD,
    Math.min(
      MAX_LOAD_OLDER_HISTORY_THRESHOLD,
      Math.round(viewportSize * LOAD_OLDER_HISTORY_THRESHOLD_VIEWPORT_RATIO),
    ),
  );
}

function getLoadOlderHistoryThreshold(
  handle: VListHandle | null,
  container: HTMLDivElement | null,
  offsetOverride?: number,
) {
  const { viewportSize } = getEffectiveScrollSnapshot(handle, container, offsetOverride);
  return clampLoadOlderHistoryThreshold(viewportSize);
}

function getLoadOlderHistoryTriggerThreshold(
  loadOlderHistoryThreshold: number,
  movingTowardTop: boolean,
) {
  return movingTowardTop
    ? loadOlderHistoryThreshold + LOAD_OLDER_HISTORY_EARLY_TRIGGER_OFFSET
    : loadOlderHistoryThreshold;
}

function getLoadOlderHistoryRearmThreshold(loadOlderHistoryThreshold: number) {
  return loadOlderHistoryThreshold + Math.max(
    LOAD_OLDER_HISTORY_REARM_OFFSET,
    LOAD_OLDER_HISTORY_EARLY_TRIGGER_OFFSET,
  );
}

function LoadingThreadSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-3 py-4"
      data-testid="loading-thread-skeleton"
    >
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={`loading-thread-skeleton-${index}`}
          className={`flex ${index % 2 === 0 ? "justify-start" : "justify-end"}`}
        >
          <div className="w-full max-w-[85%] space-y-2 rounded-2xl px-3 py-2">
            <div className="h-3 w-20 animate-pulse rounded-full bg-muted/70" />
            <div className="space-y-1.5">
              <div className="h-3 w-full animate-pulse rounded-full bg-muted/60" />
              <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted/50" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OlderHistoryLoadingRow() {
  return (
    <article className="flex w-full justify-start" data-testid="older-history-loading-row">
      <div className="w-full rounded-2xl border border-border/50 bg-background/65 px-3 py-3 shadow-sm backdrop-blur-sm">
        <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading older messages
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-3/5 animate-pulse rounded-full bg-muted/55" />
          <div className="h-3 w-full animate-pulse rounded-full bg-muted/45" />
          <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted/35" />
        </div>
      </div>
    </article>
  );
}

function EmptyStateCard({ state }: { state: ChatMessageListEmptyState }) {
  if (state === "loading-thread") {
    return <LoadingThreadSkeleton />;
  }

  const content = (() => {
    switch (state) {
      case "no-thread-selected":
        return {
          icon: MessagesSquare,
          title: "Select a thread",
          description: "Open an existing thread or create a new one to continue.",
          iconClassName: "",
        };
      case "creating-thread":
        return {
          icon: Loader2,
          title: "Preparing a new thread",
          description: "Creating the first thread for this workspace...",
          iconClassName: "animate-spin",
        };
      case "new-thread-empty":
        return {
          icon: MessageSquarePlus,
          title: "New thread ready",
          description: "Start with a task, bug, or question so the assistant has clear context.",
          iconClassName: "",
        };
      case "existing-thread-empty":
        return {
          icon: MessagesSquare,
          title: "This thread is empty",
          description: "No messages have been sent in this thread yet.",
          iconClassName: "",
        };
      default:
        return {
          icon: History,
          title: "Loading thread history",
          description: "Fetching previous messages and activity for this thread...",
          iconClassName: "animate-pulse",
        };
    }
  })();
  const Icon = content.icon;

  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-8 w-8 items-center justify-center text-muted-foreground/80">
          <Icon className={`h-4 w-4 ${content.iconClassName}`.trim()} />
        </div>
        <div className="mt-3 space-y-1">
          <h2 className="text-sm font-medium tracking-tight text-foreground">{content.title}</h2>
          <p className="mx-auto max-w-sm text-xs leading-5 text-muted-foreground">
            {content.description}
          </p>
        </div>
      </div>
    </div>
  );
}

function getTimelineRowClassName(item: ChatTimelineItem, isFirst: boolean): string {
  const isCompactRunningRow =
    (item.kind === "activity" && item.defaultExpanded) ||
    (item.kind === "subagent-activity" && item.status === "running") ||
    (item.kind === "explore-activity" && item.status === "running") ||
    (item.kind === "tool" && item.status === "running");

  return `mx-auto max-w-3xl px-3 ${isFirst ? "pt-3 " : ""}${isCompactRunningRow ? "pb-2" : "pb-4"}`;
}

export const ChatMessageList = memo(function ChatMessageList({
  threadId = null,
  items,
  emptyState = "existing-thread-empty",
  showThinkingPlaceholder = false,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onLoadOlderHistory,
  onOpenReadFile,
  worktreePath = null,
  footer = null,
}: ChatMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const vlistRef = useRef<VListHandle>(null);
  const cacheByThreadIdRef = useRef<Map<string, ThreadListCacheEntry>>(new Map());
  const skipNextAutoFollowRef = useRef(false);
  const pendingAutoFollowRafRef = useRef<number | null>(null);
  const pendingResizeAutoFollowRafRef = useRef<number | null>(null);
  const pendingScrollRestoreRafRef = useRef<number | null>(null);
  const settlingProgrammaticBottomFollowRef = useRef(false);
  const settlingProgrammaticBottomObservedSampleRef = useRef(false);
  const ignoreInitialTopScrollRef = useRef(false);
  const initialPositiveScrollObservedRef = useRef(false);
  const loadingOlderHistoryRef = useRef(false);
  const previousLoadingOlderHistoryRef = useRef(false);
  const olderHistoryRequestInFlightRef = useRef(false);
  const retryLoadOlderAfterCompletionRef = useRef(false);
  const topThresholdArmedRef = useRef(true);
  const suppressAutoLoadOlderAfterRestoreRef = useRef(false);
  const lastObservedScrollOffsetRef = useRef<number | null>(null);
  const lastAppliedRestorableScrollSignatureRef = useRef<string | null>(null);
  const lastScrollSampleSignatureRef = useRef<string | null>(null);
  const lastLayoutSignatureRef = useRef<string | null>(null);
  const lastObservedViewportSignatureRef = useRef<string | null>(null);
  const [rawOutputMessageIds, setRawOutputMessageIds] = useState<Set<string>>(() => new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [toolExpandedById, setToolExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [editedExpandedById, setEditedExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [exploreActivityExpandedById, setExploreActivityExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExpandedById, setSubagentExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentPromptExpandedById, setSubagentPromptExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const [subagentExploreExpandedById, setSubagentExploreExpandedById] = useState<Map<string, boolean>>(() => new Map());
  const lastRenderSignatureByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDebugEnabled = isRenderDebugEnabled();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pendingAutoFollowRafRef.current != null) {
        cancelAnimationFrame(pendingAutoFollowRafRef.current);
        pendingAutoFollowRafRef.current = null;
      }
      if (pendingResizeAutoFollowRafRef.current != null) {
        cancelAnimationFrame(pendingResizeAutoFollowRafRef.current);
        pendingResizeAutoFollowRafRef.current = null;
      }
      if (pendingScrollRestoreRafRef.current != null) {
        cancelAnimationFrame(pendingScrollRestoreRafRef.current);
        pendingScrollRestoreRafRef.current = null;
      }
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (debugCopyTimeoutRef.current) clearTimeout(debugCopyTimeoutRef.current);
    };
  }, []);

  const stickyBottomRef = useRef(true);
  const shouldRenderFooter = footer != null && items.length > 0;
  const showOlderHistoryLoadingRow = loadingOlderHistory && items.length > 0;
  const leadingDisplayItemCount = showOlderHistoryLoadingRow ? 1 : 0;
  const displayItemCount =
    leadingDisplayItemCount
    + items.length
    + (showThinkingPlaceholder ? 1 : 0)
    + (shouldRenderFooter ? 1 : 0);
  const useBottomAnchoredShortThreadLayout = displayItemCount <= 12;
  const shouldEnableVirtualShift = hasOlderHistory || loadingOlderHistory;
  const keepMountedIndexes = useMemo(() => {
    if (displayItemCount === 0) {
      return undefined;
    }

    const indexes = new Set<number>();
    const tailCount = Math.min(VLIST_EDGE_KEEP_MOUNT_COUNT, displayItemCount);
    for (let index = displayItemCount - tailCount; index < displayItemCount; index += 1) {
      indexes.add(index);
    }

    if (hasOlderHistory || loadingOlderHistory) {
      const headCount = Math.min(VLIST_EDGE_KEEP_MOUNT_COUNT, displayItemCount);
      for (let index = 0; index < headCount; index += 1) {
        indexes.add(index);
      }
    }

    return Array.from(indexes).sort((left, right) => left - right);
  }, [displayItemCount, hasOlderHistory, loadingOlderHistory]);
  const timelineEdges = useMemo(() => summarizeTimelineEdges(items), [items]);
  const threadCacheSignature = useMemo(() => buildThreadCacheSignature({
    threadId,
    displayItemCount,
    firstKey: timelineEdges.firstKey,
    lastKey: timelineEdges.lastKey,
    showThinkingPlaceholder,
    shouldRenderFooter,
    showOlderHistoryLoadingRow,
  }), [
    displayItemCount,
    showOlderHistoryLoadingRow,
    shouldRenderFooter,
    showThinkingPlaceholder,
    threadId,
    timelineEdges.firstKey,
    timelineEdges.lastKey,
  ]);
  const restorableCacheEntry = useMemo(() => {
    if (!threadId) {
      return undefined;
    }

    const entry = cacheByThreadIdRef.current.get(threadId) ?? null;
    if (
      !entry
      || entry.itemCount !== displayItemCount
      || entry.signature !== threadCacheSignature
    ) {
      return undefined;
    }

    return entry;
  }, [displayItemCount, threadCacheSignature, threadId]);
  const restorableCache = restorableCacheEntry?.cache;
  const restorableScrollOffset = restorableCacheEntry?.scrollOffset ?? null;
  const restorableScrollSignature = useMemo(() => {
    if (restorableScrollOffset == null) {
      return null;
    }

    return `${threadId ?? "no-thread"}:${threadCacheSignature}:${roundScrollMetric(restorableScrollOffset)}`;
  }, [restorableScrollOffset, threadCacheSignature, threadId]);

  useLayoutEffect(() => {
    settlingProgrammaticBottomFollowRef.current = false;
    settlingProgrammaticBottomObservedSampleRef.current = false;
    suppressAutoLoadOlderAfterRestoreRef.current = false;
  }, [threadId]);

  useEffect(() => {
    stickyBottomRef.current = restorableCacheEntry == null;
    skipNextAutoFollowRef.current = restorableCacheEntry != null;
    ignoreInitialTopScrollRef.current = restorableCacheEntry == null;
    initialPositiveScrollObservedRef.current = false;
    olderHistoryRequestInFlightRef.current = false;
    retryLoadOlderAfterCompletionRef.current = false;
    topThresholdArmedRef.current = true;
    lastObservedScrollOffsetRef.current = null;
    lastAppliedRestorableScrollSignatureRef.current = null;
    if (pendingAutoFollowRafRef.current != null) {
      cancelAnimationFrame(pendingAutoFollowRafRef.current);
      pendingAutoFollowRafRef.current = null;
    }
    lastScrollSampleSignatureRef.current = null;
    lastLayoutSignatureRef.current = null;
    lastObservedViewportSignatureRef.current = null;
    setRawOutputMessageIds((current) => (current.size === 0 ? current : new Set()));
    setCopiedMessageId((current) => (current === null ? current : null));
    setCopiedDebug((current) => (current ? false : current));
    setToolExpandedById((current) => (current.size === 0 ? current : new Map()));
    setEditedExpandedById((current) => (current.size === 0 ? current : new Map()));
    setExploreActivityExpandedById((current) => (current.size === 0 ? current : new Map()));
    setSubagentExpandedById((current) => (current.size === 0 ? current : new Map()));
    setSubagentPromptExpandedById((current) => (current.size === 0 ? current : new Map()));
    setSubagentExploreExpandedById((current) => (current.size === 0 ? current : new Map()));
    lastRenderSignatureByMessageIdRef.current = new Map();

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    if (debugCopyTimeoutRef.current) {
      clearTimeout(debugCopyTimeoutRef.current);
      debugCopyTimeoutRef.current = null;
    }
    if (pendingResizeAutoFollowRafRef.current != null) {
      cancelAnimationFrame(pendingResizeAutoFollowRafRef.current);
      pendingResizeAutoFollowRafRef.current = null;
    }

    debugLog("thread.pagination.ui", "thread.reset", {
      threadId,
      displayItemCount,
      timelineItemCount: items.length,
      showThinkingPlaceholder,
      hasOlderHistory,
      loadingOlderHistory,
      showOlderHistoryLoadingRow,
      restorableCacheAvailable: restorableCacheEntry != null,
      restorableScrollOffset: roundScrollMetric(restorableCacheEntry?.scrollOffset),
      ...timelineEdges,
    });
  }, [threadId]);

  useLayoutEffect(() => {
    const wasLoadingOlderHistory = previousLoadingOlderHistoryRef.current;
    previousLoadingOlderHistoryRef.current = loadingOlderHistory;
    loadingOlderHistoryRef.current = loadingOlderHistory;
    if (!loadingOlderHistory) {
      olderHistoryRequestInFlightRef.current = false;
    }

    const handle = vlistRef.current;
    const { offset: currentOffset } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
    const loadOlderHistoryThreshold = getLoadOlderHistoryThreshold(handle ?? null, containerRef.current, currentOffset);
    const loadOlderHistoryTriggerThreshold = getLoadOlderHistoryTriggerThreshold(loadOlderHistoryThreshold, true);
    if (wasLoadingOlderHistory && !loadingOlderHistory) {
      const shouldRetryImmediately =
        hasOlderHistory
        && currentOffset <= loadOlderHistoryTriggerThreshold;
      topThresholdArmedRef.current = hasOlderHistory;
      retryLoadOlderAfterCompletionRef.current = shouldRetryImmediately;
      debugLog("thread.pagination.ui", "loadOlder.rearmed.afterCompletion", {
        threadId,
        hasOlderHistory,
        loadingOlderHistory,
        retryScheduled: shouldRetryImmediately,
        rearmedForNextPass: hasOlderHistory && !shouldRetryImmediately,
        loadOlderHistoryThreshold,
        loadOlderHistoryTriggerThreshold,
        ...buildScrollMetrics(handle ?? null, currentOffset),
      });
    } else if (!loadingOlderHistory) {
      retryLoadOlderAfterCompletionRef.current = false;
    }

    debugLog("thread.pagination.ui", "loadingOlderHistory.changed", {
      threadId,
      loadingOlderHistory,
      hasOlderHistory,
      inFlightRequest: olderHistoryRequestInFlightRef.current,
    });
  }, [hasOlderHistory, loadingOlderHistory, threadId]);

  useEffect(() => {
    const signature = [
      threadId ?? "no-thread",
      displayItemCount,
      timelineEdges.firstKey ?? "none",
      timelineEdges.lastKey ?? "none",
      showOlderHistoryLoadingRow ? "older-loading" : "steady-head",
      showThinkingPlaceholder ? "thinking" : "steady",
      shouldRenderFooter ? "footer" : "no-footer",
      hasOlderHistory ? "older" : "latest",
      loadingOlderHistory ? "loading" : "idle",
    ].join(":");

    if (lastLayoutSignatureRef.current === signature) {
      return;
    }

    lastLayoutSignatureRef.current = signature;
    debugLog("thread.pagination.ui", "list.layout.changed", {
      threadId,
      displayItemCount,
      timelineItemCount: items.length,
      showThinkingPlaceholder,
      hasOlderHistory,
      loadingOlderHistory,
      showOlderHistoryLoadingRow,
      ...timelineEdges,
    });
  }, [
    displayItemCount,
    hasOlderHistory,
    items.length,
    loadingOlderHistory,
    shouldRenderFooter,
    showOlderHistoryLoadingRow,
    showThinkingPlaceholder,
    threadId,
    timelineEdges,
  ]);

  const toggleRawOutput = useCallback((id: string) => {
    setRawOutputMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const copyOutput = useCallback((id: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    setCopiedDebug(false);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopiedMessageId(null), 2000);
  }, []);

  const copyDebugLog = useCallback(() => {
    copyRenderDebugLog();
    setCopiedDebug(true);
    if (debugCopyTimeoutRef.current) clearTimeout(debugCopyTimeoutRef.current);
    debugCopyTimeoutRef.current = setTimeout(() => setCopiedDebug(false), 2000);
  }, []);

  const persistRestorableCache = useCallback((reason: string) => {
    if (!threadId) {
      return false;
    }

    const handle = vlistRef.current;
    const currentCache = handle?.cache;
    const {
      offset: currentOffset,
      scrollSize: effectiveScrollSize,
      viewportSize: effectiveViewportSize,
    } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
    if (
      !currentCache
      || stickyBottomRef.current
      || effectiveViewportSize <= 0
      || effectiveScrollSize <= 0
      || typeof currentOffset !== "number"
      || Number.isNaN(currentOffset)
    ) {
      return false;
    }

    cacheByThreadIdRef.current.set(threadId, {
      itemCount: displayItemCount,
      cache: currentCache,
      signature: threadCacheSignature,
      scrollOffset: currentOffset,
      scrollSize: effectiveScrollSize,
      viewportSize: effectiveViewportSize,
    });

    debugLog("thread.pagination.ui", "cache.saved", {
      threadId,
      reason,
      itemCount: displayItemCount,
      signature: threadCacheSignature,
      savedScrollOffset: roundScrollMetric(currentOffset),
      savedScrollSize: roundScrollMetric(effectiveScrollSize),
      savedViewportSize: roundScrollMetric(effectiveViewportSize),
      stickyBottom: stickyBottomRef.current,
      ...buildScrollMetrics(handle ?? null, currentOffset),
      ...buildVirtualDomMetrics(containerRef.current),
    });

    return true;
  }, [displayItemCount, threadCacheSignature, threadId]);

  useEffect(() => {
    return () => {
      if (!threadId) {
        return;
      }

      const handle = vlistRef.current;
      const currentCache = handle?.cache;
      const existingEntry = cacheByThreadIdRef.current.get(threadId) ?? null;
      const liveCleanupOffset = handle?.scrollOffset ?? null;
      const lastKnownOffset = lastObservedScrollOffsetRef.current;
      const cleanupHandleMatchesLastKnownOffset =
        typeof liveCleanupOffset === "number"
        && !Number.isNaN(liveCleanupOffset)
        && (lastKnownOffset == null || Math.abs(liveCleanupOffset - lastKnownOffset) <= THREAD_PAGINATION_SCROLL_SAMPLE_PX);
      if (
        currentCache
        && !stickyBottomRef.current
        && (handle?.viewportSize ?? 0) > 0
        && cleanupHandleMatchesLastKnownOffset
      ) {
        persistRestorableCache("cleanup");
        return;
      }

      const hasInvalidCleanupViewport = currentCache != null && (handle?.viewportSize ?? 0) <= 0;
      const shouldPreserveExistingCache =
        (!currentCache || !cleanupHandleMatchesLastKnownOffset || hasInvalidCleanupViewport)
        && !stickyBottomRef.current
        && existingEntry?.itemCount === displayItemCount
        && existingEntry.signature === threadCacheSignature;

      if (stickyBottomRef.current) {
        cacheByThreadIdRef.current.delete(threadId);
        debugLog("thread.pagination.ui", "cache.discarded", {
          threadId,
          reason: "sticky-bottom",
          itemCount: displayItemCount,
          stickyBottom: stickyBottomRef.current,
          ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
        });
        return;
      }

      if (shouldPreserveExistingCache) {
        debugLog("thread.pagination.ui", "cache.preservedExisting", {
          threadId,
          reason:
            !currentCache
              ? "cleanup-missing-handle-cache"
              : hasInvalidCleanupViewport
                ? "cleanup-invalid-viewport"
                : "cleanup-offset-mismatch",
          itemCount: displayItemCount,
          signature: threadCacheSignature,
          savedScrollOffset: roundScrollMetric(existingEntry.scrollOffset),
          stickyBottom: stickyBottomRef.current,
        });
        return;
      }

      if (hasInvalidCleanupViewport) {
        cacheByThreadIdRef.current.delete(threadId);
        debugLog("thread.pagination.ui", "cache.discarded", {
          threadId,
          reason: "invalid-viewport",
          itemCount: displayItemCount,
          stickyBottom: stickyBottomRef.current,
          ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
        });
        return;
      }

      cacheByThreadIdRef.current.delete(threadId);
      debugLog("thread.pagination.ui", "cache.discarded", {
        threadId,
        reason: "missing-cache",
        itemCount: displayItemCount,
        stickyBottom: stickyBottomRef.current,
        ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
      });
    };
  }, [displayItemCount, persistRestorableCache, threadCacheSignature, threadId]);

  const displayItems = useMemo(() => {
    const result: Array<ChatTimelineItem | "older-history-loading" | "thinking-placeholder" | "footer"> = [];
    if (showOlderHistoryLoadingRow) {
      result.push("older-history-loading");
    }
    result.push(...items);
    if (showThinkingPlaceholder) {
      result.push("thinking-placeholder");
    }
    if (shouldRenderFooter) {
      result.push("footer");
    }
    return result;
  }, [items, shouldRenderFooter, showOlderHistoryLoadingRow, showThinkingPlaceholder]);

  const getAutoFollowTargetIndex = useCallback((mode: "preserve-user-anchor" | "bottom" = "preserve-user-anchor") => {
    if (displayItems.length === 0) {
      return null;
    }

    if (mode === "bottom") {
      return displayItems.length - 1;
    }

    if (shouldRenderFooter) {
      return displayItems.length - 1;
    }

    const lastTimelineItem = items[items.length - 1] ?? null;
    if (
      showThinkingPlaceholder
      && lastTimelineItem?.kind === "message"
      && lastTimelineItem.message.role === "user"
    ) {
      return leadingDisplayItemCount + items.length - 1;
    }

    return displayItems.length - 1;
  }, [displayItems.length, items, leadingDisplayItemCount, shouldRenderFooter, showThinkingPlaceholder]);

  const scrollToBottom = useCallback((mode: "preserve-user-anchor" | "bottom" = "preserve-user-anchor") => {
    const attemptScrollToBottom = (attempt: number) => {
      const handle = vlistRef.current;
      const targetIndex = getAutoFollowTargetIndex(mode);
      const {
        viewport,
        scrollSize: effectiveScrollSize,
        viewportSize: effectiveViewportSize,
      } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
      if (!handle || targetIndex == null) {
        debugLog("thread.pagination.ui", "scrollToBottom.skipped", {
          threadId,
          mode,
          attempt,
          targetIndex,
          hasHandle: handle != null,
          displayItemCount,
          ...buildVirtualDomMetrics(containerRef.current),
        });
        if (!handle && attempt < AUTO_FOLLOW_MEASUREMENT_RETRY_LIMIT) {
          if (pendingAutoFollowRafRef.current != null) {
            cancelAnimationFrame(pendingAutoFollowRafRef.current);
          }
          pendingAutoFollowRafRef.current = requestAnimationFrame(() => {
            pendingAutoFollowRafRef.current = null;
            attemptScrollToBottom(attempt + 1);
          });
        }
        return;
      }

      if (
        effectiveViewportSize <= 0
        && effectiveScrollSize > 0
        && attempt < AUTO_FOLLOW_MEASUREMENT_RETRY_LIMIT
      ) {
        if (pendingAutoFollowRafRef.current != null) {
          cancelAnimationFrame(pendingAutoFollowRafRef.current);
        }
        pendingAutoFollowRafRef.current = requestAnimationFrame(() => {
          pendingAutoFollowRafRef.current = null;
          attemptScrollToBottom(attempt + 1);
        });
        debugLog("thread.pagination.ui", "scrollToBottom.deferredUntilMeasured", {
          threadId,
          mode,
          attempt,
          targetIndex,
          displayItemCount,
          ...buildScrollMetrics(handle, handle.scrollOffset),
        });
        return;
      }

      try {
        settlingProgrammaticBottomFollowRef.current = true;
        settlingProgrammaticBottomObservedSampleRef.current = false;
        if (viewport && effectiveScrollSize > 0) {
          viewport.scrollTop = effectiveScrollSize;
        }
        handle.scrollToIndex(targetIndex, { align: "end" });
        debugLog("thread.pagination.ui", "scrollToBottom.executed", {
          threadId,
          mode,
          targetIndex,
          attempt,
          displayItemCount,
          ...buildScrollMetrics(handle, handle.scrollOffset),
        });
      } catch {
        // scroll fallback
      }
    };

    attemptScrollToBottom(0);
  }, [displayItemCount, getAutoFollowTargetIndex, threadId]);

  const isAtBottom = useCallback((offset: number) => {
    const handle = vlistRef.current;
    const { scrollSize, viewportSize } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current, offset);
    if (scrollSize <= 0 || viewportSize <= 0) {
      return stickyBottomRef.current;
    }

    const distanceFromBottom = scrollSize - viewportSize - offset;
    return distanceFromBottom <= AT_BOTTOM_THRESHOLD;
  }, []);

  const releaseRestoreNearTopPaginationSuppression = useCallback((reason: "pointer" | "wheel") => {
    if (!suppressAutoLoadOlderAfterRestoreRef.current) {
      return false;
    }

    suppressAutoLoadOlderAfterRestoreRef.current = false;
    debugLog("thread.pagination.ui", "loadOlder.restoreSuppression.released", {
      threadId,
      reason,
      offset: roundScrollMetric(lastObservedScrollOffsetRef.current),
    });
    return true;
  }, [threadId]);

  const applyRestorableScrollOffset = useCallback((
    source: "layout-effect" | "resize-observer",
    attempt: number | null = null,
  ) => {
    if (
      restorableScrollOffset == null
      || restorableScrollSignature == null
      || displayItems.length === 0
      || lastAppliedRestorableScrollSignatureRef.current === restorableScrollSignature
    ) {
      return "skip";
    }

    const handle = vlistRef.current;
    const {
      viewport,
      scrollSize: effectiveScrollSize,
      viewportSize: effectiveViewportSize,
    } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
    if (!handle) {
      debugLog("thread.pagination.ui", "scrollRestore.deferredMissingHandle", {
        threadId,
        source,
        attempt,
        savedScrollOffset: roundScrollMetric(restorableScrollOffset),
        displayItemCount,
        ...buildVirtualDomMetrics(containerRef.current),
      });
      return "deferred";
    }

    if (effectiveViewportSize <= 0 || effectiveScrollSize <= 0) {
      debugLog("thread.pagination.ui", "scrollRestore.deferredUntilMeasured", {
        threadId,
        source,
        attempt,
        savedScrollOffset: roundScrollMetric(restorableScrollOffset),
        displayItemCount,
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "deferred";
    }

    const currentMaxScrollOffset = Math.max(0, effectiveScrollSize - effectiveViewportSize);
    const savedMaxScrollOffset = Math.max(
      0,
      (restorableCacheEntry?.scrollSize ?? 0) - (restorableCacheEntry?.viewportSize ?? 0),
    );
    const needsMoreMeasuredRange =
      restorableCacheEntry != null
      && currentMaxScrollOffset + 1 < restorableScrollOffset
      && handle.scrollSize + 1 < restorableCacheEntry.scrollSize
      && savedMaxScrollOffset + 1 >= restorableScrollOffset;

    if (needsMoreMeasuredRange) {
      debugLog("thread.pagination.ui", "scrollRestore.deferredForRange", {
        threadId,
        source,
        attempt,
        savedScrollOffset: roundScrollMetric(restorableScrollOffset),
        savedScrollSize: roundScrollMetric(restorableCacheEntry?.scrollSize),
        savedViewportSize: roundScrollMetric(restorableCacheEntry?.viewportSize),
        currentMaxScrollOffset: roundScrollMetric(currentMaxScrollOffset),
        savedMaxScrollOffset: roundScrollMetric(savedMaxScrollOffset),
        displayItemCount,
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "deferred";
    }

    const clampedOffset = clampScrollOffset(restorableScrollOffset, effectiveScrollSize, effectiveViewportSize);
    const nextStickyBottom = isAtBottom(clampedOffset);
    const loadOlderHistoryThreshold = clampLoadOlderHistoryThreshold(effectiveViewportSize);
    const loadOlderHistoryRearmThreshold = getLoadOlderHistoryRearmThreshold(loadOlderHistoryThreshold);
    const shouldSuppressAutoLoadOlderAfterRestore =
      hasOlderHistory
      && clampedOffset <= loadOlderHistoryRearmThreshold;
    const commitRestore = () => {
      lastAppliedRestorableScrollSignatureRef.current = restorableScrollSignature;
      lastObservedScrollOffsetRef.current = clampedOffset;
      settlingProgrammaticBottomFollowRef.current = false;
      settlingProgrammaticBottomObservedSampleRef.current = false;
      stickyBottomRef.current = nextStickyBottom;
      suppressAutoLoadOlderAfterRestoreRef.current = shouldSuppressAutoLoadOlderAfterRestore;
    };

    if (Math.abs(handle.scrollOffset - clampedOffset) <= 1) {
      commitRestore();
      debugLog("thread.pagination.ui", "scrollRestore.skippedAlreadyAligned", {
        threadId,
        source,
        attempt,
        displayItemCount,
        savedScrollOffset: roundScrollMetric(clampedOffset),
        stickyBottom: stickyBottomRef.current,
        suppressAutoLoadOlderAfterRestore: shouldSuppressAutoLoadOlderAfterRestore,
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "restored";
    }

    try {
      if (viewport) {
        viewport.scrollTop = clampedOffset;
      }
      handle.scrollTo(clampedOffset);
      commitRestore();
      debugLog("thread.pagination.ui", "scrollRestore.executed", {
        threadId,
        source,
        attempt,
        displayItemCount,
        savedScrollOffset: roundScrollMetric(clampedOffset),
        stickyBottom: stickyBottomRef.current,
        suppressAutoLoadOlderAfterRestore: shouldSuppressAutoLoadOlderAfterRestore,
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "restored";
    } catch {
      debugLog("thread.pagination.ui", "scrollRestore.failed", {
        threadId,
        source,
        attempt,
        displayItemCount,
        savedScrollOffset: roundScrollMetric(clampedOffset),
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "deferred";
    }
  }, [
    displayItemCount,
    displayItems.length,
    isAtBottom,
    hasOlderHistory,
    restorableCacheEntry,
    restorableScrollOffset,
    restorableScrollSignature,
    threadId,
  ]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const container = containerRef.current;
    const viewport = container?.firstElementChild;
    if (!(viewport instanceof HTMLElement)) {
      return;
    }

    const content = viewport.firstElementChild;
    const observer = new ResizeObserver(() => {
      const handle = vlistRef.current;
      if (!handle || displayItems.length === 0) {
        return;
      }

      const viewportSignature = `${roundScrollMetric(handle.scrollSize)}:${roundScrollMetric(handle.viewportSize)}`;
      if (lastObservedViewportSignatureRef.current === viewportSignature) {
        return;
      }
      lastObservedViewportSignatureRef.current = viewportSignature;

      const restorePending =
        restorableScrollSignature != null
        && lastAppliedRestorableScrollSignatureRef.current !== restorableScrollSignature;
      if (restorePending) {
        const restoreResult = applyRestorableScrollOffset("resize-observer");
        if (restoreResult !== "skip") {
          return;
        }
      }

      if (
        !stickyBottomRef.current
        || skipNextAutoFollowRef.current
        || loadingOlderHistoryRef.current
      ) {
        return;
      }

      if (pendingResizeAutoFollowRafRef.current != null) {
        cancelAnimationFrame(pendingResizeAutoFollowRafRef.current);
      }

      pendingResizeAutoFollowRafRef.current = requestAnimationFrame(() => {
        pendingResizeAutoFollowRafRef.current = null;
        const currentHandle = vlistRef.current;
        if (
          !currentHandle
          || !stickyBottomRef.current
          || loadingOlderHistoryRef.current
        ) {
          return;
        }

        const distanceFromBottom =
          currentHandle.scrollSize - currentHandle.viewportSize - currentHandle.scrollOffset;
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
          return;
        }

        debugLog("thread.pagination.ui", "scrollToBottom.realignAfterResize", {
          threadId,
          displayItemCount,
          ...buildScrollMetrics(currentHandle, currentHandle.scrollOffset),
        });
        scrollToBottom("preserve-user-anchor");
      });
    });

    observer.observe(viewport);
    if (content instanceof HTMLElement) {
      observer.observe(content);
    }

    return () => {
      observer.disconnect();
      if (pendingResizeAutoFollowRafRef.current != null) {
        cancelAnimationFrame(pendingResizeAutoFollowRafRef.current);
        pendingResizeAutoFollowRafRef.current = null;
      }
    };
  }, [
    applyRestorableScrollOffset,
    displayItemCount,
    displayItems.length,
    restorableScrollSignature,
    scrollToBottom,
    threadId,
  ]);

  useLayoutEffect(() => {
    if (displayItems.length === 0) {
      return;
    }

    const logDomState = (phase: "layout" | "raf") => {
      const handle = vlistRef.current;
      debugLog("thread.pagination.ui", "vlist.domState", {
        threadId,
        phase,
        displayItemCount,
        hasHandle: handle != null,
        ...buildVirtualDomMetrics(containerRef.current),
        ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
      });
    };

    logDomState("layout");

    const rafId = requestAnimationFrame(() => {
      logDomState("raf");
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [displayItemCount, displayItems.length, threadId]);

  useLayoutEffect(() => {
    if (!stickyBottomRef.current || displayItems.length === 0 || loadingOlderHistoryRef.current) {
      return;
    }

    if (skipNextAutoFollowRef.current) {
      debugLog("thread.pagination.ui", "autoFollow.skippedForCacheRestore", {
        threadId,
        displayItemCount: displayItems.length,
      });
      skipNextAutoFollowRef.current = false;
      return;
    }

    scrollToBottom("preserve-user-anchor");
  }, [displayItems, scrollToBottom]);

  const requestOlderHistory = useCallback(() => {
    const skipReason =
      !hasOlderHistory
        ? "no-older-history"
        : loadingOlderHistoryRef.current
          ? "already-loading"
          : !onLoadOlderHistory
            ? "missing-handler"
            : olderHistoryRequestInFlightRef.current
              ? "request-in-flight"
              : null;

    if (skipReason) {
      debugLog("thread.pagination.ui", "loadOlder.request.skipped", {
        threadId,
        reason: skipReason,
        hasOlderHistory,
        loadingOlderHistory: loadingOlderHistoryRef.current,
        inFlightRequest: olderHistoryRequestInFlightRef.current,
      });
      return;
    }

    const handle = vlistRef.current;
    const loadOlderHistory = onLoadOlderHistory;
    const currentOffset = handle?.scrollOffset ?? 0;
    const loadOlderHistoryThreshold = getLoadOlderHistoryThreshold(handle ?? null, containerRef.current, currentOffset);
    const loadOlderHistoryTriggerThreshold = getLoadOlderHistoryTriggerThreshold(loadOlderHistoryThreshold, true);
    olderHistoryRequestInFlightRef.current = true;
    debugLog("thread.pagination.ui", "loadOlder.request.started", {
      threadId,
      displayItemCount,
      loadOlderHistoryThreshold,
      loadOlderHistoryTriggerThreshold,
      ...buildScrollMetrics(handle ?? null, currentOffset),
      ...timelineEdges,
    });
    void Promise.resolve(loadOlderHistory?.())
      .then((started) => {
        if (started === false) {
          olderHistoryRequestInFlightRef.current = false;
          topThresholdArmedRef.current = true;
          retryLoadOlderAfterCompletionRef.current = currentOffset <= loadOlderHistoryTriggerThreshold;
          debugLog("thread.pagination.ui", "loadOlder.request.rearmedAfterSkip", {
            threadId,
            displayItemCount,
            loadOlderHistoryThreshold,
            loadOlderHistoryTriggerThreshold,
            retryScheduled: retryLoadOlderAfterCompletionRef.current,
            ...buildScrollMetrics(handle ?? null, currentOffset),
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!loadingOlderHistoryRef.current) {
          olderHistoryRequestInFlightRef.current = false;
        }

        const currentHandle = vlistRef.current;
        debugLog("thread.pagination.ui", "loadOlder.request.completed", {
          threadId,
          displayItemCount,
          loadingOlderHistory: loadingOlderHistoryRef.current,
          inFlightRequest: olderHistoryRequestInFlightRef.current,
          ...buildScrollMetrics(currentHandle ?? null, currentHandle?.scrollOffset ?? 0),
        });
      });
  }, [displayItemCount, hasOlderHistory, onLoadOlderHistory, threadId, timelineEdges]);

  useLayoutEffect(() => {
    if (
      !retryLoadOlderAfterCompletionRef.current
      || loadingOlderHistory
      || !hasOlderHistory
      || !initialPositiveScrollObservedRef.current
    ) {
      return;
    }

    const handle = vlistRef.current;
    const { offset: currentOffset } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
    const loadOlderHistoryThreshold = getLoadOlderHistoryThreshold(handle ?? null, containerRef.current, currentOffset);
    const loadOlderHistoryTriggerThreshold = getLoadOlderHistoryTriggerThreshold(loadOlderHistoryThreshold, true);
    retryLoadOlderAfterCompletionRef.current = false;
    if (currentOffset > loadOlderHistoryTriggerThreshold) {
      return;
    }

    topThresholdArmedRef.current = false;
    debugLog("thread.pagination.ui", "loadOlder.request.retriedAfterCompletion", {
      threadId,
      displayItemCount,
      loadOlderHistoryThreshold,
      loadOlderHistoryTriggerThreshold,
      ...buildScrollMetrics(handle ?? null, currentOffset),
    });
    requestOlderHistory();
  }, [displayItemCount, hasOlderHistory, loadingOlderHistory, requestOlderHistory, threadId]);

  useLayoutEffect(() => {
    if (restorableScrollSignature == null || displayItems.length === 0) {
      return;
    }

    const restoreScrollOffset = (attempt: number) => {
      const restoreResult = applyRestorableScrollOffset("layout-effect", attempt);
      if (restoreResult === "deferred" && attempt < AUTO_FOLLOW_MEASUREMENT_RETRY_LIMIT) {
        if (pendingScrollRestoreRafRef.current != null) {
          cancelAnimationFrame(pendingScrollRestoreRafRef.current);
        }
        pendingScrollRestoreRafRef.current = requestAnimationFrame(() => {
          pendingScrollRestoreRafRef.current = null;
          restoreScrollOffset(attempt + 1);
        });
        return;
      }

      if (restoreResult === "deferred") {
        debugLog("thread.pagination.ui", "scrollRestore.waitingForResize", {
          threadId,
          attempt,
          savedScrollOffset: roundScrollMetric(restorableScrollOffset),
          displayItemCount,
          savedScrollSize: roundScrollMetric(restorableCacheEntry?.scrollSize),
          savedViewportSize: roundScrollMetric(restorableCacheEntry?.viewportSize),
        });
      }
    };

    restoreScrollOffset(0);

    return () => {
      if (pendingScrollRestoreRafRef.current != null) {
        cancelAnimationFrame(pendingScrollRestoreRafRef.current);
        pendingScrollRestoreRafRef.current = null;
      }
    };
  }, [
    applyRestorableScrollOffset,
    displayItemCount,
    displayItems.length,
    restorableCacheEntry,
    restorableScrollOffset,
    restorableScrollSignature,
    threadId,
  ]);

  const handleScroll = useCallback((offset: number) => {
    if (offset > 0) {
      initialPositiveScrollObservedRef.current = true;
    }

    if (
      ignoreInitialTopScrollRef.current
      && !initialPositiveScrollObservedRef.current
      && offset <= 0
    ) {
      debugLog("thread.pagination.ui", "scroll.ignored.initialTop", {
        threadId,
        offset: roundScrollMetric(offset),
        initialPositiveScrollObserved: initialPositiveScrollObservedRef.current,
      });
      return;
    }

    const handle = vlistRef.current;
    const {
      scrollSize: effectiveScrollSize,
      viewportSize: effectiveViewportSize,
    } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current, offset);
    const loadOlderHistoryThreshold = clampLoadOlderHistoryThreshold(effectiveViewportSize);
    const previousOffset = lastObservedScrollOffsetRef.current;
    const movingTowardTop = previousOffset == null || offset < previousOffset;
    const loadOlderHistoryTriggerThreshold = getLoadOlderHistoryTriggerThreshold(
      loadOlderHistoryThreshold,
      movingTowardTop,
    );
    const loadOlderHistoryRearmThreshold = getLoadOlderHistoryRearmThreshold(loadOlderHistoryThreshold);
    const distanceFromBottom = effectiveScrollSize - effectiveViewportSize - offset;
    const isFirstSettlingSample =
      settlingProgrammaticBottomFollowRef.current
      && !settlingProgrammaticBottomObservedSampleRef.current;
    const isMovingTowardBottom = previousOffset == null || offset >= previousOffset;
    const shouldPreserveStickyBottomDuringSettle =
      settlingProgrammaticBottomFollowRef.current
      && distanceFromBottom <= AUTO_FOLLOW_SETTLE_BOTTOM_THRESHOLD
      && (isFirstSettlingSample || isMovingTowardBottom);

    stickyBottomRef.current = shouldPreserveStickyBottomDuringSettle || isAtBottom(offset);
    lastObservedScrollOffsetRef.current = offset;
    if (settlingProgrammaticBottomFollowRef.current) {
      settlingProgrammaticBottomObservedSampleRef.current = true;
    }
    if (!stickyBottomRef.current && settlingProgrammaticBottomFollowRef.current) {
      settlingProgrammaticBottomFollowRef.current = false;
      settlingProgrammaticBottomObservedSampleRef.current = false;
    }
    if (!stickyBottomRef.current && pendingAutoFollowRafRef.current != null) {
      cancelAnimationFrame(pendingAutoFollowRafRef.current);
      pendingAutoFollowRafRef.current = null;
    }
    if (offset > loadOlderHistoryRearmThreshold) {
      topThresholdArmedRef.current = true;
    }
    const metrics = buildScrollMetrics(handle ?? null, offset);
    const scrollBucket = Math.floor(offset / THREAD_PAGINATION_SCROLL_SAMPLE_PX);
    const sampleSignature = [
      threadId ?? "no-thread",
      scrollBucket,
      stickyBottomRef.current ? "bottom" : "middle",
      offset <= loadOlderHistoryTriggerThreshold ? "near-top" : "away-top",
      hasOlderHistory ? "older" : "latest",
      loadingOlderHistoryRef.current ? "loading" : "idle",
    ].join(":");

    if (lastScrollSampleSignatureRef.current !== sampleSignature) {
      lastScrollSampleSignatureRef.current = sampleSignature;
      debugLog("thread.pagination.ui", "scroll.sample", {
        threadId,
        hasOlderHistory,
        loadingOlderHistory: loadingOlderHistoryRef.current,
        stickyBottom: stickyBottomRef.current,
        settlingProgrammaticBottomFollow: settlingProgrammaticBottomFollowRef.current,
        preservedDuringSettle: shouldPreserveStickyBottomDuringSettle,
        initialPositiveScrollObserved: initialPositiveScrollObservedRef.current,
        previousOffset: roundScrollMetric(previousOffset),
        loadOlderHistoryThreshold,
        loadOlderHistoryTriggerThreshold,
        loadOlderHistoryRearmThreshold,
        ...metrics,
      });

      if (!stickyBottomRef.current && !loadingOlderHistoryRef.current) {
        persistRestorableCache("scroll-sample");
      }
    }

    if (
      hasOlderHistory
      && initialPositiveScrollObservedRef.current
      && !suppressAutoLoadOlderAfterRestoreRef.current
      && topThresholdArmedRef.current
      && offset <= loadOlderHistoryTriggerThreshold
    ) {
      topThresholdArmedRef.current = false;
      debugLog("thread.pagination.ui", "scroll.threshold.topReached", {
        threadId,
        hasOlderHistory,
        loadOlderHistoryThreshold,
        loadOlderHistoryTriggerThreshold,
        ...metrics,
      });
      requestOlderHistory();
    }
  }, [
    hasOlderHistory,
    isAtBottom,
    persistRestorableCache,
    requestOlderHistory,
    threadId,
  ]);

  const handleScrollEnd = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle || displayItems.length === 0) return;

    const {
      offset: currentOffset,
      scrollSize: effectiveScrollSize,
      viewportSize: effectiveViewportSize,
    } = getEffectiveScrollSnapshot(handle, containerRef.current);
    const distanceFromBottom = effectiveScrollSize - effectiveViewportSize - currentOffset;
    const shouldSnapToBottomAfterSettling =
      settlingProgrammaticBottomFollowRef.current
      && distanceFromBottom <= AUTO_FOLLOW_SETTLE_BOTTOM_THRESHOLD;

    lastObservedScrollOffsetRef.current = currentOffset;
    stickyBottomRef.current = isAtBottom(currentOffset);
    if (!stickyBottomRef.current && shouldSnapToBottomAfterSettling) {
      stickyBottomRef.current = true;
    }
    debugLog("thread.pagination.ui", "scroll.end", {
      threadId,
      displayItemCount: displayItems.length,
      stickyBottom: stickyBottomRef.current,
      shouldSnapToBottomAfterSettling,
      settlingProgrammaticBottomFollow: settlingProgrammaticBottomFollowRef.current,
      hasOlderHistory,
      ...buildScrollMetrics(handle, currentOffset),
    });
    if (
      hasOlderHistory
      && initialPositiveScrollObservedRef.current
      && !suppressAutoLoadOlderAfterRestoreRef.current
      && topThresholdArmedRef.current
      && currentOffset <= getLoadOlderHistoryTriggerThreshold(
        getLoadOlderHistoryThreshold(handle, containerRef.current, currentOffset),
        true,
      )
    ) {
      topThresholdArmedRef.current = false;
      requestOlderHistory();
    }
    if ((!stickyBottomRef.current && !shouldSnapToBottomAfterSettling) || loadingOlderHistoryRef.current) {
      persistRestorableCache("scroll-end");
      settlingProgrammaticBottomFollowRef.current = false;
      settlingProgrammaticBottomObservedSampleRef.current = false;
      return;
    }
    settlingProgrammaticBottomFollowRef.current = false;
    settlingProgrammaticBottomObservedSampleRef.current = false;
    scrollToBottom("bottom");
  }, [
    displayItems.length,
    hasOlderHistory,
    isAtBottom,
    persistRestorableCache,
    requestOlderHistory,
    scrollToBottom,
    threadId,
  ]);

  const handleWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    settlingProgrammaticBottomFollowRef.current = false;
    settlingProgrammaticBottomObservedSampleRef.current = false;

    // A real wheel gesture means subsequent top-edge scroll samples are user-driven,
    // not the synthetic initial top sample emitted by the virtualizer during mount.
    if (event.deltaY !== 0) {
      ignoreInitialTopScrollRef.current = false;
      initialPositiveScrollObservedRef.current = true;
      releaseRestoreNearTopPaginationSuppression("wheel");
    }

    if (event.deltaY >= 0 || !hasOlderHistory || !topThresholdArmedRef.current) {
      return;
    }

    const handle = vlistRef.current;
    const { offset: currentOffset } = getEffectiveScrollSnapshot(handle ?? null, containerRef.current);
    const loadOlderHistoryThreshold = getLoadOlderHistoryThreshold(handle ?? null, containerRef.current, currentOffset);
    const loadOlderHistoryTriggerThreshold = getLoadOlderHistoryTriggerThreshold(loadOlderHistoryThreshold, true);
    if (currentOffset > loadOlderHistoryTriggerThreshold) {
      return;
    }

    topThresholdArmedRef.current = false;
    debugLog("thread.pagination.ui", "scroll.threshold.topReached.wheel", {
      threadId,
      hasOlderHistory,
      deltaY: roundScrollMetric(event.deltaY),
      loadOlderHistoryThreshold,
      loadOlderHistoryTriggerThreshold,
      ...buildScrollMetrics(handle ?? null, currentOffset),
    });
    requestOlderHistory();
  }, [hasOlderHistory, releaseRestoreNearTopPaginationSuppression, requestOlderHistory, threadId]);

  const handlePointerDownCapture = useCallback(() => {
    releaseRestoreNearTopPaginationSuppression("pointer");
  }, [releaseRestoreNearTopPaginationSuppression]);

  const timelineCtx = useMemo<TimelineCtx>(() => ({
    rawOutputMessageIds,
    copiedMessageId,
    copiedDebug,
    renderDebugEnabled,
    toggleRawOutput,
    copyOutput,
    copyDebugLog,
    onOpenReadFile,
    worktreePath,
    toolExpandedById,
    setToolExpandedById,
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
  }), [
    copiedDebug,
    copiedMessageId,
    copyDebugLog,
    copyOutput,
    editedExpandedById,
    exploreActivityExpandedById,
    lastRenderSignatureByMessageIdRef,
    onOpenReadFile,
    rawOutputMessageIds,
    renderDebugEnabled,
    setEditedExpandedById,
    setExploreActivityExpandedById,
    setSubagentExpandedById,
    setSubagentExploreExpandedById,
    setSubagentPromptExpandedById,
    setToolExpandedById,
    subagentExpandedById,
    subagentExploreExpandedById,
    subagentPromptExpandedById,
    toggleRawOutput,
    toolExpandedById,
    worktreePath,
  ]);

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0"
      data-testid="chat-scroll"
      onPointerDownCapture={handlePointerDownCapture}
      onWheelCapture={handleWheelCapture}
    >
      {displayItems.length === 0 ? (
        emptyState ? <EmptyStateCard state={emptyState} /> : null
      ) : (
        <VList
          // virtua only applies cache restoration on mount, so thread switches
          // need a fresh instance to avoid leaking measurements across threads.
          key={threadId ?? "no-thread"}
          ref={vlistRef}
          bufferSize={VLIST_BUFFER_SIZE}
          cache={restorableCache}
          data={displayItems}
          keepMounted={keepMountedIndexes}
          shift={shouldEnableVirtualShift}
          style={
            useBottomAnchoredShortThreadLayout
              ? {
                  height: "100%",
                  overflowAnchor: "none",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-end",
                }
              : {
                  height: "100%",
                  overflowAnchor: "none",
                }
          }
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
        >
          {(item, index) => {
            const isFirst = index === 0;
            if (item === "older-history-loading") {
              return (
                <div key="older-history-loading" className={`mx-auto max-w-3xl px-3 ${isFirst ? "pt-3 " : ""}pb-4`}>
                  <OlderHistoryLoadingRow />
                </div>
              );
            }
            if (item === "thinking-placeholder") {
              return (
                <div key="thinking-placeholder" className={`mx-auto max-w-3xl px-3 ${isFirst ? "pt-3 " : ""}pb-4`}>
                  <ThinkingPlaceholder />
                </div>
              );
            }
            if (item === "footer") {
              return (
                <div key="chat-message-list-footer" data-testid="chat-message-list-footer">
                  {footer}
                </div>
              );
            }
            return (
              <div key={getTimelineItemKey(item)} className={getTimelineRowClassName(item, isFirst)}>
                <TimelineItem item={item} ctx={timelineCtx} />
              </div>
            );
          }}
        </VList>
      )}
    </div>
  );
});
