import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { WorkspaceSearch } from "./index";

export type AutomationsSearch = {
  repositoryId?: string;
  worktreeId?: string;
  agent?: "claude" | "codex" | "cursor" | "opencode";
  model?: string;
  permissionMode?: "default" | "full_access";
  chatMode?: "default" | "plan";
  create?: boolean;
};

function parseTrueBoolean(value: unknown): true | undefined {
  return value === true || value === "true" ? true : undefined;
}

export function validateAutomationsSearch(search: Record<string, unknown>): AutomationsSearch {
  return {
    repositoryId: typeof search.repositoryId === "string" ? search.repositoryId : undefined,
    worktreeId: typeof search.worktreeId === "string" ? search.worktreeId : undefined,
    agent:
      search.agent === "claude" || search.agent === "codex" || search.agent === "cursor" || search.agent === "opencode"
        ? search.agent
        : undefined,
    model: typeof search.model === "string" ? search.model : undefined,
    permissionMode: search.permissionMode === "full_access" ? "full_access" : search.permissionMode === "default" ? "default" : undefined,
    chatMode: search.chatMode === "plan" ? "plan" : search.chatMode === "default" ? "default" : undefined,
    create: parseTrueBoolean(search.create),
  };
}

export function buildWorkspaceAutomationsSearch(search: AutomationsSearch): WorkspaceSearch {
  return {
    repoId: search.repositoryId,
    worktreeId: search.worktreeId,
    view: "automations",
    automationCreate: search.create,
  };
}

export const Route = createFileRoute("/automations/")({
  validateSearch: validateAutomationsSearch,
  component: AutomationsIndexRouteComponent,
});

function AutomationsIndexRouteComponent() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({
      to: "/",
      search: buildWorkspaceAutomationsSearch(search),
      replace: true,
    });
  }, [navigate, search]);

  return null;
}
