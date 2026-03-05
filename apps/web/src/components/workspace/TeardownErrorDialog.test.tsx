import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeardownErrorDialog } from "./TeardownErrorDialog";

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
});

describe("TeardownErrorDialog", () => {
  it("renders nothing when dialog is closed", () => {
    act(() => {
      root.render(
        <TeardownErrorDialog
          open={false}
          worktreeId="w1"
          worktreeName="my-worktree"
          output="some error"
          onForceDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
    expect(container.textContent).toBe("");
  });

  it("renders error output when open", () => {
    act(() => {
      root.render(
        <TeardownErrorDialog
          open={true}
          worktreeId="w1"
          worktreeName="my-worktree"
          output="Script failed with exit code 1"
          onForceDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
    const body = document.body.textContent || "";
    expect(body).toContain("Teardown Failed");
    expect(body).toContain("my-worktree");
    expect(body).toContain("Script failed with exit code 1");
  });

  it("shows Force Delete and Cancel buttons", () => {
    act(() => {
      root.render(
        <TeardownErrorDialog
          open={true}
          worktreeId="w1"
          worktreeName="feat"
          output="err"
          onForceDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
    });
    const buttons = document.body.querySelectorAll("button");
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toContain("Force Delete");
    expect(labels).toContain("Cancel");
  });

  it("calls onForceDelete with worktreeId on Force Delete click", () => {
    const onForceDelete = vi.fn();
    act(() => {
      root.render(
        <TeardownErrorDialog
          open={true}
          worktreeId="w1"
          worktreeName="feat"
          output="err"
          onForceDelete={onForceDelete}
          onClose={vi.fn()}
        />
      );
    });
    const btn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Force Delete"
    );
    act(() => btn?.click());
    expect(onForceDelete).toHaveBeenCalledWith("w1");
  });

  it("calls onClose on Cancel click", () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <TeardownErrorDialog
          open={true}
          worktreeId="w1"
          worktreeName="feat"
          output="err"
          onForceDelete={vi.fn()}
          onClose={onClose}
        />
      );
    });
    const btn = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel"
    );
    act(() => btn?.click());
    expect(onClose).toHaveBeenCalled();
  });
});
