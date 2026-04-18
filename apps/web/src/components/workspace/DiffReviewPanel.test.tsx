import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

function renderPanel(props: { worktreeId: string; selectedFilePath?: string | null }) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DiffReviewPanel {...props} />
      </QueryClientProvider>,
    );
  });
}

describe("DiffReviewPanel", () => {
  it("shows loading state initially", () => {
    renderPanel({ worktreeId: "w1" });
    expect(container.textContent).toContain("Loading diff");
  });

  it("shows 'No changes to review' when diff is empty", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([]);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
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
      renderPanel({ worktreeId: "w1" });
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
      renderPanel({ worktreeId: "w1" });
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
      renderPanel({ worktreeId: "w1", selectedFilePath: "src/foo.ts" });
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
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("Split");
    expect(container.textContent).toContain("Unified");
    const splitButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Split"));
    const unifiedButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Unified"));

    expect(splitButton?.getAttribute("aria-pressed")).toBe("false");
    expect(unifiedButton?.getAttribute("aria-pressed")).toBe("true");
  });

  it("expands file diffs by default", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "src/expanded.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="file-diff"]')?.textContent).toBe("src/expanded.ts");
  });

  it("keeps file headers sticky inside each diff card", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "src/sticky.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const stickyHeader = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("title") === "src/sticky.ts");

    expect(stickyHeader?.className).toContain("sticky");
    expect(stickyHeader?.className).toContain("top-0");
    expect(stickyHeader?.className).toContain("hover:bg-secondary");
    expect(stickyHeader?.className).not.toContain("hover:bg-secondary/20");
    expect(stickyHeader?.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses a compact non-sticky header when a file is collapsed", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "src/collapsed/header.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const fileHeader = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("title") === "src/collapsed/header.ts");

    expect(fileHeader).toBeTruthy();

    act(() => {
      fileHeader?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fileHeader?.className).not.toContain("sticky");
    expect(fileHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
  });

  it("keeps the file header anchored when collapsing from the middle of a large diff", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "src/anchored.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const scrollArea = container.querySelector(".overflow-auto") as HTMLDivElement | null;
    const fileHeader = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("title") === "src/anchored.ts");

    expect(scrollArea).toBeTruthy();
    expect(fileHeader).toBeTruthy();

    Object.defineProperty(scrollArea!, "scrollTop", {
      configurable: true,
      writable: true,
      value: 900,
    });

    Object.defineProperty(scrollArea!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 100,
        top: 100,
        left: 0,
        bottom: 900,
        right: 1000,
        width: 1000,
        height: 800,
        toJSON: () => ({}),
      }),
    });

    Object.defineProperty(fileHeader!, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const expanded = fileHeader?.getAttribute("aria-expanded") === "true";
        return {
          x: 0,
          y: expanded ? 100 : -700,
          top: expanded ? 100 : -700,
          left: 0,
          bottom: expanded ? 140 : -660,
          right: 1000,
          width: 1000,
          height: 40,
          toJSON: () => ({}),
        };
      },
    });

    act(() => {
      fileHeader?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(scrollArea?.scrollTop).toBe(100);
    expect(fileHeader?.getAttribute("aria-expanded")).toBe("false");
  });

  it("separates filename from directory like GitHub-style file headers", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValueOnce([{
      files: [{
        name: "src/nested/example/file.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.textContent).toContain("file.ts");
    expect(container.textContent).toContain("src/nested/example/");
  });

  it("reuses the cached review snapshot on remount", async () => {
    vi.mocked(api.getGitDiff).mockResolvedValueOnce({ diff: "diff", summary: "" });
    vi.mocked(parsePatchFiles).mockReturnValue([{
      files: [{
        name: "src/cached.ts",
        type: "changed",
        hunks: [{ hunkContent: [{ type: "change", additions: [{ lineNumber: 1, content: "+x" }], deletions: [] }] }],
      }],
    }] as never);

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <div />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      renderPanel({ worktreeId: "w1" });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(api.getGitDiff).toHaveBeenCalledTimes(1);
  });
});
