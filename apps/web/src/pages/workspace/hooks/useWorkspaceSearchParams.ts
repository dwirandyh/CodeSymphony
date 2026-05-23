import { useRef, useCallback } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { WorkspaceSearch } from "../../../routes/index";

function cleanWorkspaceSearch(search: WorkspaceSearch): WorkspaceSearch {
  const next = { ...search };

  if (next.view !== "automations") {
    next.automationId = undefined;
    next.automationCreate = undefined;
  } else if (next.automationId) {
    next.automationCreate = undefined;
  }

  if (next.view !== "file" || !next.file) {
    next.fileLine = undefined;
    next.fileColumn = undefined;
  } else if (!next.fileLine) {
    next.fileColumn = undefined;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value != null && value !== "") {
      if (key === "view" && value === "chat") {
        continue;
      }
      cleaned[key] = value;
    }
  }

  return cleaned as WorkspaceSearch;
}

function areWorkspaceSearchEqual(left: WorkspaceSearch, right: WorkspaceSearch): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key as keyof WorkspaceSearch] === value);
}

export function useWorkspaceSearchParams() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const pendingRef = useRef<Partial<WorkspaceSearch> | null>(null);
  const scheduledRef = useRef(false);
  const searchRef = useRef(search);
  searchRef.current = search;

  const updateSearch = useCallback(
    (partial: Partial<WorkspaceSearch>) => {
      pendingRef.current = { ...pendingRef.current, ...partial };

      if (!scheduledRef.current) {
        scheduledRef.current = true;
        queueMicrotask(() => {
          const merged = pendingRef.current;
          pendingRef.current = null;
          scheduledRef.current = false;
          if (!merged) return;

          const currentSearch = cleanWorkspaceSearch(searchRef.current);
          const nextSearch = cleanWorkspaceSearch({
            ...searchRef.current,
            ...merged,
          });
          if (areWorkspaceSearchEqual(currentSearch, nextSearch)) {
            return;
          }

          void navigate({
            to: "/",
            search: () => nextSearch,
            replace: true,
          });
        });
      }
    },
    [navigate],
  );

  return { search, updateSearch };
}
