import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowserModal } from "./FileBrowserModal";

const browseFilesystemMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({
  api: {
    browseFilesystem: browseFilesystemMock,
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  browseFilesystemMock.mockReset();
  browseFilesystemMock.mockResolvedValue({
    currentPath: "/home/user",
    currentPathIsGitRepo: true,
    parentPath: "/home",
    entries: [
      { name: "project", type: "directory", isGitRepo: true },
      { name: "docs", type: "directory", isGitRepo: false },
    ],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FileBrowserModal", () => {
  async function flushEffects(delay = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
    });
  }

  it("renders nothing when closed", () => {
    act(() => {
      root.render(<FileBrowserModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    expect(document.body.textContent).not.toContain("Browse Server Filesystem");
  });

  it("renders dialog when open", async () => {
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects();
    const body = document.body.textContent || "";
    expect(body).toContain("Browse Server Filesystem");
    expect(body).toContain("Select this directory");
  });

  it("renders filter input", async () => {
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects();
    const input = document.body.querySelector('input[placeholder="Filter directories..."]');
    expect(input).toBeTruthy();
  });

  it("shows directory entries after load", async () => {
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects(100);
    const body = document.body.textContent || "";
    expect(body).toContain("project");
    expect(body).toContain("docs");
  });

  it("shows Git badge for git repos", async () => {
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects(100);
    const body = document.body.textContent || "";
    expect(body).toContain("Git");
  });

  it("updates recent paths immediately after selecting a directory", async () => {
    const onSelect = vi.fn();
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={onSelect} />);
    });
    await flushEffects(100);

    const selectButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Select this directory"),
    ) as HTMLButtonElement;

    await act(async () => {
      selectButton.click();
    });

    expect(onSelect).toHaveBeenCalledWith("/home/user");
    expect(document.body.querySelector('button[title="/home/user"]')).toBeTruthy();
  });

  it("refreshes recent paths when reopened", async () => {
    localStorage.setItem("codesymphony:recent-browse-paths", JSON.stringify(["/old/path"]));

    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects(100);
    expect(document.body.querySelector('button[title="/old/path"]')).toBeTruthy();

    localStorage.setItem("codesymphony:recent-browse-paths", JSON.stringify(["/new/path"]));

    await act(async () => {
      root.render(<FileBrowserModal open={false} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects(100);

    expect(document.body.querySelector('button[title="/new/path"]')).toBeTruthy();
  });

  it("starts from the parent of the active repository path when provided", async () => {
    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} initialPath="/home/user/project-a" />,
      );
    });
    await flushEffects(100);

    expect(browseFilesystemMock).toHaveBeenCalledWith("/home/user");
  });

  it("hides hidden folders by default and disables selection outside git repos", async () => {
    browseFilesystemMock.mockResolvedValue({
      currentPath: "/home/user",
      currentPathIsGitRepo: false,
      parentPath: "/home",
      entries: [
        { name: "project", type: "directory", isGitRepo: true },
        { name: ".ssh", type: "directory", isGitRepo: false },
      ],
    });

    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} onSelect={vi.fn()} />);
    });
    await flushEffects(100);

    expect(document.body.textContent).toContain("project");
    expect(document.body.textContent).not.toContain(".ssh");

    const selectButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Select this directory"),
    ) as HTMLButtonElement;
    expect(selectButton.disabled).toBe(true);

    const toggleButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Show hidden"),
    ) as HTMLButtonElement;

    await act(async () => {
      toggleButton.click();
    });

    expect(document.body.textContent).toContain(".ssh");
  });
});
