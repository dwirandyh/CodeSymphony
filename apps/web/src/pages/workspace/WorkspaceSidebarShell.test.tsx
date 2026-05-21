import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceSidebarShell } from "./WorkspaceSidebarShell";

describe("WorkspaceSidebarShell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderShell(overrides?: Partial<Parameters<typeof WorkspaceSidebarShell>[0]>) {
    const props: Parameters<typeof WorkspaceSidebarShell>[0] = {
      repositoryName: "CodeSymphony",
      worktreeBranch: "instant-open",
      selectedIsRootWorkspace: false,
      isVisible: true,
    };

    act(() => {
      root.render(<WorkspaceSidebarShell {...props} {...overrides} />);
    });
  }

  it("renders app shell with repository context", () => {
    renderShell();

    expect(container.textContent).toContain("CodeSymphony");
    expect(container.textContent).toContain("instant-open");
    expect(container.textContent).toContain("Loading repositories");
  });

  it("hides itself when sidebar not visible", () => {
    renderShell({ isVisible: false });
    expect(container.textContent).toBe("");
  });

  it("uses root workspace label when selected branch absent", () => {
    renderShell({
      repositoryName: "CodeSymphony",
      worktreeBranch: null,
      selectedIsRootWorkspace: true,
    });

    expect(container.textContent).toContain("Root workspace");
  });
});
