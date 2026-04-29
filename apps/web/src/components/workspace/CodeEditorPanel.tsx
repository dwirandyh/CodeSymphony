import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { basicSetup } from "codemirror";
import { indentLess, indentMore, redo, undo } from "@codemirror/commands";
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, type Extension, type StateCommand } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, keymap } from "@codemirror/view";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import type { FileEntry, GitChangeStatus } from "@codesymphony/shared-types";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowDown, ArrowUp, ChevronRight, Eye, FileCode2, Folder, GitBranch, Info, Loader2, Redo2, Save, Undo2, X } from "lucide-react";
import { vscodeDarkInit } from "@uiw/codemirror-theme-vscode";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { SafePatchDiff } from "./chat-message-list/diffUtils";
import { ZoomableImage } from "./ZoomableImage";
import {
  buildEditorGitModel,
  buildEditorGitPeekPatch,
  deriveEditorGitStatus,
  findCurrentGitHunkIndex,
  revertEditorGitHunk,
  type EditorGitChangeKind,
  type EditorGitHunk,
} from "./codeEditorGit";

type GitPeekWidgetHost = HTMLElement & { __gitPeekRoot?: Root };

function fileExtension(filePath: string): string {
  const filename = filePath.split("/").pop() ?? filePath;
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
}

async function languageExtensionForFile(filePath: string): Promise<Extension> {
  const ext = fileExtension(filePath);

  switch (ext) {
    case "ts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "md":
    case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "scss":
      return (await import("@codemirror/lang-sass")).sass();
    case "sass":
      return (await import("@codemirror/lang-sass")).sass({ indented: true });
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "xml":
    case "svg":
    case "plist":
      return (await import("@codemirror/lang-xml")).xml();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "kt":
    case "kts":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).kotlin);
    case "dart":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).dart);
    case "swift":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/swift")).swift);
    case "go":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/go")).go);
    case "rs":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/rust")).rust);
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "c":
    case "h":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).c);
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).cpp);
    case "cs":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp);
    case "m":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).objectiveC);
    case "mm":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).objectiveCpp);
    case "php":
    case "phtml":
      return (await import("@codemirror/lang-php")).php({ plain: true });
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "rb":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/ruby")).ruby);
    case "lua":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/lua")).lua);
    case "toml":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    case "properties":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/properties")).properties);
    case "gradle":
    case "groovy":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/groovy")).groovy);
    default:
      return [];
  }
}

function languageLabel(filePath: string): string {
  const extension = fileExtension(filePath);

  switch (extension) {
    case "ts":
    case "tsx":
      return "TypeScript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "JavaScript";
    case "json":
      return "JSON";
    case "md":
    case "mdx":
      return "Markdown";
    case "css":
      return "CSS";
    case "scss":
    case "sass":
      return "Sass";
    case "html":
    case "htm":
      return "HTML";
    case "xml":
    case "svg":
    case "plist":
      return "XML";
    case "yaml":
    case "yml":
      return "YAML";
    case "py":
      return "Python";
    case "java":
      return "Java";
    case "kt":
    case "kts":
      return "Kotlin";
    case "dart":
      return "Dart";
    case "swift":
      return "Swift";
    case "go":
      return "Go";
    case "rs":
      return "Rust";
    case "sh":
    case "bash":
    case "zsh":
      return "Shell";
    case "c":
    case "h":
      return "C";
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return "C++";
    case "cs":
      return "C#";
    case "m":
      return "Objective-C";
    case "mm":
      return "Objective-C++";
    case "php":
    case "phtml":
      return "PHP";
    case "sql":
      return "SQL";
    case "rb":
      return "Ruby";
    case "lua":
      return "Lua";
    case "toml":
      return "TOML";
    case "properties":
      return "Properties";
    case "gradle":
    case "groovy":
      return "Groovy";
    default:
      return extension ? extension.toUpperCase() : "Plain Text";
  }
}

type BreadcrumbSegment = {
  label: string;
  path: string;
  type: "file" | "directory";
  menuPath: string;
};

type BreadcrumbMenuEntry = {
  label: string;
  path: string;
  type: "file" | "directory";
};

function breadcrumbSegments(filePath: string): BreadcrumbSegment[] {
  const parts = filePath.split("/").filter(Boolean);

  return parts.map((part, index) => {
    const path = parts.slice(0, index + 1).join("/");
    const isLast = index === parts.length - 1;

    return {
      label: part,
      path,
      type: isLast ? "file" : "directory",
      menuPath: isLast ? parts.slice(0, -1).join("/") : path,
    };
  });
}

function immediateChildren(path: string, fileEntries: FileEntry[]): BreadcrumbMenuEntry[] {
  const seen = new Map<string, BreadcrumbMenuEntry>();
  const prefix = path ? `${path}/` : "";

  for (const entry of fileEntries) {
    if (path) {
      if (entry.path !== path && !entry.path.startsWith(prefix)) {
        continue;
      }
      if (entry.path === path) {
        continue;
      }
    }

    const remainder = path ? entry.path.slice(prefix.length) : entry.path;
    if (!remainder) {
      continue;
    }

    const [nextPart, ...restParts] = remainder.split("/").filter(Boolean);
    if (!nextPart) {
      continue;
    }

    const childPath = path ? `${path}/${nextPart}` : nextPart;
    const childType = restParts.length > 0 ? "directory" : entry.type;
    const existing = seen.get(childPath);

    if (!existing || (existing.type === "file" && childType === "directory")) {
      seen.set(childPath, {
        label: nextPart,
        path: childPath,
        type: childType,
      });
    }
  }

  return Array.from(seen.values()).sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
  });
}

const EDITOR_BG = "hsl(var(--background))";
const EDITOR_SURFACE = "hsl(var(--background))";
const EDITOR_ACTIVE_LINE = "hsl(var(--secondary) / 0.52)";
const EDITOR_BORDER = "hsl(var(--border))";
const EDITOR_GUTTER_TEXT = "hsl(var(--muted-foreground))";
const EDITOR_FOREGROUND = "hsl(var(--foreground))";
const EDITOR_CARET = "hsl(var(--foreground) / 0.78)";
const GIT_ADDED = "#2ea043";
const GIT_MODIFIED = "#4cc2ff";
const GIT_DELETED = "#f85149";

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: EDITOR_BG,
    color: EDITOR_FOREGROUND,
  },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
    lineHeight: "1.6",
  },
  ".cm-content": {
    padding: "0 0 18px",
    minHeight: "100%",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    backgroundColor: EDITOR_BG,
    borderRight: `1px solid ${EDITOR_BORDER}`,
    color: EDITOR_GUTTER_TEXT,
    minWidth: "48px",
  },
  ".cm-git-gutter": {
    width: "12px",
    minWidth: "12px",
  },
  ".cm-git-gutter .cm-gutterElement": {
    padding: 0,
  },
  ".cm-git-marker": {
    display: "block",
    width: "5px",
    height: "100%",
    margin: "0 auto",
    borderRadius: "999px",
  },
  ".cm-git-marker-deleted": {
    width: 0,
    height: 0,
    margin: "5px auto 0",
    borderTop: "5px solid transparent",
    borderBottom: "5px solid transparent",
    borderLeft: `7px solid ${GIT_DELETED}`,
    borderRadius: 0,
  },
  ".cm-git-marker-added": {
    backgroundColor: GIT_ADDED,
  },
  ".cm-git-marker-modified": {
    backgroundColor: GIT_ADDED,
  },
  ".cm-git-marker-active": {
    width: "6px",
  },
  ".cm-git-marker-active.cm-git-marker-deleted": {
    borderLeftWidth: "8px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: EDITOR_ACTIVE_LINE,
    color: EDITOR_FOREGROUND,
  },
  ".cm-activeLine": {
    backgroundColor: EDITOR_ACTIVE_LINE,
  },
  ".cm-git-peek-widget": {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(38, 79, 120, 0.72)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-cursor, &.cm-focused .cm-cursor": {
    borderLeftColor: EDITOR_CARET,
  },
  ".cm-panels": {
    backgroundColor: EDITOR_SURFACE,
    color: EDITOR_FOREGROUND,
    borderBottom: `1px solid ${EDITOR_BORDER}`,
  },
  ".cm-panel.cm-search input[type=text]": {
    appearance: "none",
    WebkitAppearance: "none",
    minHeight: "30px",
    padding: "0 10px",
    borderRadius: "8px",
    border: `1px solid ${EDITOR_BORDER}`,
    backgroundColor: "hsl(var(--background) / 0.9)",
    color: EDITOR_FOREGROUND,
    fontSize: "12px",
    lineHeight: "1.2",
    boxShadow: "none",
    outline: "none",
  },
  ".cm-panel.cm-search input[type=text]::placeholder": {
    color: "hsl(var(--muted-foreground) / 0.72)",
  },
  ".cm-panel.cm-search input[type=text]:focus": {
    borderColor: "hsl(var(--ring) / 0.78)",
    boxShadow: "0 0 0 2px hsl(var(--ring) / 0.22)",
    backgroundColor: "hsl(var(--background))",
  },
  ".cm-panel.cm-search button": {
    appearance: "none",
    WebkitAppearance: "none",
    minHeight: "30px",
    padding: "0 10px",
    borderRadius: "8px",
    border: `1px solid ${EDITOR_BORDER}`,
    backgroundColor: "hsl(var(--secondary) / 0.62)",
    color: EDITOR_FOREGROUND,
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "1",
    boxShadow: "none",
    transition: "background-color 120ms ease, border-color 120ms ease, color 120ms ease",
  },
  ".cm-panel.cm-search button:hover": {
    backgroundColor: "hsl(var(--secondary) / 0.9)",
    borderColor: "hsl(var(--border) / 0.95)",
  },
  ".cm-panel.cm-search button:focus-visible": {
    outline: "none",
    boxShadow: "0 0 0 2px hsl(var(--ring) / 0.22)",
  },
  ".cm-panel.cm-search label": {
    color: EDITOR_GUTTER_TEXT,
    fontSize: "11px",
    fontWeight: "500",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    width: "13px",
    height: "13px",
    margin: 0,
    accentColor: "hsl(var(--primary))",
  },
  ".cm-searchMatch": {
    backgroundColor: "rgba(234, 177, 68, 0.2)",
    outline: "1px solid rgba(234, 177, 68, 0.35)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "rgba(38, 79, 120, 0.85)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "rgba(90, 93, 94, 0.9)",
    color: "#ffffff",
  },
}, { dark: true });

const vscodeDarkModern = vscodeDarkInit({
  settings: {
    background: EDITOR_BG,
    foreground: EDITOR_FOREGROUND,
    caret: EDITOR_CARET,
    selection: "#264f78",
    selectionMatch: "#264f7840",
    lineHighlight: EDITOR_ACTIVE_LINE,
    gutterBackground: EDITOR_BG,
    gutterForeground: EDITOR_GUTTER_TEXT,
    gutterActiveForeground: EDITOR_FOREGROUND,
  },
});

const SOFT_TAB = "  ";

const EMPTY_GIT_EXTENSION: Extension = [];

type GitPeekState = {
  hunkIndex: number;
};

function gitStatusLabel(status: GitChangeStatus | null): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "modified":
      return "Modified";
    case "renamed":
      return "Renamed";
    case "untracked":
      return "Untracked";
    default:
      return "Clean";
  }
}

function gitStatusColor(status: GitChangeStatus | null): string {
  switch (status) {
    case "added":
      return GIT_ADDED;
    case "deleted":
      return GIT_DELETED;
    case "modified":
    case "renamed":
    case "untracked":
      return GIT_MODIFIED;
    default:
      return EDITOR_GUTTER_TEXT;
  }
}

function fileNameLabel(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function runEditorStateCommand(view: EditorView | null, command: StateCommand) {
  if (!view) {
    return false;
  }

  return command({
    state: view.state,
    dispatch: view.dispatch.bind(view),
  });
}


function buildGitDecorations(
  state: EditorState,
  peek: {
    hunk: EditorGitHunk | null;
    patch: string | null;
    totalHunks: number;
    viewportWidth: number;
    loading: boolean;
    saving: boolean;
    gitBaselineReady: boolean;
    onClose: () => void;
    onNext: () => void;
    onPrevious: () => void;
    onRevert: () => void;
  } | null,
) {
  const builder = new RangeSetBuilder<Decoration>();
  const entries: Array<{
    from: number;
    to: number;
    side: number;
    decoration: Decoration;
  }> = [];

  if (peek?.hunk && peek.patch) {
    const peekWidgetState = {
      hunk: peek.hunk,
      patch: peek.patch,
      totalHunks: peek.totalHunks,
      viewportWidth: peek.viewportWidth,
      loading: peek.loading,
      saving: peek.saving,
      gitBaselineReady: peek.gitBaselineReady,
      onClose: peek.onClose,
      onNext: peek.onNext,
      onPrevious: peek.onPrevious,
      onRevert: peek.onRevert,
    };
    const widgetLine = state.doc.line(Math.min(Math.max(peek.hunk.endLine, 1), state.doc.lines));
    entries.push({
      from: widgetLine.to,
      to: widgetLine.to,
      side: 1,
      decoration: Decoration.widget({
        widget: new GitPeekWidget(peekWidgetState),
        block: true,
        side: 1,
      }),
    });
  }

  entries.sort((left, right) => {
    if (left.from !== right.from) {
      return left.from - right.from;
    }

    return left.side - right.side;
  });

  for (const entry of entries) {
    builder.add(entry.from, entry.to, entry.decoration);
  }

  return builder.finish();
}

class GitPeekWidget extends WidgetType {
  constructor(
    private readonly peek: {
      hunk: EditorGitHunk;
      patch: string;
      totalHunks: number;
      viewportWidth: number;
      loading: boolean;
      saving: boolean;
      gitBaselineReady: boolean;
      onClose: () => void;
      onNext: () => void;
      onPrevious: () => void;
      onRevert: () => void;
    },
  ) {
    super();
  }

  eq(other: GitPeekWidget) {
    return other.peek.hunk.index === this.peek.hunk.index
      && other.peek.patch === this.peek.patch
      && other.peek.totalHunks === this.peek.totalHunks
      && other.peek.viewportWidth === this.peek.viewportWidth
      && other.peek.loading === this.peek.loading
      && other.peek.saving === this.peek.saving
      && other.peek.gitBaselineReady === this.peek.gitBaselineReady;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-git-peek-widget";
    wrap.style.width = "100%";
    wrap.style.boxSizing = "border-box";
    const root = createRoot(wrap);
    root.render(
      <div
        className="mx-3 my-2 overflow-hidden border border-[#2b87d1] bg-[#1f1f1f] shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
        style={{ width: "calc(100% - 1.5rem)", maxWidth: "calc(100% - 1.5rem)" }}
      >
        <div className="flex h-8 min-w-0 items-center justify-between gap-3 border-b border-[#2b87d1]/60 px-3 text-xs text-slate-200">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            <span className="shrink-0 text-slate-400">Git local changes</span>
            <span className="shrink-0 text-slate-500">
              {this.peek.hunk.index + 1}/{this.peek.totalHunks}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!this.peek.gitBaselineReady || this.peek.saving || this.peek.loading}
              onClick={this.peek.onRevert}
              title="Revert hunk"
              aria-label="Revert hunk"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
              onClick={this.peek.onNext}
              title="Next change"
              aria-label="Next change"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
              onClick={this.peek.onPrevious}
              title="Previous change"
              aria-label="Previous change"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
              onClick={this.peek.onClose}
              title="Close change peek"
              aria-label="Close change peek"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="max-h-[320px] overflow-auto bg-[#1e1e1e]">
          <SafePatchDiff
            patch={this.peek.patch}
            options={{
              diffStyle: "unified",
              overflow: "scroll",
              theme: "pierre-dark",
              themeType: "dark",
              disableFileHeader: true,
              expandUnchanged: false,
              expansionLineCount: 8,
            }}
          />
        </div>
      </div>,
    );
    (wrap as GitPeekWidgetHost).__gitPeekRoot = root;
    return wrap;
  }

  destroy(dom: HTMLElement) {
    (dom as GitPeekWidgetHost).__gitPeekRoot?.unmount();
  }

  ignoreEvent() {
    return false;
  }
}

class GitChangeMarker extends GutterMarker {
  constructor(
    private readonly kind: EditorGitChangeKind,
    private readonly active: boolean,
    private readonly hidden = false,
  ) {
    super();
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = [
      "cm-git-marker",
      `cm-git-marker-${this.kind}`,
      this.active ? "cm-git-marker-active" : "",
    ].filter(Boolean).join(" ");

    if (this.hidden) {
      marker.style.opacity = "0";
    }

    return marker;
  }
}

function createGitEditorExtensions(args: {
  state: EditorState;
  hunks: EditorGitHunk[];
  activeHunkIndex: number;
  peekHunk: EditorGitHunk | null;
  peekPatch: string | null;
  viewportWidth: number;
  loading: boolean;
  saving: boolean;
  gitBaselineReady: boolean;
  onClosePeek: () => void;
  onNextPeek: () => void;
  onPreviousPeek: () => void;
  onRevertPeek: () => void;
  onMarkerClick: (hunkIndex: number) => void;
}) {
  if (args.hunks.length === 0) {
    return EMPTY_GIT_EXTENSION;
  }

  const hunkByLine = new Map<number, EditorGitHunk>();
  for (const hunk of args.hunks) {
    const markerLines = hunk.lineNumbers.length > 0 ? hunk.lineNumbers : [hunk.anchorLine];
    for (const lineNumber of markerLines) {
      hunkByLine.set(lineNumber, hunk);
    }
  }

  return [
    EditorView.decorations.of(buildGitDecorations(
      args.state,
      args.peekHunk && args.peekPatch
        ? {
          hunk: args.peekHunk,
          patch: args.peekPatch,
          totalHunks: args.hunks.length,
          viewportWidth: args.viewportWidth,
          loading: args.loading,
          saving: args.saving,
          gitBaselineReady: args.gitBaselineReady,
          onClose: args.onClosePeek,
          onNext: args.onNextPeek,
          onPrevious: args.onPreviousPeek,
          onRevert: args.onRevertPeek,
        }
        : null,
    )),
    gutter({
      class: "cm-git-gutter",
      initialSpacer: () => new GitChangeMarker("modified", false, true),
      lineMarker(view, line) {
        const lineNumber = view.state.doc.lineAt(line.from).number;
        const hunk = hunkByLine.get(lineNumber);
        return hunk ? new GitChangeMarker(hunk.kind, hunk.index === args.activeHunkIndex) : null;
      },
      domEventHandlers: {
        mousedown(view, line, event) {
          const lineNumber = view.state.doc.lineAt(line.from).number;
          const hunk = hunkByLine.get(lineNumber);
          if (!hunk) {
            return false;
          }

          event.preventDefault();
          args.onMarkerClick(hunk.index);
          return true;
        },
      },
    }),
  ];
}

export const insertSoftTabOrIndentSelection: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore({ state, dispatch });
  }

  dispatch(state.update(state.replaceSelection(SOFT_TAB), {
    scrollIntoView: true,
    userEvent: "input",
  }));
  return true;
};

export interface CodeEditorPanelProps {
  filePath: string;
  targetLine?: number;
  targetColumn?: number;
  fileEntries?: FileEntry[];
  content: string;
  mimeType?: string;
  gitHeadContent?: string | null;
  gitBaselineReady?: boolean;
  gitBaselineLoading?: boolean;
  gitBranch?: string;
  gitStatus?: GitChangeStatus | null;
  loading?: boolean;
  saving?: boolean;
  dirty?: boolean;
  error?: string | null;
  desktopApp?: boolean;
  mobileBottomOffset?: number;
  onChange: (content: string) => void;
  onSave: () => void;
  onRetry?: () => void;
  onOpenFile?: (path: string) => void;
}

function BreadcrumbPopover({
  segment,
  fileEntries,
  onOpenFile,
}: {
  segment: BreadcrumbSegment;
  fileEntries: FileEntry[];
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(segment.menuPath);

  useEffect(() => {
    setBrowsePath(segment.menuPath);
  }, [segment.menuPath]);

  const entries = useMemo(() => immediateChildren(browsePath, fileEntries), [browsePath, fileEntries]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setBrowsePath(segment.menuPath);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "rounded px-1 py-0.5 transition-colors hover:bg-secondary/55",
            segment.type === "file" ? "font-medium text-foreground/90" : "text-muted-foreground hover:text-foreground/85",
          )}
          title={segment.path}
        >
          {segment.label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        <div className="max-h-64 overflow-y-auto py-1">
          {entries.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No items here.</div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary/45"
                onClick={() => {
                  if (entry.type === "directory") {
                    setBrowsePath(entry.path);
                    return;
                  }

                  onOpenFile?.(entry.path);
                  setOpen(false);
                }}
              >
                {entry.type === "directory" ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-primary/85" />
                )}
                <span className="min-w-0 flex-1 truncate text-foreground/90">{entry.label}</span>
                {entry.type === "directory" ? (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function CodeEditorPanel({
  filePath,
  targetLine,
  targetColumn,
  fileEntries = [],
  content,
  mimeType = "text/plain",
  gitHeadContent = null,
  gitBaselineReady = false,
  gitBaselineLoading = false,
  gitBranch = "",
  gitStatus = null,
  loading = false,
  saving = false,
  dirty = false,
  error = null,
  desktopApp = false,
  mobileBottomOffset = 0,
  onChange,
  onSave,
  onRetry,
  onOpenFile,
}: CodeEditorPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastAppliedLocationRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const languageCompartmentRef = useRef(new Compartment());
  const gitCompartmentRef = useRef(new Compartment());
  const deferredContent = useDeferredValue(content);
  const isImageFile = mimeType.startsWith("image/");
  const imageSource = isImageFile ? `data:${mimeType};base64,${content}` : null;
  const [cursorLine, setCursorLine] = useState(1);
  const [compareMode, setCompareMode] = useState(false);
  const [gitPeek, setGitPeek] = useState<GitPeekState | null>(null);
  const [editorViewportWidth, setEditorViewportWidth] = useState(0);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const gitModel = useMemo(() => (
    gitBaselineReady
      ? buildEditorGitModel(filePath, gitHeadContent, deferredContent)
      : { diff: null, hunks: [], lines: [] }
  ), [deferredContent, filePath, gitBaselineReady, gitHeadContent]);
  const effectiveGitStatus = useMemo(
    () => deriveEditorGitStatus(gitStatus, gitModel.diff),
    [gitModel.diff, gitStatus],
  );
  const isNewFileGitMode = useMemo(() => (
    gitBaselineReady
    && gitHeadContent === null
    && (
      effectiveGitStatus === "untracked"
      || effectiveGitStatus === "added"
      || (gitModel.diff?.oldLines?.length ?? 0) === 0
    )
  ), [effectiveGitStatus, gitBaselineReady, gitHeadContent, gitModel.diff]);
  const inlineGitModel = useMemo(() => (
    isNewFileGitMode
      ? { ...gitModel, hunks: [], lines: [] }
      : gitModel
  ), [gitModel, isNewFileGitMode]);
  const currentGitHunkIndex = useMemo(
    () => findCurrentGitHunkIndex(inlineGitModel.hunks, cursorLine),
    [cursorLine, inlineGitModel.hunks],
  );
  const activeGitHunkIndex = gitPeek?.hunkIndex ?? currentGitHunkIndex;
  const activeGitHunk = activeGitHunkIndex >= 0 ? inlineGitModel.hunks[activeGitHunkIndex] ?? null : null;
  const peekPatch = useMemo(
    () => buildEditorGitPeekPatch(activeGitHunk),
    [activeGitHunk],
  );
  const compareDiff = useMemo(() => {
    if (!gitBaselineReady) {
      return null;
    }

    if (!compareMode) {
      return gitModel.diff;
    }

    return buildEditorGitModel(filePath, gitHeadContent, content).diff;
  }, [compareMode, content, filePath, gitBaselineReady, gitHeadContent, gitModel.diff]);

  const extensions = useMemo<Extension[]>(() => ([
    basicSetup,
    EditorState.tabSize.of(2),
    indentUnit.of(SOFT_TAB),
    keymap.of([
      {
        key: "Tab",
        run: insertSoftTabOrIndentSelection,
        shift: indentLess,
      },
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      keydown: (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          onSaveRef.current();
          return true;
        }
        return false;
      },
    }),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }

      if (update.selectionSet || update.docChanged) {
        const nextCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
        setCursorLine((current) => current === nextCursorLine ? current : nextCursorLine);
      }

      if (update.viewportChanged || update.geometryChanged) {
        const nextWidth = update.view.scrollDOM.clientWidth;
        setEditorViewportWidth((current) => current === nextWidth ? current : nextWidth);
      }

    }),
    vscodeDarkModern,
    editorTheme,
    languageCompartmentRef.current.of([]),
    gitCompartmentRef.current.of(EMPTY_GIT_EXTENSION),
  ]), [filePath]);

  const focusGitHunk = (hunkIndex: number) => {
    const view = viewRef.current;
    const hunk = inlineGitModel.hunks[hunkIndex];
    if (!view || !hunk) {
      return;
    }

    const lineNumber = Math.min(Math.max(hunk.anchorLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      scrollIntoView: true,
    });
    view.focus();
    setCursorLine(line.number);
  };

  const focusEditorLocation = (lineNumber: number, columnNumber?: number) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const clampedLineNumber = Math.min(Math.max(lineNumber, 1), view.state.doc.lines);
    const line = view.state.doc.line(clampedLineNumber);
    const columnOffset = Math.min(
      Math.max((columnNumber ?? 1) - 1, 0),
      line.to - line.from,
    );
    const cursorPosition = line.from + columnOffset;
    view.dispatch({
      selection: EditorSelection.cursor(cursorPosition),
      effects: EditorView.scrollIntoView(cursorPosition, {
        y: "center",
        x: "nearest",
      }),
    });
    view.focus();
    setCursorLine(line.number);
  };

  const navigateGitChange = (direction: -1 | 1) => {
    if (inlineGitModel.hunks.length === 0) {
      return;
    }

    const startIndex = activeGitHunkIndex >= 0 ? activeGitHunkIndex : 0;
    const nextIndex = (startIndex + direction + inlineGitModel.hunks.length) % inlineGitModel.hunks.length;
    focusGitHunk(nextIndex);
    if (gitPeek !== null) {
      setGitPeek({ hunkIndex: nextIndex });
    }
  };

  const openGitPeek = (hunkIndex: number) => {
    focusGitHunk(hunkIndex);
    setCompareMode(false);
    setGitPeek({ hunkIndex });
  };

  const closeGitPeek = () => {
    setGitPeek(null);
  };

  const handleRevertGitHunk = (hunkIndex: number) => {
    if (!gitBaselineReady) {
      return;
    }

    const nextContent = revertEditorGitHunk(content, inlineGitModel.hunks[hunkIndex] ?? null);
    onChangeRef.current(nextContent);
  };

  const handleUndo = () => {
    if (isImageFile || compareMode) {
      return;
    }

    const view = viewRef.current;
    if (runEditorStateCommand(view, undo)) {
      view?.focus();
    }
  };

  const handleRedo = () => {
    if (isImageFile || compareMode) {
      return;
    }

    const view = viewRef.current;
    if (runEditorStateCommand(view, redo)) {
      view?.focus();
    }
  };

  const handleToggleCompareMode = () => {
    closeGitPeek();
    setCompareMode((current) => !current);
  };

  const canNavigateGitChanges = inlineGitModel.hunks.length > 0 && !compareMode;
  const canCompare = !isImageFile && (!gitBaselineLoading || gitBaselineReady);
  const canUseHistoryActions = !isImageFile && !compareMode;
  const canSave = !isImageFile && !loading && !saving && dirty;
  const gitStateLabel = gitBaselineLoading && !gitBaselineReady
    ? "Git is loading"
    : isNewFileGitMode
      ? "New File"
      : gitStatusLabel(effectiveGitStatus);

  useEffect(() => {
    if (gitPeek === null) {
      return;
    }

    if (!inlineGitModel.hunks[gitPeek.hunkIndex]) {
      setGitPeek(null);
    }
  }, [gitPeek, inlineGitModel.hunks]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGitPeek(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (isImageFile) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: container,
    });

    viewRef.current = view;
    setCursorLine(view.state.doc.lineAt(view.state.selection.main.head).number);
    setEditorViewportWidth(view.scrollDOM.clientWidth);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
        const nextWidth = Math.round(entries[0]?.contentRect.width ?? view.scrollDOM.clientWidth);
        setEditorViewportWidth((current) => current === nextWidth ? current : nextWidth);
      });
    resizeObserver?.observe(view.scrollDOM);
    return () => {
      resizeObserver?.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions, isImageFile]);

  useEffect(() => {
    if (isImageFile) {
      return;
    }

    let cancelled = false;
    void languageExtensionForFile(filePath).then((langExt) => {
      if (cancelled) return;
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure(langExt),
      });
    });

    return () => { cancelled = true; };
  }, [filePath, isImageFile]);

  useEffect(() => {
    if (isImageFile) {
      return;
    }

    const view = viewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({
      effects: gitCompartmentRef.current.reconfigure(createGitEditorExtensions({
        state: view.state,
        hunks: inlineGitModel.hunks,
        activeHunkIndex: activeGitHunkIndex,
        peekHunk: gitPeek ? activeGitHunk : null,
        peekPatch: gitPeek ? peekPatch : null,
        viewportWidth: editorViewportWidth,
        loading,
        saving,
        gitBaselineReady,
        onClosePeek: closeGitPeek,
        onNextPeek: () => navigateGitChange(1),
        onPreviousPeek: () => navigateGitChange(-1),
        onRevertPeek: () => handleRevertGitHunk(activeGitHunkIndex),
        onMarkerClick: (hunkIndex) => {
          openGitPeek(hunkIndex);
        },
      })),
    });
  }, [
    activeGitHunk,
    activeGitHunkIndex,
    closeGitPeek,
    editorViewportWidth,
    gitBaselineReady,
    gitPeek,
    inlineGitModel.hunks,
    inlineGitModel.lines,
    loading,
    peekPatch,
    saving,
    isImageFile,
  ]);

  useEffect(() => {
    if (isImageFile) {
      return;
    }

    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === content) {
      return;
    }

    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: content },
    });
  }, [content, isImageFile]);

  useEffect(() => {
    if (isImageFile || !targetLine || loading) {
      return;
    }

    const view = viewRef.current;
    if (!view) {
      return;
    }

    if (view.state.doc.lines < targetLine) {
      return;
    }

    const locationKey = `${filePath}:${targetLine}:${targetColumn ?? 1}`;
    if (lastAppliedLocationRef.current === locationKey) {
      return;
    }

    focusEditorLocation(targetLine, targetColumn);
    lastAppliedLocationRef.current = locationKey;
  }, [content, filePath, focusEditorLocation, isImageFile, loading, targetColumn, targetLine]);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {error ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10">
          <div className="max-w-sm text-center">
            <p className="text-sm font-medium text-destructive">Editor failed to load this file.</p>
            <p className="mt-2 text-xs text-muted-foreground">{error}</p>
            {onRetry ? (
              <div className="mt-4">
                <Button type="button" variant="secondary" size="sm" className="h-8 rounded-md text-xs" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background pb-[52px] lg:pb-0">
          <div className="flex h-8 shrink-0 items-center border-b border-border bg-background/95 px-3 text-[11px] text-muted-foreground">
            <div
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="editor-breadcrumbs"
            >
              {breadcrumbSegments(filePath).map((segment, index, segments) => {
                const isLast = index === segments.length - 1;

                return (
                  <div key={`${segment.path}-${index}`} className="flex shrink-0 items-center gap-1">
                    {index > 0 ? <ChevronRight className="h-3 w-3 text-muted-foreground/50" /> : null}
                    {isLast ? (
                      <FileCode2 className="h-3.5 w-3.5 text-primary/85" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 text-muted-foreground/75" />
                    )}
                    <BreadcrumbPopover
                      segment={segment}
                      fileEntries={fileEntries}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
            {isImageFile ? (
              <div className="flex h-full w-full min-w-0 items-center justify-center overflow-auto bg-background p-4">
                {imageSource ? (
                  <ZoomableImage
                    src={imageSource}
                    alt={fileNameLabel(filePath)}
                    containerClassName="min-h-0 min-w-0"
                    imageClassName="shadow-[0_12px_40px_rgba(0,0,0,0.28)]"
                  />
                ) : null}
              </div>
            ) : (
              <div
                ref={containerRef}
                className={cn("h-full w-full min-w-0 overflow-hidden", (loading || compareMode) && "pointer-events-none opacity-0")}
                aria-label={`Code editor for ${filePath}`}
              />
            )}
            {compareMode ? (
              <div className="absolute inset-0 min-w-0 overflow-auto bg-background">
                {gitBaselineLoading && !gitBaselineReady ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading comparison...
                  </div>
                ) : compareDiff && compareDiff.hunks.length > 0 ? (
                  <FileDiff
                    fileDiff={compareDiff}
                    options={{
                      diffStyle: "split",
                      overflow: "scroll",
                      theme: "pierre-dark",
                      themeType: "dark",
                      disableFileHeader: true,
                      expandUnchanged: false,
                      expansionLineCount: 20,
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    No changes against HEAD.
                  </div>
                )}
              </div>
            ) : null}
            {loading ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : null}
          </div>
        </div>
      )}

      {!error ? (
        <>
          <div
            className={cn(
              "inset-x-0 z-10 border-t border-border bg-background px-1.5 py-1.5",
              desktopApp ? "hidden" : "lg:hidden",
              mobileBottomOffset > 0
                ? "fixed bottom-0 z-40 shadow-[0_-10px_30px_rgba(0,0,0,0.28)]"
                : "absolute bottom-0 safe-bottom",
            )}
            data-testid="code-editor-mobile-toolbar"
            style={mobileBottomOffset > 0 ? { bottom: "var(--cs-mobile-keyboard-offset, 0px)" } : undefined}
          >
            <div className="grid grid-cols-7 gap-1">
              <button
                type="button"
                className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleUndo}
                disabled={!canUseHistoryActions}
                aria-label="Undo"
                title="Undo"
              >
                <Undo2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleRedo}
                disabled={!canUseHistoryActions}
                aria-label="Redo"
                title="Redo"
              >
                <Redo2 className="h-4 w-4" />
              </button>
              {inlineGitModel.hunks.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => navigateGitChange(-1)}
                    disabled={!canNavigateGitChanges}
                    aria-label="Previous change"
                    title="Previous change"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => navigateGitChange(1)}
                    disabled={!canNavigateGitChanges}
                    aria-label="Next change"
                    title="Next change"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <div className="h-9" aria-hidden="true" />
                  <div className="h-9" aria-hidden="true" />
                </>
              )}
              <button
                type="button"
                className={cn(
                  "inline-flex h-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  compareMode ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                )}
                onClick={handleToggleCompareMode}
                disabled={!canCompare}
                aria-label={compareMode ? "Return to editor" : "Compare with HEAD"}
                title={compareMode ? "Return to editor" : "Compare with HEAD"}
              >
                <Eye className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={cn(
                  "relative inline-flex h-9 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                  canSave ? "text-primary hover:bg-primary/10" : "text-muted-foreground hover:bg-secondary/45 hover:text-foreground",
                )}
                onClick={onSave}
                disabled={!canSave}
                aria-label={saving ? "Saving file" : "Save file"}
                title={saving ? "Saving file" : "Save file"}
              >
                {dirty && !saving ? <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              </button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
                    aria-label="Editor info"
                    title="Editor info"
                  >
                    <Info className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" side="top" className="w-56 border-border/70 bg-popover/95 p-3 text-xs">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">File</span>
                      <span className="truncate text-right text-foreground">{fileNameLabel(filePath)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Status</span>
                      <span className="text-right" style={{ color: gitStatusColor(effectiveGitStatus) }}>{gitStateLabel}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Branch</span>
                      <span className="truncate text-right text-foreground">{gitBranch || "No branch"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Language</span>
                      <span className="text-right text-[#9cdcfe]">{languageLabel(filePath)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Changes</span>
                      <span className="text-right text-foreground">
                        {inlineGitModel.hunks.length > 0 ? `${activeGitHunkIndex + 1}/${inlineGitModel.hunks.length}` : "No hunks"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">State</span>
                      <span className="text-right text-foreground">
                        {saving ? "Saving" : loading ? "Loading" : dirty ? "Unsaved" : "Saved"}
                      </span>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div
            className={cn(
              "h-7 min-w-0 items-center justify-between gap-3 border-t border-border bg-background px-3 text-[11px] text-muted-foreground",
              desktopApp ? "flex" : "hidden lg:flex",
            )}
            data-testid="code-editor-desktop-statusbar"
          >
            <div className="flex min-w-0 items-center gap-3 truncate">
              <span className="truncate">
                {saving ? "Saving..." : loading ? "Loading file..." : dirty ? "Unsaved changes" : "Saved"}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <GitBranch className="h-3 w-3" />
                <span className="truncate">{gitBranch || "No branch"}</span>
              </span>
              <span className="shrink-0" style={{ color: gitStatusColor(effectiveGitStatus) }}>
                {gitStateLabel}
              </span>
              {inlineGitModel.hunks.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
                    onClick={() => navigateGitChange(-1)}
                    aria-label="Previous change"
                    title="Previous change"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <span className="shrink-0">
                    {activeGitHunkIndex + 1}/{inlineGitModel.hunks.length}
                  </span>
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground"
                    onClick={() => navigateGitChange(1)}
                    aria-label="Next change"
                    title="Next change"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                onClick={handleToggleCompareMode}
                disabled={!canCompare}
              >
                <Eye className="h-3 w-3" />
                <span>{compareMode ? "Editor" : "Compare"}</span>
              </button>
              <span className="text-[#9cdcfe]">{languageLabel(filePath)}</span>
              <span>{navigator.platform.toLowerCase().includes("mac") ? "Cmd+S" : "Ctrl+S"}</span>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
