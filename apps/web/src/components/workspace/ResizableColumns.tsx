import React, { useCallback, useEffect, useRef, useState } from "react";
import { defaultColumnWidthPercents, normalizeColumnWidths } from "../../pages/workspace/editorColumns";

export type ResizableColumnsProps = {
  columnWidths: number[];
  onColumnWidthsChange: (widths: number[]) => void;
  columns: React.ReactNode[];
};

export function ResizableColumns({
  columnWidths,
  onColumnWidthsChange,
  columns,
}: ResizableColumnsProps) {
  const count = columns.length;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draggingDividerIndex, setDraggingDividerIndex] = useState<number | null>(null);

  const widths =
    count === 0
      ? []
      : normalizeColumnWidths(
          columnWidths.length === count ? columnWidths : defaultColumnWidthPercents(count),
          count,
        );

  const handleMouseDown = useCallback((dividerIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    setDraggingDividerIndex(dividerIndex);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (draggingDividerIndex === null || !containerRef.current || count < 2) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const pointerPercent = (relativeX / rect.width) * 100;

      const leftCols = draggingDividerIndex + 1;
      const leftSum = widths.slice(0, leftCols).reduce((a, b) => a + b, 0);
      const minLeft = 12 * leftCols;
      const maxLeft = 100 - 12 * (count - leftCols);
      const targetLeftSum = Math.max(minLeft, Math.min(maxLeft, pointerPercent));
      const delta = targetLeftSum - leftSum;

      const next = [...widths];
      const rightCol = draggingDividerIndex + 1;
      const leftCol = draggingDividerIndex;
      next[leftCol] = Math.max(12, next[leftCol] + delta);
      next[rightCol] = Math.max(12, next[rightCol] - delta);
      onColumnWidthsChange(normalizeColumnWidths(next, count));
    },
    [count, draggingDividerIndex, onColumnWidthsChange, widths],
  );

  const handleMouseUp = useCallback(() => {
    setDraggingDividerIndex(null);
  }, []);

  useEffect(() => {
    if (draggingDividerIndex !== null) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    } else {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingDividerIndex, handleMouseMove, handleMouseUp]);

  if (count === 0) {
    return null;
  }

  if (count === 1) {
    return (
      <div className="flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden">{columns[0]}</div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative flex h-full w-full min-h-0 min-w-0 overflow-hidden ${
        draggingDividerIndex !== null ? "cursor-col-resize select-none" : ""
      }`}
      data-testid="resizable-columns"
    >
      {columns.map((col, index) => (
        <React.Fragment key={index}>
          <div
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
            style={{ flex: `${widths[index]} 1 0` }}
            data-testid={`resizable-column-${index}`}
          >
            {col}
          </div>
          {index < count - 1 ? (
            <div
              onMouseDown={handleMouseDown(index)}
              className="relative z-30 h-full w-1 shrink-0 cursor-col-resize bg-border/40 transition-colors hover:bg-primary/50"
              data-testid={`resizable-column-divider-${index}`}
            />
          ) : null}
        </React.Fragment>
      ))}
    </div>
  );
}