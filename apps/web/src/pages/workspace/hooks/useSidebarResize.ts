import { useCallback, useEffect, useRef, useState } from "react";

export function useSidebarResize(initialWidth = 300) {
  const [sidebarWidth, setSidebarWidth] = useState(initialWidth);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const sidebarStartXRef = useRef(0);
  const sidebarStartWidthRef = useRef(0);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarDragging(true);
    sidebarStartXRef.current = e.clientX;
    sidebarStartWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (!sidebarDragging) return;

    function onMove(e: MouseEvent) {
      const delta = e.clientX - sidebarStartXRef.current;
      setSidebarWidth(Math.max(200, Math.min(500, sidebarStartWidthRef.current + delta)));
    }
    function onUp() {
      setSidebarDragging(false);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [sidebarDragging]);

  return { sidebarWidth, sidebarDragging, handleSidebarMouseDown };
}
