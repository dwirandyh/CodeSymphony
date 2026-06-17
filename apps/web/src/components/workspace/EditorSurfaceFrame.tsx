import type { ReactNode } from "react";
import type { TabItem } from "../../pages/workspace/editorGroups";
import type { EditorLayoutMode, EditorQuadrantId } from "../../pages/workspace/editorGroupTypes";
import type { PaneSplitDropTarget } from "../../pages/workspace/editorPaneSplitDrop";
import { cn } from "../../lib/utils";
import { EditorPaneDropOverlay } from "./EditorPaneDropOverlay";

export type EditorSurfaceFrameProps = {
  paneGroupId: EditorQuadrantId;
  layout: EditorLayoutMode;
  /** Mount pane-edge drop target (split drops). */
  paneDropEnabled?: boolean;
  tabDragActive?: boolean;
  className?: string;
  onPaneDrop: (tab: TabItem, target: PaneSplitDropTarget) => void;
  onFocusPane?: () => void;
  children: ReactNode;
};

export function EditorSurfaceFrame({
  paneGroupId,
  layout,
  paneDropEnabled = true,
  tabDragActive = false,
  className,
  onPaneDrop,
  onFocusPane,
  children,
}: EditorSurfaceFrameProps) {
  return (
    <div
      className={cn("relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}
      data-testid={`editor-surface-frame-${paneGroupId}`}
      onMouseDown={onFocusPane}
    >
      {children}
      <EditorPaneDropOverlay
        paneGroupId={paneGroupId}
        layout={layout}
        enabled={paneDropEnabled}
        tabDragActive={tabDragActive}
        onDrop={onPaneDrop}
      />
    </div>
  );
}