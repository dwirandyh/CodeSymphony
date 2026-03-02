import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  api: {
    getGitDiff: vi.fn().mockResolvedValue({ diff: "", summary: "" }),
    getFileContents: vi.fn().mockResolvedValue({ oldContent: "", newContent: "" }),
  },
}));

vi.mock("@pierre/diffs", () => ({
  parsePatchFiles: vi.fn().mockReturnValue([]),
  SPLIT_WITH_NEWLINES: /\r?\n/,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => (
    <div data-testid="file-diff">{fileDiff.name}</div>
  ),
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

import { DiffReviewPanel } from "./DiffReviewPanel";
import { api } from "../../lib/api";
import { parsePatchFiles } from "@pierre/diffs";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DiffReviewPanel", () => {
  it("shows loading state initially", () => {
    act(() => {
      root.render(<DiffReviewPanel worktreeId="w1" />);
    });
    expect(container.textContent).toContain("Loading diff");
  });

  it("shows 'No changes to review' when diff is empty", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([]);

    await act(async () => {
      root.render(<DiffReviewPanel worktreeId="w1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("No changes to review");
  });

  it("shows file changes header when diff has files", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff --git...", summary: "+1 -0" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([
      {
        files: [
          {
            name: "src/test.ts",
            type: "changed",
            hunks: [
              {
                hunkContent: [
                  {
                    type: "change",
                    additions: [{ lineNumber: 1, content: "+hello" }],
                    deletions: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ] as never);

    await act(async () => {
      root.render(<DiffReviewPanel worktreeId="w1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain("src/test.ts");
  });

  it("shows error when diff fetch fails", async () => {
    vi.mocked(api.getGitDiff).mockRejectedValueOnce(new Error("Network error"));

    await act(async () => {
      root.render(<DiffReviewPanel worktreeId="w1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("Network error");
    expect(container.textContent).toContain("Retry");
  });

  it("shows 'No changes for this file' when selectedFilePath but no changes", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([]);

    await act(async () => {
      root.render(<DiffReviewPanel worktreeId="w1" selectedFilePath="src/foo.ts" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("No changes for this file");
  });

  it("renders Split and Unified view buttons", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "file.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      root.render(<DiffReviewPanel worktreeId="w1" />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("Split");
    expect(container.textContent).toContain("Unified");
  });
});
