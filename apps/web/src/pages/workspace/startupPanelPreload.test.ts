import { describe, expect, it } from "vitest";
import { shouldScheduleWorkspacePanelPreload } from "./startupPanelPreload";

describe("shouldScheduleWorkspacePanelPreload", () => {
  it("skips preloading before non-critical startup data is enabled", () => {
    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "chat",
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: false,
      hasSelectedWorktree: true,
    })).toBe(false);
  });

  it("skips preloading when no worktree is selected", () => {
    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "chat",
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: false,
    })).toBe(false);
  });

  it("skips preloading when the file or review surface is already active", () => {
    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "file",
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: true,
    })).toBe(false);

    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "review",
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: true,
    })).toBe(false);
  });

  it("skips preloading after chunks were already loaded once", () => {
    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "chat",
      alreadyPreloaded: true,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: true,
    })).toBe(false);
  });

  it("allows idle preloading for non-file startup surfaces", () => {
    expect(shouldScheduleWorkspacePanelPreload({
      activeView: "chat",
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: true,
    })).toBe(true);

    expect(shouldScheduleWorkspacePanelPreload({
      activeView: undefined,
      alreadyPreloaded: false,
      enableNonCriticalWorkspaceData: true,
      hasSelectedWorktree: true,
    })).toBe(true);
  });
});
