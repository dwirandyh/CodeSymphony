import React, { useRef, useState, useCallback, useEffect } from "react";

interface ResizableSplitProps {
  splitMode: boolean;
  dividerPosition: number;
  onDividerPositionChange: (pos: number) => void;
  left: React.ReactNode;
  right: React.ReactNode;
}

export function ResizableSplit({
  splitMode,
  dividerPosition,
  onDividerPositionChange,
  left,
  right,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      const percentage = (relativeX / rect.width) * 100;
      // Clamp between 20% and 80% to avoid extreme sizes
      const clamped = Math.max(20, Math.min(80, percentage));
      onDividerPositionChange(clamped);
    },
    [isDragging, onDividerPositionChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
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
  }, [isDragging, handleMouseMove, handleMouseUp]);

  if (!splitMode) {
    return <div className="h-full w-full min-h-0 min-w-0 overflow-hidden flex flex-col">{left}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 overflow-hidden relative ${
        isDragging ? "cursor-col-resize select-none" : ""
      }`}
    >
      <div className="h-full min-h-0 min-w-0 overflow-hidden" style={{ width: `${dividerPosition}%` }}>
        {left}
      </div>
      <div
        onMouseDown={handleMouseDown}
        className="w-1 bg-border/40 hover:bg-primary/50 cursor-col-resize transition-colors flex-shrink-0 relative z-30 h-full"
      />
      <div className="h-full min-h-0 min-w-0 overflow-hidden" style={{ width: `${100 - dividerPosition}%` }}>
        {right}
      </div>
    </div>
  );
}
