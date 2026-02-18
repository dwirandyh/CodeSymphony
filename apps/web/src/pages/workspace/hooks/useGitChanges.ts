import { useCallback, useEffect, useRef, useState } from "react";
import type { GitChangeEntry } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";

const POLL_INTERVAL_MS = 5000;

export function useGitChanges(worktreeId: string | null, enabled: boolean) {
  const [entries, setEntries] = useState<GitChangeEntry[]>([]);
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    if (!worktreeId) {
      setEntries([]);
      setBranch("");
      return;
    }
    try {
      setLoading(true);
      const status = await api.getGitStatus(worktreeId);
      if (mountedRef.current) {
        setEntries(status.entries);
        setBranch(status.branch);
      }
    } catch {
      // silently fail on polling — stale data is acceptable
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !worktreeId) return;
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [worktreeId, enabled, fetchStatus]);

  const commit = useCallback(
    async (message: string) => {
      if (!worktreeId) return;
      setCommitting(true);
      setError(null);
      try {
        await api.gitCommit(worktreeId, { message });
        await fetchStatus();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Commit failed";
        setError(msg);
      } finally {
        setCommitting(false);
      }
    },
    [worktreeId, fetchStatus],
  );

  const getDiff = useCallback(async () => {
    if (!worktreeId) return { diff: "", summary: "" };
    return api.getGitDiff(worktreeId);
  }, [worktreeId]);

  return { entries, branch, loading, committing, error, commit, getDiff, refresh: fetchStatus };
}
