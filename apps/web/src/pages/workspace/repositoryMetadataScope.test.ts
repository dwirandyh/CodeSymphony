import { describe, expect, it } from "vitest";
import {
  filterRepositoriesForMetadataScope,
  shouldIncludeRepositoryInMetadataScope,
} from "./repositoryMetadataScope";

describe("repositoryMetadataScope", () => {
  it("keeps the selected repository in metadata scope even when persisted expanded state is false", () => {
    expect(shouldIncludeRepositoryInMetadataScope({
      repositoryId: "r1",
      selectedRepositoryId: "r1",
      expandedByRepo: { r1: false },
    })).toBe(true);
  });

  it("keeps non-selected repositories out of metadata scope unless explicitly expanded", () => {
    expect(filterRepositoriesForMetadataScope({
      repositories: [
        { id: "r1" },
        { id: "r2" },
      ],
      selectedRepositoryId: "r1",
      expandedByRepo: { r1: false, r2: false },
    })).toEqual([{ id: "r1" }]);
  });
});
