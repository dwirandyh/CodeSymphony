import { useCallback, useRef, useState } from "react";
import type { EditorGroup, TabItem } from "../../pages/workspace/editorGroups";
import type { EditorLayoutMode, EditorQuadrantId } from "../../pages/workspace/editorGroupTypes";
import {
  type PaneSplitDropTarget,
  resolvePaneSplitDropTarget,
} from "../../pages/workspace/editorPaneSplitDrop";
import { cn } from "../../lib/utils";
import {
  hasEditorTabDragData,
  readEditorTabDragData,
} from "./editorTabDrag";

const EDGE_BAND_CLASS = "w-1/4";

export type EditorPaneDropOverlayProps = {
  paneGroupId: EditorQuadrantId;
  layout: EditorLayoutMode;
  groups: Record<EditorQuadrantId, EditorGroup>;
  enabled?: boolean;
  /** True while a header tab is being dragged; only edge bands accept pointer events. */
  tabDragActive?: boolean;
  onDrop: (tab: TabItem, target: PaneSplitDropTarget) => void;
};

export function EditorPaneDropOverlay({
  paneGroupId,
  layout,
  groups,
  enabled = true,
  tabDragActive = false,
  onDrop,
}: EditorPaneDropOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [activeTarget, setActiveTarget] = useState<PaneSplitDropTarget | null>(null);

  const updateTarget = useCallback(
    (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) {
        setActiveTarget(null);
        return;
      }
      const rect = host.getBoundingClientRect();
      setActiveTarget(
        resolvePaneSplitDropTarget({
          layout,
          paneGroupId,
          groups,
          rect,
          clientX,
          clientY,
        }),
      );
    },
    [groups, layout, paneGroupId],
  );

  const handleDragEvent = useCallback(
    (event: React.DragEvent, phase: "enter" | "over" | "leave" | "drop") => {
      if (!tabDragActive || !hasEditorTabDragData(event.dataTransfer)) {
        return;
      }
      if (phase === "leave") {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setActiveTarget(null);
        return;
      }
      event.preventDefault();
      if (phase === "over") {
        event.dataTransfer.dropEffect = "move";
      }
      updateTarget(event.clientX, event.clientY);
      if (phase === "drop") {
        const payload = readEditorTabDragData(event.dataTransfer);
        const host = hostRef.current;
        setActiveTarget(null);
        if (!payload || !host) {
          return;
        }
        const target = resolvePaneSplitDropTarget({
          layout,
          paneGroupId,
          groups,
          rect: host.getBoundingClientRect(),
          clientX: event.clientX,
          clientY: event.clientY,
        });
        if (target === null) {
          return;
        }
        onDrop(payload.tab, target);
      }
    },
    [groups, layout, onDrop, paneGroupId, tabDragActive, updateTarget],
  );

  if (!enabled) {
    return null;
  }

  const edgeHitProps = tabDragActive
    ? {
        onDragEnter: (e: React.DragEvent) => handleDragEvent(e, "enter"),
        onDragOver: (e: React.DragEvent) => handleDragEvent(e, "over"),
        onDragLeave: (e: React.DragEvent) => handleDragEvent(e, "leave"),
        onDrop: (e: React.DragEvent) => handleDragEvent(e, "drop"),
      }
    : {};

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 z-20"
      data-testid={`editor-pane-drop-overlay-${paneGroupId}`}
    >
      <div
        data-testid="editor-pane-drop-hit-left"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0",
          EDGE_BAND_CLASS,
          tabDragActive && "pointer-events-auto",
        )}
        {...edgeHitProps}
      />
      <div
        data-testid="editor-pane-drop-hit-right"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0",
          EDGE_BAND_CLASS,
          tabDragActive && "pointer-events-auto",
        )}
        {...edgeHitProps}
      />
      {activeTarget === "split-right" || activeTarget === "move-to-right" ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/4 border-l-2 border-primary bg-primary/10"
          data-testid="editor-pane-drop-highlight-right"
        />
      ) : null}
      {activeTarget === "move-to-left" ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-1/4 border-r-2 border-primary bg-primary/10"
          data-testid="editor-pane-drop-highlight-move-to-left"
        />
      ) : null}
    </div>
  );
}