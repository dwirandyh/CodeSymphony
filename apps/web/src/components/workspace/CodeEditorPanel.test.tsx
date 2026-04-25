import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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

  function renderEditor(
    overrides?: Partial<Parameters<typeof CodeEditorPanel>[0]>,
    options?: { allowMissingEditor?: boolean },
  ) {
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
    if (!editor && !options?.allowMissingEditor) {
      throw new Error("Editor content element not found");
    }

    return {
      editor: editor ?? null,
      props: { ...props, ...overrides },
    };
  }

  it("saves on Mod+S while focused", () => {
    const onSave = vi.fn();
    const { editor } = renderEditor({ onSave });
    if (!editor) {
      throw new Error("Editor content element not found");
    }

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
    if (!editor) {
      throw new Error("Editor content element not found");
    }

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

  it("jumps to the requested target line when opening a file", () => {
    const scrollIntoViewSpy = vi.spyOn(EditorView, "scrollIntoView");
    renderEditor({
      content: "first line\nsecond line\nthird line\n",
      targetLine: 2,
    });

    const activeLine = container.querySelector(".cm-line.cm-activeLine");
    expect(activeLine?.textContent).toContain("second line");
    expect(scrollIntoViewSpy.mock.calls.some(([, options]) =>
      options?.y === "center" && options?.x === "nearest"
    )).toBe(true);
  });

  it("applies the target line after async file content loads", () => {
    act(() => {
      root.render(
        <CodeEditorPanel
          filePath="src/example.ts"
          content=""
          loading={true}
          targetLine={3}
          onChange={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    act(() => {
      root.render(
        <CodeEditorPanel
          filePath="src/example.ts"
          content={"first line\nsecond line\nthird line\n"}
          loading={false}
          targetLine={3}
          onChange={vi.fn()}
          onSave={vi.fn()}
        />,
      );
    });

    const activeLine = container.querySelector(".cm-line.cm-activeLine");
    expect(activeLine?.textContent).toContain("third line");
  });

  it("shows supported language labels for dart, java, and swift files", () => {
    renderEditor({ filePath: "lib/main.dart" });
    expect(container.textContent).toContain("Dart");

    renderEditor({ filePath: "android/App.java" });
    expect(container.textContent).toContain("Java");

    renderEditor({ filePath: "ios/AppDelegate.swift" });
    expect(container.textContent).toContain("Swift");
  });

  it("uses simplified git controls for new untracked files", () => {
    renderEditor({
      filePath: "src/new-file.ts",
      content: "const created = true;\n",
      gitHeadContent: null,
      gitBaselineReady: true,
      gitStatus: "untracked",
    });

    expect(container.textContent).toContain("New File");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.title === "Previous change")).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.title === "Next change")).toBe(false);
  });

  it("shows git changes only in the gutter without full-line git highlight classes", () => {
    renderEditor({
      content: "const value = 2;\n",
      gitHeadContent: "const value = 1;\n",
      gitBaselineReady: true,
      gitStatus: "modified",
    });

    expect(container.querySelector(".cm-git-marker-modified")).not.toBeNull();
    expect(container.querySelector("[class*='cm-git-line-']")).toBeNull();
  });

  it("renders an image preview for image files including svg", () => {
    renderEditor(
      {
        filePath: "assets/logo.svg",
        mimeType: "image/svg+xml",
        content: "PHN2Zy8+",
      },
      { allowMissingEditor: true },
    );

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(image?.getAttribute("alt")).toBe("logo.svg");
    expect(container.textContent).toContain("Pinch or scroll to zoom");
    expect(container.querySelector("button[aria-label='Zoom in']")).not.toBeNull();
  });
});
