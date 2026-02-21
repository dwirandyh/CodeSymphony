import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../pages/WorkspacePage";

export const Route = createFileRoute("/")({
  component: WorkspacePage,
  notFoundComponent: () => {
    window.location.href = "/";
    return null;
  },
});
