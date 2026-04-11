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

function EmptyStateCard({ state }: { state: ChatMessageListEmptyState }) {
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
      case "loading-thread":
        return {
          icon: History,
          title: "Loading thread history",
          description: "Fetching previous messages and activity for this thread...",
          iconClassName: "animate-pulse",
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
    }
  })();
  const Icon = content.icon;

  return (
    <div className="flex h-full items-center justify-center px-3 py-6">
      <div className="w-full max-w-xl rounded-3xl border border-border/70 bg-card/80 px-6 py-7 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
          <Icon className={`h-5 w-5 ${content.iconClassName}`.trim()} />
        </div>
        <div className="mt-4 space-y-1.5">
          <h2 className="text-sm font-semibold text-foreground">{content.title}</h2>
          <p className="text-xs leading-5 text-muted-foreground">{content.description}</p>
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

  const getAutoFollowTargetIndex = useCallback(() => {
    if (displayItems.length === 0) {
      return null;
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

  const scrollToBottom = useCallback(() => {
    const handle = vlistRef.current;
    const targetIndex = getAutoFollowTargetIndex();
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
      scrollToBottom();
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
    scrollToBottom();
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
