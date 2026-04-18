import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../pages/WorkspacePage";

export type WorkspaceSearch = {
  repoId?: string;
  worktreeId?: string;
  threadId?: string;
  view?: "chat" | "review" | "file";
  file?: string;
  panel?: "explorer" | "git";
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): WorkspaceSearch => ({
    repoId: typeof search.repoId === "string" ? search.repoId : undefined,
    worktreeId: typeof search.worktreeId === "string" ? search.worktreeId : undefined,
    threadId: typeof search.threadId === "string" ? search.threadId : undefined,
    view: search.view === "review" || search.view === "file" ? search.view : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
    panel: search.panel === "explorer" || search.panel === "git" ? search.panel : undefined,
  }),
  component: WorkspacePage,
  notFoundComponent: () => {
    window.location.href = "/";
    return null;
  },
});
