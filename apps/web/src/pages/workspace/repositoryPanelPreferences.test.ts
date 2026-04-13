import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRepositoryPanelPreferences,
  normalizeRepositoryPanelPreferences,
  reorderRepositoryIds,
  sortRepositoriesByPreference,
} from "./repositoryPanelPreferences";

describe("repositoryPanelPreferences", () => {
  const originalLocalStorage = window.localStorage;

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it("loads stored order and hidden workspace ids", () => {
    const getItem = vi.fn().mockReturnValue(JSON.stringify({
      order: ["repo-2", "repo-1", "repo-2"],
      hidden: ["repo-3", "repo-3"],
    }));
    const localStorage = window.localStorage;

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { ...localStorage, getItem },
    });

    expect(loadRepositoryPanelPreferences()).toEqual({
      order: ["repo-2", "repo-1"],
      hidden: ["repo-3"],
    });
  });

  it("normalizes preferences against the current repository list", () => {
    expect(normalizeRepositoryPanelPreferences(
      [{ id: "repo-1" }, { id: "repo-2" }, { id: "repo-3" }],
      {
        order: ["repo-2", "repo-4"],
        hidden: ["repo-3", "repo-5"],
      },
    )).toEqual({
      order: ["repo-2", "repo-1", "repo-3"],
      hidden: ["repo-3"],
    });
  });

  it("preserves stored preferences while repositories are still loading", () => {
    const preferences = {
      order: ["repo-2", "repo-1"],
      hidden: ["repo-3"],
    };

    expect(normalizeRepositoryPanelPreferences([], preferences)).toBe(preferences);
  });

  it("sorts repositories using the stored workspace order", () => {
    expect(sortRepositoriesByPreference(
      [{ id: "repo-1" }, { id: "repo-2" }, { id: "repo-3" }],
      ["repo-3", "repo-1"],
    ).map((repository) => repository.id)).toEqual(["repo-3", "repo-1", "repo-2"]);
  });

  it("moves a workspace before or after the drop target", () => {
    expect(reorderRepositoryIds(["repo-1", "repo-2", "repo-3"], "repo-1", "repo-3", "after"))
      .toEqual(["repo-2", "repo-3", "repo-1"]);
    expect(reorderRepositoryIds(["repo-1", "repo-2", "repo-3"], "repo-3", "repo-1", "before"))
      .toEqual(["repo-3", "repo-1", "repo-2"]);
  });
});
