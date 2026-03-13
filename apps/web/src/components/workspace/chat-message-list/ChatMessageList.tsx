import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRenderDebugEnabled, copyRenderDebugLog } from "../../../lib/renderDebug";
import { VList, type VListHandle } from "virtua";
import type { ChatMessageListProps, ChatTimelineItem, TimelineCtx } from "./ChatMessageList.types";
import { getTimelineItemKey } from "./toolEventUtils";
import { TimelineItem, ThinkingPlaceholder } from "./TimelineItem";

const AT_BOTTOM_THRESHOLD = 48;

export function ChatMessageList({
  items,
  showThinkingPlaceholder = false,
  onOpenReadFile,
}: ChatMessageListProps) {
  const vlistRef = useRef<VListHandle>(null);
  const scrollWrapperRef = useRef<HTMLDivElement>(null);
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

  const stickyBottomRef = useRef(true);
  const lastScrollOffsetRef = useRef(0);

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

  const scrollToBottom = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle || displayItems.length === 0) return;
    try {
      handle.scrollToIndex(displayItems.length - 1, { align: "end" });
    } catch {
      // scroll fallback
    }
  }, [displayItems.length]);

  useEffect(() => {
    if (!stickyBottomRef.current || displayItems.length === 0) {
      return;
    }
    requestAnimationFrame(() => {
      scrollToBottom();
    });
  }, [displayItems.length, scrollToBottom]);

  const handleScroll = useCallback((offset: number) => {
    const previousOffset = lastScrollOffsetRef.current;
    const isScrollingUp = offset < previousOffset;

    if (isScrollingUp) {
      stickyBottomRef.current = false;
    } else if (offset - previousOffset > AT_BOTTOM_THRESHOLD) {
      stickyBottomRef.current = true;
    }

    lastScrollOffsetRef.current = offset;
  }, []);

  const handleScrollEnd = useCallback(() => {
    if (!stickyBottomRef.current || displayItems.length === 0) return;
    scrollToBottom();
  }, [displayItems.length, scrollToBottom]);

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
    [
      rawOutputMessageIds,
      copiedMessageId,
      copiedDebug,
      renderDebugEnabled,
      toggleRawOutput,
      copyOutput,
      copyDebugLog,
      onOpenReadFile,
      bashExpandedById,
      editedExpandedById,
      exploreActivityExpandedById,
      subagentExpandedById,
      subagentPromptExpandedById,
      subagentExploreExpandedById,
    ],
  );

  return (
    <div
      ref={scrollWrapperRef}
      className="relative h-full min-h-0"
      data-testid="chat-scroll"
    >
      {items.length === 0 && !showThinkingPlaceholder ? (
        <div className="py-10 text-center text-xs text-muted-foreground">No messages yet. Send a prompt to start.</div>
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
