import React, { useEffect, type ReactNode } from "react";
import { defaultColumnWidthPercents, normalizeColumnWidths } from "../../pages/workspace/editorColumns";
import {
  probeSplitTabStripAlignment,
  scheduleWorkspaceUiGeometryProbe,
} from "../../lib/workspaceUiDiagnose";

export type EditorMultiTabStripsProps = {
  columnWidths: number[];
  strips: ReactNode[];
};

/** Header tab row aligned with {@link ResizableColumns} gutter positions. */
export function EditorMultiTabStrips({ columnWidths, strips }: EditorMultiTabStripsProps) {
  const count = strips.length;
  const widths = normalizeColumnWidths(
    columnWidths.length === count ? columnWidths : defaultColumnWidthPercents(count),
    count,
  );

  useEffect(() => {
    if (count < 2) {
      return;
    }
    scheduleWorkspaceUiGeometryProbe(() => {
      probeSplitTabStripAlignment(widths[0] ?? 50);
    });
  }, [count, widths]);

  if (count === 0) {
    return null;
  }

  if (count === 1) {
    return (
      <div className="flex min-w-0 w-full border-b border-border/40" data-testid="editor-tab-header">
        {strips[0]}
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-w-0 w-full items-stretch border-b border-border/40"
      data-testid="split-tab-strips"
    >
      {strips.map((strip, index) => (
        <React.Fragment key={index}>
          <div
            className="flex min-h-8 min-w-0 flex-1 items-stretch overflow-hidden"
            style={{ flex: `${widths[index]} 1 0` }}
            data-testid={`split-tab-strips-column-${index}`}
          >
            {strip}
          </div>
          {index < count - 1 ? (
            <div className="w-1 shrink-0 bg-border/40 pointer-events-none" aria-hidden="true" />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}