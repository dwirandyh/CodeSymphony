import { useCallback, useEffect, useMemo, useState } from "react";

export type GateRequestRef = {
  requestId: string;
};

export function useGateRequestNavigation<T extends GateRequestRef>(
  pendingRequests: readonly T[],
) {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);

  const activeIndex = useMemo(() => {
    if (pendingRequests.length === 0) {
      return -1;
    }
    if (!activeRequestId) {
      return 0;
    }
    return pendingRequests.findIndex((request) => request.requestId === activeRequestId);
  }, [activeRequestId, pendingRequests]);

  const activeRequest = activeIndex >= 0
    ? pendingRequests[activeIndex] ?? null
    : null;
  const hasMultiple = pendingRequests.length > 1;

  useEffect(() => {
    if (pendingRequests.length === 0) {
      setActiveRequestId(null);
      return;
    }
    if (
      activeRequestId
      && pendingRequests.some((request) => request.requestId === activeRequestId)
    ) {
      return;
    }
    const fallbackIndex = activeIndex >= 0
      ? Math.min(activeIndex, pendingRequests.length - 1)
      : 0;
    const fallbackRequest = pendingRequests[fallbackIndex] ?? pendingRequests[0];
    setActiveRequestId(fallbackRequest?.requestId ?? null);
  }, [activeIndex, activeRequestId, pendingRequests]);

  const showPrevious = useCallback(() => {
    if (activeIndex <= 0) {
      return;
    }
    const previous = pendingRequests[activeIndex - 1];
    if (previous) {
      setActiveRequestId(previous.requestId);
    }
  }, [activeIndex, pendingRequests]);

  const showNext = useCallback(() => {
    if (activeIndex < 0 || activeIndex >= pendingRequests.length - 1) {
      return;
    }
    const next = pendingRequests[activeIndex + 1];
    if (next) {
      setActiveRequestId(next.requestId);
    }
  }, [activeIndex, pendingRequests]);

  return {
    activeRequest,
    activeIndex,
    hasMultiple,
    showPrevious,
    showNext,
  };
}
