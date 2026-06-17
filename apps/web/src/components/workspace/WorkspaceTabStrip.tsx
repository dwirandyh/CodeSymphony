import { useEffect, useRef, useState } from "react";
import {
  CalendarCog,
  Columns2,
  Dot,
  GitPullRequestArrow,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ChatThread } from "@codesymphony/shared-types";
import type { TabItem } from "../../pages/workspace/editorGroups";
import type { EditorQuadrantId } from "../../pages/workspace/editorGroupTypes";
import type { WorkspaceFileTab, WorkspaceTerminalTab } from "./WorkspaceHeader";
import { cn } from "../../lib/utils";
import {
  hasEditorTabDragData,
  readEditorTabDragData,
  writeEditorTabDragData,
} from "./editorTabDrag";

const SESSION_TAB_EDGE_INSET_PX = 64;

export interface WorkspaceTabStripPendingThread {
  id: string;
  title: string;
}

export interface WorkspaceTabStripProps {
  groupId: EditorQuadrantId;
  tabs: TabItem[];
  activeTabId: string | null;
  threads: ChatThread[];
  /** A selected thread that has not yet surfaced in `threads`; rendered as a non-closable pending tab. */
  pendingThread?: WorkspaceTabStripPendingThread | null;
  terminalTabs: WorkspaceTerminalTab[];
  fileTabs: WorkspaceFileTab[];
  disabled?: boolean;
  closingThreadId?: string | null;
  protectedThreadId?: string | null;
  /** When false the strip stretches to fill (split panes); when true (header) it grows to content. */
  fillWidth?: boolean;
  /** Header-only: desktop keeps the row content-width, web flexes it to fill. */
  desktopApp?: boolean;
  isActiveGroup?: boolean;
  /** Scroll the selected tab into view when it nears the strip edge (single-row header behavior). */
  enableScrollIntoView?: boolean;
  onSelectTab: (tab: TabItem) => void;
  onCloseTab: (tab: TabItem) => void;
  /** Optional Columns2 quick-split action; hidden when omitted. */
  onSplitTab?: (tab: TabItem) => void;
  /** Reorder within this group. Omit to disable in-row reordering. */
  onReorderTab?: (tabId: string, toIndex: number) => void;
  /** Accept a tab dragged from the other group, inserting at toIndex. */
  onDropTabFromOtherGroup?: (tab: TabItem, sourceGroupId: EditorQuadrantId, toIndex: number) => void;
  onPinFileTab?: (path: string) => void;
  onRenameThread?: (threadId: string, title: string) => void | Promise<void>;
  onRenameTerminalTab?: (terminalTabId: string, title: string) => void | Promise<void>;
  onPrefetchThread?: (threadId: string) => void;
  onFocusGroup?: () => void;
  onTabDragStart?: () => void;
  onTabDragEnd?: () => void;
}

function fileTabLabel(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}

interface ResolvedTab {
  label: string;
  title: string;
  closeLabel: string;
  closeTitle: string;
  icon: React.ReactNode;
  dirty: boolean;
  unpinnedFile: boolean;
  renamable: "thread" | "terminal" | "file" | null;
  pending: boolean;
}

export function WorkspaceTabStrip({
  groupId,
  tabs,
  activeTabId,
  threads,
  pendingThread = null,
  terminalTabs,
  fileTabs,
  disabled = false,
  closingThreadId = null,
  protectedThreadId = null,
  fillWidth = false,
  desktopApp = false,
  isActiveGroup = true,
  enableScrollIntoView = false,
  onSelectTab,
  onCloseTab,
  onSplitTab,
  onReorderTab,
  onDropTabFromOtherGroup,
  onPinFileTab,
  onRenameThread,
  onRenameTerminalTab,
  onPrefetchThread,
  onFocusGroup,
  onTabDragStart,
  onTabDragEnd,
}: WorkspaceTabStripProps) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isCrossGroupTarget, setIsCrossGroupTarget] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedTabRef = useRef<HTMLButtonElement | null>(null);

  const isAnyThreadClosing = closingThreadId !== null;

  function resolveTab(tab: TabItem): ResolvedTab {
    if (tab.type === "chat") {
      const live = threads.find((t) => t.id === tab.id);
      const pending = !live && pendingThread?.id === tab.id;
      const thread = live ?? null;
      const title = thread?.title ?? pendingThread?.title ?? "Loading thread...";
      return {
        label: title,
        title,
        closeLabel: `Close session ${title}`,
        closeTitle: `Close ${title}`,
        icon: thread?.isAutomation ? (
          <CalendarCog
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            data-testid={`thread-${tab.id}-automation-icon`}
            aria-hidden="true"
          />
        ) : null,
        dirty: false,
        unpinnedFile: false,
        renamable: pending ? null : "thread",
        pending,
      };
    }

    if (tab.type === "terminal") {
      const term = terminalTabs.find((t) => t.id === tab.id);
      const title = term?.title ?? "Terminal";
      return {
        label: title,
        title,
        closeLabel: `Close terminal ${title}`,
        closeTitle: `Close ${title}`,
        icon: <SquareTerminal className="h-3.5 w-3.5 shrink-0" />,
        dirty: false,
        unpinnedFile: false,
        renamable: "terminal",
        pending: false,
      };
    }

    if (tab.type === "review") {
      return {
        label: "Review Changes",
        title: "Review Changes",
        closeLabel: "Close review tab",
        closeTitle: "Close review",
        icon: <GitPullRequestArrow className="h-3 w-3" />,
        dirty: false,
        unpinnedFile: false,
        renamable: null,
        pending: false,
      };
    }

    // file
    const fileTab = fileTabs.find((f) => f.path === tab.id);
    const label = fileTabLabel(tab.id);
    return {
      label,
      title: tab.id,
      closeLabel: `Close file ${label}`,
      closeTitle: `Close ${label}`,
      icon: null,
      dirty: fileTab?.dirty ?? false,
      unpinnedFile: !(fileTab?.pinned ?? false),
      renamable: "file",
      pending: false,
    };
  }

  useEffect(() => {
    if (!editingTabId) {
      return;
    }
    const stillPresent = tabs.some((t) => t.id === editingTabId);
    if (!stillPresent) {
      setEditingTabId(null);
    }
  }, [editingTabId, tabs]);

  useEffect(() => {
    if (!editingTabId) {
      return;
    }
    const input = renameInputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [editingTabId]);

  useEffect(() => {
    if (!enableScrollIntoView) {
      return;
    }
    const scrollRegion = scrollRef.current;
    const selected = selectedTabRef.current;
    if (!scrollRegion || !selected) {
      return;
    }
    if (typeof selected.scrollIntoView !== "function") {
      return;
    }

    const scrollRegionRect = scrollRegion.getBoundingClientRect();
    const selectedRect = selected.getBoundingClientRect();
    const tooCloseToLeftEdge = selectedRect.left < scrollRegionRect.left + SESSION_TAB_EDGE_INSET_PX;
    const tooCloseToRightEdge = selectedRect.right > scrollRegionRect.right - SESSION_TAB_EDGE_INSET_PX;
    if (!tooCloseToLeftEdge && !tooCloseToRightEdge) {
      return;
    }

    selected.scrollIntoView({ block: "nearest", inline: "center" });
  }, [enableScrollIntoView, activeTabId, tabs]);

  function startRename(tab: TabItem, isSelected: boolean, resolved: ResolvedTab) {
    if (!isSelected || disabled || !resolved.renamable || resolved.pending) {
      return;
    }
    if (resolved.renamable === "file") {
      onPinFileTab?.(tab.id);
      return;
    }
    setEditingTabId(tab.id);
  }

  function cancelRename() {
    setEditingTabId(null);
  }

  function saveRename(tab: TabItem, currentTitle: string, rawTitle: string) {
    if (editingTabId !== tab.id) {
      return;
    }
    const nextTitle = rawTitle.trim();
    cancelRename();
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }
    if (tab.type === "chat") {
      void onRenameThread?.(tab.id, nextTitle);
    } else if (tab.type === "terminal") {
      void onRenameTerminalTab?.(tab.id, nextTitle);
    }
  }

  function computeInsertIndex(event: React.DragEvent<HTMLDivElement>): number {
    // Determine which tab the pointer is over and whether it is past the midpoint.
    const row = event.currentTarget;
    const tabEls = Array.from(row.querySelectorAll<HTMLElement>("[data-tab-index]"));
    for (const el of tabEls) {
      const rect = el.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        return Number(el.dataset.tabIndex);
      }
    }
    return tabs.length;
  }

  function handleRowDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!hasEditorTabDragData(event.dataTransfer)) {
      return;
    }
    const payload = readEditorTabDragData(event.dataTransfer);
    if (!payload) {
      return;
    }
    const sameGroup = payload.sourceGroupId === groupId;
    if (sameGroup && !onReorderTab) {
      return;
    }
    if (!sameGroup && !onDropTabFromOtherGroup) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropIndex(computeInsertIndex(event));
    setIsCrossGroupTarget(!sameGroup);
  }

  function handleRowDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDropIndex(null);
    setIsCrossGroupTarget(false);
  }

  function handleRowDrop(event: React.DragEvent<HTMLDivElement>) {
    const payload = readEditorTabDragData(event.dataTransfer);
    const targetIndex = dropIndex ?? computeInsertIndex(event);
    setDropIndex(null);
    setIsCrossGroupTarget(false);
    if (!payload) {
      return;
    }
    event.preventDefault();

    if (payload.sourceGroupId === groupId) {
      if (!onReorderTab) {
        return;
      }
      const fromIndex = tabs.findIndex((t) => t.id === payload.tab.id);
      if (fromIndex === -1) {
        return;
      }
      // Removing the source shifts indexes after it; account for that.
      const adjusted = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
      onReorderTab(payload.tab.id, adjusted);
      return;
    }

    onDropTabFromOtherGroup?.(payload.tab, payload.sourceGroupId, targetIndex);
  }

  return (
    <div
      ref={scrollRef}
      onClick={onFocusGroup}
      onDragOver={handleRowDragOver}
      onDragLeave={handleRowDragLeave}
      onDrop={handleRowDrop}
      onDragEnd={() => onTabDragEnd?.()}
      className={cn(
        "min-w-0 overflow-x-auto overscroll-x-contain scroll-px-16 [scrollbar-color:hsl(var(--border))_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-[3px] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/60 hover:[&::-webkit-scrollbar-thumb]:bg-border/80",
        fillWidth ? "flex-1" : (desktopApp ? "max-w-full" : "flex-1"),
        fillWidth && !isActiveGroup && "opacity-85",
        isCrossGroupTarget && "bg-primary/5",
      )}
      role="tablist"
      aria-label="Sessions"
      data-testid={fillWidth ? `editor-tab-bar-${groupId}` : "session-tabs-scroll"}
    >
      <div className={cn("flex w-max items-center gap-0.5 whitespace-nowrap", fillWidth && "min-w-full")}>
        {tabs.map((tab, index) => {
          const resolved = resolveTab(tab);
          const selected = activeTabId === tab.id;
          const isEditing = editingTabId === tab.id;
          const isProtected = tab.type === "chat" && protectedThreadId === tab.id;
          const showDropMarkerBefore = dropIndex === index;

          const closeDisabled = tab.type === "chat"
            ? (disabled || resolved.pending || isAnyThreadClosing || isEditing || isProtected)
            : (disabled || isEditing);

          return (
            <div
              key={`${tab.type}:${tab.id}`}
              data-tab-index={index}
              draggable={!isEditing}
              onDragStart={(event) => {
                writeEditorTabDragData(event.dataTransfer, {
                  sourceGroupId: groupId,
                  sourceIndex: index,
                  tab,
                });
                onTabDragStart?.();
              }}
              className={cn(
                "group flex shrink-0 items-center border-b-2 border-b-transparent text-muted-foreground",
                selected && "border-b-primary text-foreground",
                showDropMarkerBefore && "border-l-2 border-l-primary",
              )}
            >
              {isEditing && resolved.renamable && resolved.renamable !== "file" ? (
                <input
                  ref={renameInputRef}
                  defaultValue={resolved.title}
                  onBlur={(event) => saveRename(tab, resolved.title, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveRename(tab, resolved.title, event.currentTarget.value);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  aria-label={resolved.renamable === "thread" ? "Rename thread title" : "Rename terminal tab title"}
                  className="w-[180px] rounded-sm border border-border bg-background px-2 py-1 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              ) : (
                <button
                  ref={selected ? selectedTabRef : null}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={resolved.title}
                  className={cn(
                    "flex max-w-[180px] min-w-0 items-center gap-1.5 px-2 py-1.5 text-xs font-medium transition-colors",
                    resolved.unpinnedFile && "italic text-muted-foreground/90",
                    selected && "text-foreground",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectTab(tab);
                  }}
                  onDoubleClick={() => startRename(tab, selected, resolved)}
                  onPointerEnter={tab.type === "chat" ? () => onPrefetchThread?.(tab.id) : undefined}
                  onFocus={tab.type === "chat" ? () => onPrefetchThread?.(tab.id) : undefined}
                  disabled={disabled}
                >
                  {resolved.icon}
                  <span className="truncate">{resolved.label}</span>
                  {resolved.dirty ? <Dot className="ml-1 inline h-4 w-4 align-middle text-amber-500" /> : null}
                </button>
              )}

              {onSplitTab ? (
                <button
                  type="button"
                  aria-label={`Split ${resolved.label}`}
                  title={`Split ${resolved.label}`}
                  className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSplitTab(tab);
                  }}
                  disabled={disabled}
                >
                  <Columns2 className="h-3 w-3" />
                </button>
              ) : null}

              <button
                type="button"
                aria-label={resolved.closeLabel}
                title={resolved.closeTitle}
                className={cn(
                  "rounded-sm p-1 text-muted-foreground transition-opacity hover:text-destructive disabled:opacity-50",
                  selected ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab);
                }}
                disabled={closeDisabled}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
