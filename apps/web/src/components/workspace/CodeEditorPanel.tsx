import { useEffect, useMemo, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { indentLess, indentMore } from "@codemirror/commands";
import { EditorState, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { php } from "@codemirror/lang-php";
import { sass } from "@codemirror/lang-sass";
import { sql } from "@codemirror/lang-sql";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { c, cpp, csharp, dart, kotlin, objectiveC, objectiveCpp } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { FileEntry } from "@codesymphony/shared-types";
import { ChevronRight, FileCode2, Folder, Loader2 } from "lucide-react";
import { vscodeDarkInit } from "@uiw/codemirror-theme-vscode";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";

function fileExtension(filePath: string): string {
  const filename = filePath.split("/").pop() ?? filePath;
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
}

function languageExtensionForFile(filePath: string): Extension {
  const extension = fileExtension(filePath);

  switch (extension) {
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown();
    case "css":
      return css();
    case "scss":
      return sass();
    case "sass":
      return sass({ indented: true });
    case "html":
    case "htm":
      return html();
    case "xml":
    case "svg":
    case "plist":
      return xml();
    case "yaml":
    case "yml":
      return yaml();
    case "py":
      return python();
    case "java":
      return java();
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin);
    case "dart":
      return StreamLanguage.define(dart);
    case "swift":
      return StreamLanguage.define(swift);
    case "go":
      return StreamLanguage.define(go);
    case "rs":
      return StreamLanguage.define(rust);
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define(shell);
    case "c":
    case "h":
      return StreamLanguage.define(c);
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hxx":
      return StreamLanguage.define(cpp);
    case "cs":
      return StreamLanguage.define(csharp);
    case "m":
      return StreamLanguage.define(objectiveC);
    case "mm":
      return StreamLanguage.define(objectiveCpp);
    case "php":
    case "phtml":
      return php({ plain: true });
    case "sql":
      return sql();
    case "rb":
      return StreamLanguage.define(ruby);
    case "lua":
      return StreamLanguage.define(lua);
    case "toml":
      return StreamLanguage.define(toml);
    case "properties":
      return StreamLanguage.define(properties);
    case "gradle":
    case "groovy":
      return StreamLanguage.define(groovy);
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
  ".cm-activeLineGutter": {
    backgroundColor: EDITOR_ACTIVE_LINE,
    color: EDITOR_FOREGROUND,
  },
  ".cm-activeLine": {
    backgroundColor: EDITOR_ACTIVE_LINE,
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
  fileEntries?: FileEntry[];
  content: string;
  loading?: boolean;
  saving?: boolean;
  dirty?: boolean;
  error?: string | null;
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
  fileEntries = [],
  content,
  loading = false,
  saving = false,
  dirty = false,
  error = null,
  onChange,
  onSave,
  onRetry,
  onOpenFile,
}: CodeEditorPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

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
    }),
    vscodeDarkModern,
    editorTheme,
    languageExtensionForFile(filePath),
  ]), [filePath]);

  useEffect(() => {
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
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
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
  }, [content]);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border bg-background">
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
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
          <div
            className="relative min-h-0 flex-1 overflow-hidden bg-background"
          >
            <div
              ref={containerRef}
              className={cn("h-full", loading && "opacity-40")}
              aria-label={`Code editor for ${filePath}`}
            />
            {loading ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80">
                <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
              </div>
            ) : null}
          </div>
        </div>
      )}

      {!error ? (
        <div className="flex h-7 items-center justify-between gap-3 border-t border-border bg-background px-3 text-[11px] text-muted-foreground">
          <div className="min-w-0 truncate">
            {saving ? "Saving..." : loading ? "Loading file..." : dirty ? "Unsaved changes" : "Saved"}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-[#9cdcfe]">{languageLabel(filePath)}</span>
            <span>{navigator.platform.toLowerCase().includes("mac") ? "Cmd+S" : "Ctrl+S"}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
