import { cn } from "../../lib/utils";

type WorkspaceMainClassNameOptions = {
  activeView: string;
  mobileReposOverlayOpen: boolean;
};

type WorkspaceHeaderContainerClassNameOptions = {
  activeView: string;
};

export function getWorkspaceMainClassName({
  activeView,
  mobileReposOverlayOpen,
}: WorkspaceMainClassNameOptions): string {
  return cn(
    "workspace-main flex min-h-0 min-w-0 flex-1 flex-col px-0 pb-0 pt-0",
    activeView !== "file" && (activeView === "chat" ? "lg:pb-0 lg:pt-3" : "lg:px-3 lg:pb-0 lg:pt-3"),
    mobileReposOverlayOpen && "pointer-events-none select-none",
  );
}

export function getWorkspaceHeaderContainerClassName({
  activeView,
}: WorkspaceHeaderContainerClassNameOptions): string {
  if (activeView === "chat") {
    return "px-1.5 pt-1.5 sm:px-2.5 sm:pt-2.5 lg:px-3 lg:pt-0";
  }

  if (activeView === "file") {
    return "px-1.5 pt-1.5 sm:px-2.5 sm:pt-2.5 lg:px-3 lg:pt-3";
  }

  return "px-1.5 pt-1.5 sm:px-2.5 sm:pt-2.5 lg:px-0 lg:pt-0";
}
