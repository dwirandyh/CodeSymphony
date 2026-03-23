import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptOutputTab, type ScriptOutputEntry } from "./ScriptOutputTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeEntry(overrides: Partial<ScriptOutputEntry> = {}): ScriptOutputEntry {
  return {
    id: "entry-1",
    worktreeId: "w1",
    worktreeName: "feat-branch",
    type: "setup",
    timestamp: Date.now(),
    output: "Installing deps...",
    success: true,
    status: "completed",
    ...overrides,
  };
}

describe("ScriptOutputTab", () => {
  it("shows empty message when no entries", () => {
    act(() => {
      root.render(
        <ScriptOutputTab
          entries={[]}
        />
      );
    });
    expect(container.textContent).toContain("No setup output yet");
  });

  it("renders Setup Script heading", () => {
    act(() => {
      root.render(
        <ScriptOutputTab
          entries={[]}
        />
      );
    });
    expect(container.textContent).toContain("Setup Script");
  });

  it("renders setup output when entries provided", () => {
    const entries = [makeEntry({ output: "npm install done" })];
    act(() => {
      root.render(
        <ScriptOutputTab
          entries={entries}
        />
      );
    });
    expect(container.textContent).toContain("npm install done");
  });

  it("renders Re-run setup button when onRerunSetup provided", () => {
    const onRerun = vi.fn();
    act(() => {
      root.render(
        <ScriptOutputTab
          entries={[]}
          onRerunSetup={onRerun}
        />
      );
    });
    expect(container.textContent).toContain("Re-run setup");
  });

  it("shows helper text for setup lifecycle", () => {
    act(() => {
      root.render(
        <ScriptOutputTab
          entries={[]}
        />
      );
    });
    expect(container.textContent).toContain("Runs automatically after worktree creation.");
  });
});
