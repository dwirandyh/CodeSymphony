import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";

const POLL_INTERVAL_MS = 60_000;

export function useFileIndex(worktreeId: string | null) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const initialFetchDone = useRef(false);

  const fetchIndex = useCallback(
    async (signal?: AbortSignal, isBackground = false) => {
      if (!worktreeId) return;
      if (!isBackground) setLoading(true);
      try {
        const data = await api.getFileIndex(worktreeId, signal);
        if (!signal?.aborted) {
          setEntries(data);
        }
      } catch {
        // Silently ignore — stale data is acceptable for autocomplete
      } finally {
        if (!signal?.aborted && !isBackground) {
          setLoading(false);
        }
      }
    },
    [worktreeId],
  );

  // Initial fetch + polling
  useEffect(() => {
    if (!worktreeId) {
      setEntries([]);
      initialFetchDone.current = false;
      return;
    }

    const controller = new AbortController();
    initialFetchDone.current = false;

    fetchIndex(controller.signal).then(() => {
      if (!controller.signal.aborted) {
        initialFetchDone.current = true;
      }
    });

    const interval = setInterval(() => {
      fetchIndex(controller.signal, true);
    }, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [worktreeId, fetchIndex]);

  const refresh = useCallback(() => {
    void fetchIndex(undefined, true);
  }, [fetchIndex]);

  return { entries, loading, refresh };
}
