import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "../../lib/utils";

const MIN_IMAGE_SCALE = 1;
const MAX_IMAGE_SCALE = 4;
const IMAGE_SCALE_STEP = 0.5;

type Point = {
  x: number;
  y: number;
};

type Offset = {
  x: number;
  y: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampImageScale(scale: number): number {
  return clamp(scale, MIN_IMAGE_SCALE, MAX_IMAGE_SCALE);
}

function getDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getMidpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function clampOffset(offset: Offset, scale: number, container: HTMLDivElement | null): Offset {
  if (!container || scale <= 1) {
    return { x: 0, y: 0 };
  }

  const maxX = ((container.clientWidth ?? 0) * (scale - 1)) / 2;
  const maxY = ((container.clientHeight ?? 0) * (scale - 1)) / 2;

  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY),
  };
}

export const ZoomableImage = memo(function ZoomableImage({
  src,
  alt,
  containerClassName,
  imageClassName,
  hintText = "Pinch or scroll to zoom",
}: {
  src: string;
  alt: string;
  containerClassName?: string;
  imageClassName?: string;
  hintText?: string;
}) {
  const [scale, setScale] = useState(MIN_IMAGE_SCALE);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pointerPositionsRef = useRef(new Map<number, Point>());
  const dragStateRef = useRef<{ pointerId: number; startPoint: Point; startOffset: Offset } | null>(null);
  const pinchStateRef = useRef<{ startDistance: number; startScale: number; startOffset: Offset; startMidpoint: Point } | null>(null);

  const resetView = useCallback(() => {
    pointerPositionsRef.current.clear();
    dragStateRef.current = null;
    pinchStateRef.current = null;
    setScale(MIN_IMAGE_SCALE);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetView();
  }, [resetView, src]);

  const updateScale = useCallback((nextScale: number) => {
    const clampedScale = clampImageScale(nextScale);
    setScale(clampedScale);
    setOffset((currentOffset) => clampOffset(currentOffset, clampedScale, viewportRef.current));
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? IMAGE_SCALE_STEP : -IMAGE_SCALE_STEP;
    updateScale(scale + delta);
  }, [scale, updateScale]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointerPositionsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointerPositionsRef.current.size === 1 && scale > 1) {
      dragStateRef.current = {
        pointerId: event.pointerId,
        startPoint: { x: event.clientX, y: event.clientY },
        startOffset: offset,
      };
    }

    if (pointerPositionsRef.current.size === 2) {
      const [first, second] = [...pointerPositionsRef.current.values()];
      pinchStateRef.current = {
        startDistance: getDistance(first, second),
        startScale: scale,
        startOffset: offset,
        startMidpoint: getMidpoint(first, second),
      };
      dragStateRef.current = null;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
  }, [offset, scale]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const currentPoint = { x: event.clientX, y: event.clientY };
    pointerPositionsRef.current.set(event.pointerId, currentPoint);

    if (pointerPositionsRef.current.size >= 2) {
      const pinchState = pinchStateRef.current;
      if (!pinchState) {
        return;
      }
      const [first, second] = [...pointerPositionsRef.current.values()];
      const nextScale = clampImageScale((getDistance(first, second) / pinchState.startDistance) * pinchState.startScale);
      const midpoint = getMidpoint(first, second);
      const nextOffset = clampOffset({
        x: pinchState.startOffset.x + (midpoint.x - pinchState.startMidpoint.x),
        y: pinchState.startOffset.y + (midpoint.y - pinchState.startMidpoint.y),
      }, nextScale, viewportRef.current);
      setScale(nextScale);
      setOffset(nextOffset);
      return;
    }

    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || scale <= 1) {
      return;
    }

    setOffset(clampOffset({
      x: dragState.startOffset.x + (currentPoint.x - dragState.startPoint.x),
      y: dragState.startOffset.y + (currentPoint.y - dragState.startPoint.y),
    }, scale, viewportRef.current));
  }, [scale]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointerPositionsRef.current.delete(event.pointerId);

    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
    }

    if (pointerPositionsRef.current.size < 2) {
      pinchStateRef.current = null;
    }

    if (pointerPositionsRef.current.size === 1 && scale > 1) {
      const [pointerId, point] = [...pointerPositionsRef.current.entries()][0];
      dragStateRef.current = {
        pointerId,
        startPoint: point,
        startOffset: offset,
      };
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [offset, scale]);

  const handleDoubleClick = useCallback(() => {
    if (scale > 1) {
      resetView();
      return;
    }
    updateScale(2);
  }, [resetView, scale, updateScale]);

  return (
    <div className={cn("relative h-full w-full", containerClassName)}>
      <div className="absolute left-4 top-4 z-10 rounded-full bg-black/55 px-3 py-1 text-xs text-white/80">
        {hintText}
      </div>
      <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/65 px-2 py-2 text-white shadow-lg">
        <button
          type="button"
          onClick={() => updateScale(scale - IMAGE_SCALE_STEP)}
          className="rounded-full p-2 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Zoom out"
          disabled={scale <= MIN_IMAGE_SCALE}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={resetView}
          className="min-w-16 rounded-full px-3 py-1 text-xs font-medium transition-colors hover:bg-white/10"
          aria-label="Reset zoom"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => updateScale(scale + IMAGE_SCALE_STEP)}
          className="rounded-full p-2 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Zoom in"
          disabled={scale >= MAX_IMAGE_SCALE}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div
        ref={viewportRef}
        className="flex h-full w-full items-center justify-center overflow-hidden touch-none"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={finishPointer}
        onDoubleClick={handleDoubleClick}
      >
        <img
          src={src}
          alt={alt}
          data-testid="zoomable-image"
          draggable={false}
          className={cn("max-h-full max-w-full select-none object-contain will-change-transform", imageClassName)}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center center",
            cursor: scale > 1 ? "grab" : "zoom-in",
          }}
        />
      </div>
    </div>
  );
});
