import { useCallback, useEffect, useRef, useState } from "react";

type SidebarResizeOptions = {
  minWidth?: number;
  maxWidth?: number | null;
};

export function useSidebarResize(initialWidth = 300, reverse = false, options: SidebarResizeOptions = {}) {
  const { minWidth = 200, maxWidth = 500 } = options;
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarStartXRef = useRef(0);
  const sidebarStartWidthRef = useRef(0);
  const widthRef = useRef(initialWidth);
  const panelRef = useRef<HTMLElement | null>(null);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarDragging(true);
    sidebarStartXRef.current = e.clientX;
    sidebarStartWidthRef.current = widthRef.current;
  }, []);

  useEffect(() => {
    if (!sidebarDragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(e: MouseEvent) {
      const delta = reverse
        ? sidebarStartXRef.current - e.clientX
        : e.clientX - sidebarStartXRef.current;
      const nextWidth = sidebarStartWidthRef.current + delta;
      const newWidth = Math.max(
        minWidth,
        maxWidth == null ? nextWidth : Math.min(maxWidth, nextWidth),
      );
      widthRef.current = newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${newWidth}px`;
      }
    }
    function onUp() {
      setSidebarDragging(false);
      setSidebarWidth(widthRef.current);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [maxWidth, minWidth, sidebarDragging, reverse]);

  return { sidebarWidth, sidebarDragging, handleSidebarMouseDown, panelRef };
}
