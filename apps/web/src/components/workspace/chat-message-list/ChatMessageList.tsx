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
  showThinkingPlaceholder: boolean;
  shouldRenderFooter: boolean;
}) {
  return [
    params.threadId ?? "no-thread",
    params.displayItemCount,
    params.firstKey ?? "none",
    params.lastKey ?? "none",
    "steady-head",
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
  const displayItemCount =
    items.length
    + (showThinkingPlaceholder ? 1 : 0)
    + (shouldRenderFooter ? 1 : 0);
  const useBottomAnchoredShortThreadLayout = displayItemCount <= 12;
  const keepMountedIndexes = useMemo(() => {
    if (displayItemCount === 0) {
      return undefined;
    }

    const indexes = new Set<number>();
    const tailCount = Math.min(VLIST_EDGE_KEEP_MOUNT_COUNT, displayItemCount);
    for (let index = displayItemCount - tailCount; index < displayItemCount; index += 1) {
      indexes.add(index);
    }

    return Array.from(indexes).sort((left, right) => left - right);
  }, [displayItemCount]);
  const timelineEdges = useMemo(() => summarizeTimelineEdges(items), [items]);
  const threadCacheSignature = useMemo(() => buildThreadCacheSignature({
    threadId,
    displayItemCount,
    firstKey: timelineEdges.firstKey,
    lastKey: timelineEdges.lastKey,
    showThinkingPlaceholder,
    shouldRenderFooter,
  }), [
    displayItemCount,
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
  }, [threadId]);

  useEffect(() => {
    stickyBottomRef.current = restorableCacheEntry == null;
    skipNextAutoFollowRef.current = restorableCacheEntry != null;
    ignoreInitialTopScrollRef.current = restorableCacheEntry == null;
    initialPositiveScrollObservedRef.current = false;
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

    debugLog("thread.timeline.ui", "thread.reset", {
      threadId,
      displayItemCount,
      timelineItemCount: items.length,
      showThinkingPlaceholder,
      restorableCacheAvailable: restorableCacheEntry != null,
      restorableScrollOffset: roundScrollMetric(restorableCacheEntry?.scrollOffset),
      ...timelineEdges,
    });
  }, [threadId]);

  useEffect(() => {
    const signature = [
      threadId ?? "no-thread",
      displayItemCount,
      timelineEdges.firstKey ?? "none",
      timelineEdges.lastKey ?? "none",
      "steady-head",
      showThinkingPlaceholder ? "thinking" : "steady",
      shouldRenderFooter ? "footer" : "no-footer",
    ].join(":");

    if (lastLayoutSignatureRef.current === signature) {
      return;
    }

    lastLayoutSignatureRef.current = signature;
    debugLog("thread.timeline.ui", "list.layout.changed", {
      threadId,
      displayItemCount,
      timelineItemCount: items.length,
      showThinkingPlaceholder,
      ...timelineEdges,
    });
  }, [
    displayItemCount,
    items.length,
    shouldRenderFooter,
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

    debugLog("thread.timeline.ui", "cache.saved", {
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
        debugLog("thread.timeline.ui", "cache.discarded", {
          threadId,
          reason: "sticky-bottom",
          itemCount: displayItemCount,
          stickyBottom: stickyBottomRef.current,
          ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
        });
        return;
      }

      if (shouldPreserveExistingCache) {
        debugLog("thread.timeline.ui", "cache.preservedExisting", {
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
        debugLog("thread.timeline.ui", "cache.discarded", {
          threadId,
          reason: "invalid-viewport",
          itemCount: displayItemCount,
          stickyBottom: stickyBottomRef.current,
          ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
        });
        return;
      }

      cacheByThreadIdRef.current.delete(threadId);
      debugLog("thread.timeline.ui", "cache.discarded", {
        threadId,
        reason: "missing-cache",
        itemCount: displayItemCount,
        stickyBottom: stickyBottomRef.current,
        ...buildScrollMetrics(handle ?? null, handle?.scrollOffset ?? 0),
      });
    };
  }, [displayItemCount, persistRestorableCache, threadCacheSignature, threadId]);

  const displayItems = useMemo(() => {
    const result: Array<ChatTimelineItem | "thinking-placeholder" | "footer"> = [...items];
    if (showThinkingPlaceholder) {
      result.push("thinking-placeholder");
    }
    if (shouldRenderFooter) {
      result.push("footer");
    }
    return result;
  }, [items, shouldRenderFooter, showThinkingPlaceholder]);

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
      return items.length - 1;
    }

    return displayItems.length - 1;
  }, [displayItems.length, items, shouldRenderFooter, showThinkingPlaceholder]);

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
        debugLog("thread.timeline.ui", "scrollToBottom.skipped", {
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
        debugLog("thread.timeline.ui", "scrollToBottom.deferredUntilMeasured", {
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
        debugLog("thread.timeline.ui", "scrollToBottom.executed", {
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
      debugLog("thread.timeline.ui", "scrollRestore.deferredMissingHandle", {
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
      debugLog("thread.timeline.ui", "scrollRestore.deferredUntilMeasured", {
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
      debugLog("thread.timeline.ui", "scrollRestore.deferredForRange", {
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
    const commitRestore = () => {
      lastAppliedRestorableScrollSignatureRef.current = restorableScrollSignature;
      lastObservedScrollOffsetRef.current = clampedOffset;
      settlingProgrammaticBottomFollowRef.current = false;
      settlingProgrammaticBottomObservedSampleRef.current = false;
      stickyBottomRef.current = nextStickyBottom;
    };

    if (Math.abs(handle.scrollOffset - clampedOffset) <= 1) {
      commitRestore();
      debugLog("thread.timeline.ui", "scrollRestore.skippedAlreadyAligned", {
        threadId,
        source,
        attempt,
        displayItemCount,
        savedScrollOffset: roundScrollMetric(clampedOffset),
        stickyBottom: stickyBottomRef.current,
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
      debugLog("thread.timeline.ui", "scrollRestore.executed", {
        threadId,
        source,
        attempt,
        displayItemCount,
        savedScrollOffset: roundScrollMetric(clampedOffset),
        stickyBottom: stickyBottomRef.current,
        ...buildScrollMetrics(handle, handle.scrollOffset),
      });
      return "restored";
    } catch {
      debugLog("thread.timeline.ui", "scrollRestore.failed", {
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
        ) {
          return;
        }

        const distanceFromBottom =
          currentHandle.scrollSize - currentHandle.viewportSize - currentHandle.scrollOffset;
        if (distanceFromBottom <= AT_BOTTOM_THRESHOLD) {
          return;
        }

        debugLog("thread.timeline.ui", "scrollToBottom.realignAfterResize", {
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
      debugLog("thread.timeline.ui", "vlist.domState", {
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
    if (!stickyBottomRef.current || displayItems.length === 0) {
      return;
    }

    if (skipNextAutoFollowRef.current) {
      debugLog("thread.timeline.ui", "autoFollow.skippedForCacheRestore", {
        threadId,
        displayItemCount: displayItems.length,
      });
      skipNextAutoFollowRef.current = false;
      return;
    }

    scrollToBottom("preserve-user-anchor");
  }, [displayItems, scrollToBottom]);

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
        debugLog("thread.timeline.ui", "scrollRestore.waitingForResize", {
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
      debugLog("thread.timeline.ui", "scroll.ignored.initialTop", {
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
    const previousOffset = lastObservedScrollOffsetRef.current;
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
    const metrics = buildScrollMetrics(handle ?? null, offset);
    const scrollBucket = Math.floor(offset / THREAD_PAGINATION_SCROLL_SAMPLE_PX);
    const sampleSignature = [
      threadId ?? "no-thread",
      scrollBucket,
      stickyBottomRef.current ? "bottom" : "middle",
      initialPositiveScrollObservedRef.current ? "ready" : "initial",
    ].join(":");

    if (lastScrollSampleSignatureRef.current !== sampleSignature) {
      lastScrollSampleSignatureRef.current = sampleSignature;
      debugLog("thread.timeline.ui", "scroll.sample", {
        threadId,
        stickyBottom: stickyBottomRef.current,
        settlingProgrammaticBottomFollow: settlingProgrammaticBottomFollowRef.current,
        preservedDuringSettle: shouldPreserveStickyBottomDuringSettle,
        initialPositiveScrollObserved: initialPositiveScrollObservedRef.current,
        previousOffset: roundScrollMetric(previousOffset),
        ...metrics,
      });

      if (!stickyBottomRef.current) {
        persistRestorableCache("scroll-sample");
      }
    }
  }, [
    isAtBottom,
    persistRestorableCache,
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
    debugLog("thread.timeline.ui", "scroll.end", {
      threadId,
      displayItemCount: displayItems.length,
      stickyBottom: stickyBottomRef.current,
      shouldSnapToBottomAfterSettling,
      settlingProgrammaticBottomFollow: settlingProgrammaticBottomFollowRef.current,
      ...buildScrollMetrics(handle, currentOffset),
    });
    if (!stickyBottomRef.current && !shouldSnapToBottomAfterSettling) {
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
    isAtBottom,
    persistRestorableCache,
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
    }
  }, []);

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
          shift={false}
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
