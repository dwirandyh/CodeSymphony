import { useCallback, useRef, useState } from "react";
import type { TabItem } from "../../pages/workspace/editorGroups";
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

export type EditorPaneDropOverlayProps = {
  paneGroupId: EditorQuadrantId;
  layout: EditorLayoutMode;
  enabled?: boolean;
  /** True while a header tab is being dragged; hit target accepts pointer events only then. */
  tabDragActive?: boolean;
  onDrop: (tab: TabItem, target: PaneSplitDropTarget) => void;
};

export function EditorPaneDropOverlay({
  paneGroupId,
  layout,
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
          rect,
          clientX,
          clientY,
        }),
      );
    },
    [layout, paneGroupId],
  );

  if (!enabled) {
    return null;
  }

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute inset-0 z-20"
      data-testid={`editor-pane-drop-overlay-${paneGroupId}`}
    >
      <div
        data-testid="editor-pane-drop-hit"
        className={cn(
          "absolute inset-0",
          tabDragActive ? "pointer-events-auto" : "pointer-events-none",
        )}
        onDragEnter={(event) => {
          if (!tabDragActive || !hasEditorTabDragData(event.dataTransfer)) {
            return;
          }
          event.preventDefault();
          updateTarget(event.clientX, event.clientY);
        }}
        onDragOver={(event) => {
          if (!tabDragActive || !hasEditorTabDragData(event.dataTransfer)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          updateTarget(event.clientX, event.clientY);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setActiveTarget(null);
        }}
        onDrop={(event) => {
          const payload = readEditorTabDragData(event.dataTransfer);
          const host = hostRef.current;
          setActiveTarget(null);
          if (!payload || !host) {
            return;
          }
          event.preventDefault();
          const target = resolvePaneSplitDropTarget({
            layout,
            paneGroupId,
            rect: host.getBoundingClientRect(),
            clientX: event.clientX,
            clientY: event.clientY,
          });
          if (target === null) {
            return;
          }
          onDrop(payload.tab, target);
        }}
      />
      {activeTarget === "split-right" || activeTarget === "move-to-right" ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 w-1/4 border-l-2 border-primary bg-primary/10",
          )}
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