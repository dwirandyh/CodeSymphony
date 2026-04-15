import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState, type Transaction } from "@codemirror/state";
import type { FileEntry } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorPanel, insertSoftTabOrIndentSelection } from "./CodeEditorPanel";

describe("CodeEditorPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function renderEditor(overrides?: Partial<Parameters<typeof CodeEditorPanel>[0]>) {
    const props: Parameters<typeof CodeEditorPanel>[0] = {
      filePath: "src/example.ts",
      content: "const value = 1;\n",
      onChange: vi.fn(),
      onSave: vi.fn(),
    };

    act(() => {
      root.render(<CodeEditorPanel {...props} {...overrides} />);
    });

    const editor = container.querySelector<HTMLElement>(".cm-content");
    if (!editor) {
      throw new Error("Editor content element not found");
    }

    return {
      editor,
      props: { ...props, ...overrides },
    };
  }

  it("saves on Mod+S while focused", () => {
    const onSave = vi.fn();
    const { editor } = renderEditor({ onSave });

    act(() => {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "s",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("indents with Tab instead of moving focus away", () => {
    const onChange = vi.fn();
    const { editor } = renderEditor({ content: "", onChange });

    act(() => {
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onChange).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("  ");
    expect(document.activeElement).toBe(editor);
  });

  it("inserts a soft tab at the cursor instead of indenting the whole line", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: { anchor: 5 },
    });

    let nextState = state;
    const handled = insertSoftTabOrIndentSelection({
      state,
      dispatch: (transaction: Transaction) => {
        nextState = transaction.state;
      },
    } as never);

    expect(handled).toBe(true);
    expect(nextState.doc.toString()).toBe("hello   world");
  });

  it("renders breadcrumb segments for the current file path", () => {
    renderEditor({ filePath: "packages/course/docs/README.md" });

    const breadcrumbs = container.querySelector('[data-testid="editor-breadcrumbs"]');
    if (!breadcrumbs) {
      throw new Error("Breadcrumbs not found");
    }

    expect(breadcrumbs.textContent).toContain("packages");
    expect(breadcrumbs.textContent).toContain("course");
    expect(breadcrumbs.textContent).toContain("docs");
    expect(breadcrumbs.textContent).toContain("README.md");
  });

  it("opens sibling files from breadcrumb popover", async () => {
    const onOpenFile = vi.fn();
    const fileEntries: FileEntry[] = [
      { path: "packages/course/docs/README.md", type: "file" },
      { path: "packages/course/docs/CHANGELOG.md", type: "file" },
      { path: "packages/course/docs/guides", type: "directory" },
    ];

    renderEditor({
      filePath: "packages/course/docs/README.md",
      fileEntries,
      onOpenFile,
    });

    const fileBreadcrumb = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("README.md"));
    if (!fileBreadcrumb) {
      throw new Error("File breadcrumb not found");
    }

    await act(async () => {
      fileBreadcrumb.click();
      await Promise.resolve();
    });

    const siblingFile = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("CHANGELOG.md"));
    if (!siblingFile) {
      throw new Error("Sibling file menu item not found");
    }

    await act(async () => {
      siblingFile.click();
      await Promise.resolve();
    });

    expect(onOpenFile).toHaveBeenCalledWith("packages/course/docs/CHANGELOG.md");
  });

  it("shows supported language labels for dart, java, and swift files", () => {
    renderEditor({ filePath: "lib/main.dart" });
    expect(container.textContent).toContain("Dart");

    renderEditor({ filePath: "android/App.java" });
    expect(container.textContent).toContain("Java");

    renderEditor({ filePath: "ios/AppDelegate.swift" });
    expect(container.textContent).toContain("Swift");
  });
});
