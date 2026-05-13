import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

vi.mock("../../components/workspace/RepositoryPanel", () => ({
  RepositoryPanel: () => <div>Repository Panel Mock</div>,
}));

vi.mock("./hooks/useSidebarResize", () => ({
  useSidebarResize: () => ({
    sidebarWidth: 300,
    sidebarDragging: false,
    handleSidebarMouseDown: vi.fn(),
    panelRef: { current: null },
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderSidebar(overrides?: Partial<Parameters<typeof WorkspaceSidebar>[0]>) {
  const props: Parameters<typeof WorkspaceSidebar>[0] = {
    repositories: [],
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    hiddenRepositoryIds: [],
    expandedByRepo: {},
    loadingRepos: false,
    submittingRepo: false,
    submittingWorktree: false,
    onOpenAutomations: vi.fn(),
    onOpenSettings: vi.fn(),
    onAttachRepository: vi.fn(),
    onSelectRepository: vi.fn(),
    onToggleRepositoryExpand: vi.fn(),
    onSetRepositoryVisibility: vi.fn(),
    onShowAllRepositories: vi.fn(),
    onReorderRepositories: vi.fn(),
    onCreateWorktree: vi.fn(),
    onSelectWorktree: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onRenameWorktreeBranch: vi.fn(),
  };

  act(() => {
    root.render(<WorkspaceSidebar {...props} {...overrides} />);
  });
}

describe("WorkspaceSidebar", () => {
  it("keeps the sidebar hidden on mobile web until the desktop breakpoint", () => {
    renderSidebar();

    const sidebar = container.querySelector("aside");
    if (!sidebar) {
      throw new Error("Sidebar not found");
    }

    expect(sidebar.className).toContain("hidden lg:flex");
  });

  it("keeps the sidebar visible for desktop app layout overrides", () => {
    renderSidebar({ desktopApp: true });

    const sidebar = container.querySelector("aside");
    if (!sidebar) {
      throw new Error("Sidebar not found");
    }

    expect(sidebar.className).toContain("flex");
    expect(sidebar.className).not.toContain("hidden lg:flex");
  });

  it("renders an automations entry above settings", () => {
    renderSidebar();
    expect(container.textContent).toContain("Automations");
    expect(container.textContent).toContain("Settings");
  });
});
