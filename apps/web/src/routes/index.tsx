import { Suspense, lazy } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { StartupSplash } from "../components/startup/StartupSplash";
import { WorkspaceStartupGate } from "../components/startup/WorkspaceStartupGate";

export type WorkspaceSearch = {
  repoId?: string;
  worktreeId?: string;
  threadId?: string;
  view?: "chat" | "review" | "file" | "automations";
  file?: string;
  fileLine?: number;
  fileColumn?: number;
  automationId?: string;
  automationCreate?: boolean;
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

function parseTrueBoolean(value: unknown): true | undefined {
  return value === true || value === "true" ? true : undefined;
}

export function validateWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  return {
    repoId: typeof search.repoId === "string" ? search.repoId : undefined,
    worktreeId: typeof search.worktreeId === "string" ? search.worktreeId : undefined,
    threadId: typeof search.threadId === "string" ? search.threadId : undefined,
    view:
      search.view === "review" || search.view === "file" || search.view === "automations"
        ? search.view
        : undefined,
    file: typeof search.file === "string" ? search.file : undefined,
    fileLine: parsePositiveInteger(search.fileLine),
    fileColumn: parsePositiveInteger(search.fileColumn),
    automationId: typeof search.automationId === "string" ? search.automationId : undefined,
    automationCreate: parseTrueBoolean(search.automationCreate),
    panel: search.panel === "explorer" || search.panel === "git" || search.panel === "device" ? search.panel : undefined,
  };
}

const LazyWorkspacePage = lazy(() =>
  import("../pages/WorkspacePage").then((module) => ({ default: module.WorkspacePage }))
);

function WorkspaceRouteComponent() {
  return (
    <WorkspaceStartupGate>
      <Suspense
        fallback={(
          <StartupSplash
            headline="Loading Workspace"
            detail="Preparing the editor, repositories, and terminal surfaces."
          />
        )}
      >
        <LazyWorkspacePage />
      </Suspense>
    </WorkspaceStartupGate>
  );
}

export const Route = createFileRoute("/")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRouteComponent,
  notFoundComponent: () => {
    window.location.href = "/";
    return null;
  },
});
