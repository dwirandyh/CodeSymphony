import { act } from "react";
import type { FileEntry } from "@codesymphony/shared-types";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceExplorerPanel } from "./WorkspaceExplorerPanel";

let container: HTMLDivElement;
let root: Root;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  scrollIntoViewMock = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  act(() => root.unmount());
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  container.remove();
});

describe("WorkspaceExplorerPanel", () => {
  it("auto-expands parent folders for the active file and marks it as current", () => {
    const entries: FileEntry[] = [
      { path: "docs/guides/intro.md", type: "file" },
      { path: "docs/guides/advanced.md", type: "file" },
      { path: "src/main.ts", type: "file" },
    ];

    act(() => {
      root.render(
        <WorkspaceExplorerPanel
          entries={entries}
          gitEntries={[]}
          loading={false}
          activeFilePath="docs/guides/intro.md"
          onOpenFile={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    const activeButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.dataset.explorerPath === "docs/guides/intro.md");

    expect(container.textContent).toContain("docs");
    expect(container.textContent).toContain("guides");
    expect(container.textContent).toContain("intro.md");
    expect(activeButton?.getAttribute("aria-current")).toBe("page");
    expect(scrollIntoViewMock).toHaveBeenCalled();
  });
});
