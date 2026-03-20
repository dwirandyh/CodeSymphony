import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowserModal } from "./FileBrowserModal";

vi.mock("../../lib/api", () => ({
  api: {
    browseFilesystem: vi.fn().mockResolvedValue({
      currentPath: "/home/user",
      parentPath: "/home",
      entries: [
        { name: "project", type: "directory", isGitRepo: true },
        { name: "docs", type: "directory", isGitRepo: false },
      ],
    }),
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
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
});
