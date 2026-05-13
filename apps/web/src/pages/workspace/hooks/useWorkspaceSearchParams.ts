import { useRef, useCallback } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";
import type { WorkspaceSearch } from "../../../routes/index";

export function useWorkspaceSearchParams() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const pendingRef = useRef<Partial<WorkspaceSearch> | null>(null);
  const scheduledRef = useRef(false);

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

          void navigate({
            to: "/",
            search: (prev: WorkspaceSearch) => {
              const next = { ...prev, ...merged };

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

              // Remove undefined/null keys and default values to keep URL clean
              const cleaned: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(next)) {
                if (value != null && value !== "") {
                  // Omit default view value
                  if (key === "view" && value === "chat") continue;
                  cleaned[key] = value;
                }
              }
              return cleaned as WorkspaceSearch;
            },
            replace: true,
          });
        });
      }
    },
    [navigate],
  );

  return { search, updateSearch };
}
