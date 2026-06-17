import { useEffect, type ReactNode } from "react";
import {
  probeSplitTabStripAlignment,
  scheduleWorkspaceUiGeometryProbe,
} from "../../lib/workspaceUiDiagnose";

export type SplitEditorTabStripsProps = {
  dividerPosition: number;
  left: ReactNode;
  right: ReactNode;
};

/**
 * Header tab row for split editor mode. Left pane width tracks {@link dividerPosition};
 * a fixed-width gutter matches {@link ResizableSplit}'s `w-1` divider so tab baselines
 * align with the editor split (avoids a T-junction between tab underline and pane divider).
 */
export function SplitEditorTabStrips({
  dividerPosition,
  left,
  right,
}: SplitEditorTabStripsProps) {
  useEffect(() => {
    scheduleWorkspaceUiGeometryProbe(() => {
      probeSplitTabStripAlignment(dividerPosition);
    });
  }, [dividerPosition, left, right]);

  return (
    <div
      className="flex min-w-0 w-full items-center border-b border-border/40"
      data-testid="split-tab-strips"
    >
      <div
        className="flex min-w-0 items-center overflow-hidden"
        style={{ width: `${dividerPosition}%` }}
        data-testid="split-tab-strips-left"
      >
        {left}
      </div>
      <div
        className="w-1 shrink-0 bg-border/40 pointer-events-none"
        data-testid="split-tab-strips-divider-gutter"
        aria-hidden="true"
      />
      <div
        className="flex min-w-0 items-center overflow-hidden"
        style={{ width: `calc(${100 - dividerPosition}% - 0.25rem)` }}
        data-testid="split-tab-strips-right"
      >
        {right}
      </div>
    </div>
  );
}