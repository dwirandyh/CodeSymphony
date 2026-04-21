import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../pages/WorkspacePage";

export type WorkspaceSearch = {
  repoId?: string;
  worktreeId?: string;
  threadId?: string;
  view?: "chat" | "review" | "file";
  file?: string;
  fileLine?: number;
  fileColumn?: number;
  panel?: "explorer" | "git" | "device";
};

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
    repoId: typeof search.repoId === "string" ? search.repoId : undefined,
    worktreeId: typeof search.worktreeId === "string" ? search.worktreeId : undefined,
    threadId: typeof search.threadId === "string" ? search.threadId : undefined,
    view: search.view === "review" || search.view === "file" ? search.view : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
    fileLine: parsePositiveInteger(search.fileLine),
    fileColumn: parsePositiveInteger(search.fileColumn),
    panel: search.panel === "explorer" || search.panel === "git" || search.panel === "device" ? search.panel : undefined,
  }),
  component: WorkspacePage,
  notFoundComponent: () => {
    window.location.href = "/";
    return null;
  },
});
