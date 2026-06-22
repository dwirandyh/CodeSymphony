import type { ReactNode } from "react";
import type { EditorGroup, TabItem } from "../../pages/workspace/editorGroups";
import type { EditorLayoutMode, EditorQuadrantId } from "../../pages/workspace/editorGroupTypes";
import type { PaneSplitDropTarget } from "../../pages/workspace/editorPaneSplitDrop";
import { cn } from "../../lib/utils";
import { EditorPaneDropOverlay } from "./EditorPaneDropOverlay";

function shouldSkipPaneFocusOnPointerTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const composerRoot = target.closest("[data-composer-root]");
  if (!composerRoot) {
    return false;
  }

  const editable = target.closest("[contenteditable='true']");
  return editable instanceof HTMLElement && composerRoot.contains(editable);
}

export type EditorSurfaceFrameProps = {
  paneGroupId: EditorQuadrantId;
  layout: EditorLayoutMode;
  groups: Record<import("../../pages/workspace/editorGroupTypes").EditorQuadrantId, EditorGroup>;
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
  groups,
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
      onMouseDown={(event) => {
        if (shouldSkipPaneFocusOnPointerTarget(event.target)) {
          return;
        }
        onFocusPane?.();
      }}
    >
      {children}
      <EditorPaneDropOverlay
        paneGroupId={paneGroupId}
        layout={layout}
        groups={groups}
        enabled={paneDropEnabled}
        tabDragActive={tabDragActive}
        onDrop={onPaneDrop}
      />
    </div>
  );
}