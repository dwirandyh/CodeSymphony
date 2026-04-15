import { describe, expect, it } from "vitest";
import {
  buildEditorGitModel,
  buildEditorGitPeekPatch,
  deriveEditorGitStatus,
  findCurrentGitHunkIndex,
  revertEditorGitHunk,
} from "./codeEditorGit";

describe("codeEditorGit", () => {
  it("builds git hunks and changed lines from HEAD to draft", () => {
    const model = buildEditorGitModel(
      "src/example.ts",
      "const a = 1;\nconst b = 2;\n",
      "const a = 1;\nconst b = 3;\nconst c = 4;\n",
    );

    expect(model.hunks).toHaveLength(1);
    expect(model.hunks[0]?.kind).toBe("modified");
    expect(model.hunks[0]?.anchorLine).toBe(2);
    expect(model.lines).toEqual([
      { lineNumber: 2, kind: "modified", hunkIndex: 0 },
      { lineNumber: 3, kind: "modified", hunkIndex: 0 },
    ]);
  });

  it("finds the current hunk nearest to the cursor line", () => {
    const model = buildEditorGitModel(
      "src/example.ts",
      "01\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\n12\n",
      "ONE\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\nTWELVE\n13\n",
    );

    expect(findCurrentGitHunkIndex(model.hunks, 1)).toBe(0);
    expect(findCurrentGitHunkIndex(model.hunks, 12)).toBe(1);
    expect(findCurrentGitHunkIndex(model.hunks, 13)).toBe(1);
  });

  it("reverts a single hunk back to HEAD content", () => {
    const model = buildEditorGitModel(
      "src/example.ts",
      "01\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\n12\n",
      "ONE\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\nTWELVE\n13\n",
    );

    const reverted = revertEditorGitHunk(
      "ONE\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\nTWELVE\n13\n",
      model.hunks[1],
    );

    expect(reverted).toBe("ONE\n02\n03\n04\n05\n06\n07\n08\n09\n10\n11\n12\n");
  });

  it("derives a git status from the diff when status is not available yet", () => {
    const model = buildEditorGitModel("src/new.ts", null, "const created = true;\n");
    expect(deriveEditorGitStatus(null, model.diff)).toBe("modified");
    expect(deriveEditorGitStatus("modified", model.diff)).toBe("modified");
  });

  it("keeps delete-only hunks visible for gutter and peek rendering", () => {
    const model = buildEditorGitModel(
      "src/example.ts",
      "alpha\nbeta\ngamma\n",
      "alpha\ngamma\n",
    );

    expect(model.hunks).toHaveLength(1);
    expect(model.hunks[0]?.kind).toBe("deleted");
    expect(model.lines).toEqual([]);

    const peekPatch = buildEditorGitPeekPatch(model.hunks[0]);
    expect(peekPatch).toContain("@@");
    expect(peekPatch).toContain("-beta");
  });

  it("splits nearby change blocks into separate editor hunks and reverts only the selected block", () => {
    const head = "a\nb\nc\nd\ne\nf\ng\n";
    const draft = "A\nb\nc\nd\nE\nf\ng\n";
    const model = buildEditorGitModel("src/example.ts", head, draft);

    expect(model.hunks).toHaveLength(2);
    expect(model.hunks[0]?.startLine).toBe(1);
    expect(model.hunks[1]?.startLine).toBe(5);

    const reverted = revertEditorGitHunk(draft, model.hunks[1]);
    expect(reverted).toBe("A\nb\nc\nd\ne\nf\ng\n");

    const firstPeekPatch = buildEditorGitPeekPatch(model.hunks[0]);
    const secondPeekPatch = buildEditorGitPeekPatch(model.hunks[1]);
    expect(firstPeekPatch).toContain("-a");
    expect(firstPeekPatch).toContain("+A");
    expect(secondPeekPatch).toContain("-e");
    expect(secondPeekPatch).toContain("+E");
  });
});
