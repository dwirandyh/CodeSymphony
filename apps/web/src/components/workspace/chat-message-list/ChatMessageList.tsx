import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Loader2, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { isRenderDebugEnabled, copyRenderDebugLog } from "../../../lib/renderDebug";
import { VList, type VListHandle } from "virtua";
import type {
  ChatMessageListEmptyState,
  ChatMessageListProps,
  ChatTimelineItem,
  TimelineCtx,
} from "./ChatMessageList.types";
import { getTimelineItemKey } from "./toolEventUtils";
import { TimelineItem, ThinkingPlaceholder } from "./TimelineItem";

const AT_BOTTOM_THRESHOLD = 48;

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

function getTimelineRowClassName(item: ChatTimelineItem): string {
  const isCompactRunningRow =
    (item.kind === "activity" && item.defaultExpanded) ||
    (item.kind === "subagent-activity" && item.status === "running") ||
    (item.kind === "explore-activity" && item.status === "running") ||
    (item.kind === "tool" && item.status === "running");

  return `mx-auto max-w-3xl px-3 ${isCompactRunningRow ? "pb-2" : "pb-4"}`;
}

export function ChatMessageList({
  items,
  emptyState = "existing-thread-empty",
  showThinkingPlaceholder = false,
  onOpenReadFile,
}: ChatMessageListProps) {
  const vlistRef = useRef<VListHandle>(null);
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

  const stickyBottomRef = useRef(true);

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
    setTimeout(() => setCopiedMessageId(null), 2000);
  }, []);

  const copyDebugLog = useCallback(() => {
    copyRenderDebugLog();
    setCopiedDebug(true);
    setTimeout(() => setCopiedDebug(false), 2000);
  }, []);

  const displayItems = useMemo(() => {
    const result: Array<ChatTimelineItem | "thinking-placeholder"> = [...items];
    if (showThinkingPlaceholder) {
      result.push("thinking-placeholder");
    }
    return result;
  }, [items, showThinkingPlaceholder]);

  const getAutoFollowTargetIndex = useCallback((mode: "preserve-user-anchor" | "bottom" = "preserve-user-anchor") => {
    if (displayItems.length === 0) {
      return null;
    }

    if (mode === "bottom") {
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
  }, [displayItems.length, items, showThinkingPlaceholder]);

  const scrollToBottom = useCallback((mode: "preserve-user-anchor" | "bottom" = "preserve-user-anchor") => {
    const handle = vlistRef.current;
    const targetIndex = getAutoFollowTargetIndex(mode);
    if (!handle || targetIndex == null) return;
    try {
      handle.scrollToIndex(targetIndex, { align: "end" });
    } catch {
      // scroll fallback
    }
  }, [getAutoFollowTargetIndex]);

  useEffect(() => {
    if (!stickyBottomRef.current || displayItems.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      scrollToBottom("preserve-user-anchor");
    });
  }, [displayItems, scrollToBottom]);

  const isAtBottom = useCallback((offset: number) => {
    const handle = vlistRef.current;
    if (!handle) {
      return stickyBottomRef.current;
    }

    const distanceFromBottom = handle.scrollSize - handle.viewportSize - offset;
    return distanceFromBottom <= AT_BOTTOM_THRESHOLD;
  }, []);

  const handleScroll = useCallback((offset: number) => {
    stickyBottomRef.current = isAtBottom(offset);
  }, [isAtBottom]);

  const handleScrollEnd = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle || displayItems.length === 0) return;

    stickyBottomRef.current = isAtBottom(handle.scrollOffset);
    if (!stickyBottomRef.current) return;
    scrollToBottom("bottom");
  }, [displayItems.length, isAtBottom, scrollToBottom]);

  const timelineCtx: TimelineCtx = useMemo(
    () => ({
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      toggleRawOutput,
      copyOutput,
      copyDebugLog,
      onOpenReadFile,
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
    }),
    [
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      toggleRawOutput,
      copyOutput,
      copyDebugLog,
      onOpenReadFile,
      toolExpandedById,
      editedExpandedById,
      exploreActivityExpandedById,
      subagentExpandedById,
      subagentPromptExpandedById,
      subagentExploreExpandedById,
    ],
  );

  return (
    <div
      className="relative h-full min-h-0"
      data-testid="chat-scroll"
    >
      {items.length === 0 && !showThinkingPlaceholder ? (
        emptyState ? <EmptyStateCard state={emptyState} /> : null
      ) : (
        <VList
          ref={vlistRef}
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
              <div key={getTimelineItemKey(item)} className={getTimelineRowClassName(item)}>
                <TimelineItem item={item} ctx={timelineCtx} />
              </div>
            );
          })}
        </VList>
      )}
    </div>
  );
}
