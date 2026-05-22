import { describe, expect, it } from "vitest";
import {
  shouldAutoLoadAllWorkspaceAgentCatalogs,
  shouldLoadWorkspaceAgentCatalog,
} from "./workspaceAgentCatalog";

describe("workspaceAgentCatalog", () => {
  it("keeps inactive agent catalogs out of the workspace startup path", () => {
    expect(shouldLoadWorkspaceAgentCatalog({
      enableNonCriticalWorkspaceData: true,
      loadAllModelCatalogs: false,
      catalogAgent: "cursor",
      composerAgent: "codex",
    })).toBe(false);
  });

  it("loads the active composer agent catalog once non-critical workspace data is enabled", () => {
    expect(shouldLoadWorkspaceAgentCatalog({
      enableNonCriticalWorkspaceData: true,
      loadAllModelCatalogs: false,
      catalogAgent: "codex",
      composerAgent: "codex",
    })).toBe(true);
  });

  it("loads every catalog after the settings dialog opts into the full model inventory", () => {
    expect(shouldLoadWorkspaceAgentCatalog({
      enableNonCriticalWorkspaceData: true,
      loadAllModelCatalogs: true,
      catalogAgent: "opencode",
      composerAgent: "claude",
    })).toBe(true);
  });

  it("stays disabled until non-critical workspace data is ready", () => {
    expect(shouldLoadWorkspaceAgentCatalog({
      enableNonCriticalWorkspaceData: false,
      loadAllModelCatalogs: true,
      catalogAgent: "codex",
      composerAgent: "codex",
    })).toBe(false);
  });

  it("auto-loads every catalog once non-critical workspace data is enabled", () => {
    expect(shouldAutoLoadAllWorkspaceAgentCatalogs({
      enableNonCriticalWorkspaceData: true,
      loadAllModelCatalogs: false,
    })).toBe(true);
  });

  it("does not auto-load catalogs before the first non-critical frame or after it already ran", () => {
    expect(shouldAutoLoadAllWorkspaceAgentCatalogs({
      enableNonCriticalWorkspaceData: false,
      loadAllModelCatalogs: false,
    })).toBe(false);
    expect(shouldAutoLoadAllWorkspaceAgentCatalogs({
      enableNonCriticalWorkspaceData: true,
      loadAllModelCatalogs: true,
    })).toBe(false);
  });
});
