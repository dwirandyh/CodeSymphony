import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import fuzzysort from "fuzzysort";
import { ArrowUp, FileText, Folder, Lightbulb, Square, Zap } from "lucide-react";
import type { ChatMode, FileEntry } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { serializeMention } from "../../lib/mentions";

type ComposerProps = {
  value: string;
  disabled: boolean;
  sending: boolean;
  showStop: boolean;
  stopping: boolean;
  mode: ChatMode;
  worktreeId: string | null;
  fileIndex: FileEntry[];
  fileIndexLoading: boolean;
  onChange: (nextValue: string) => void;
  onModeChange: (mode: ChatMode) => void;
  onSubmitMessage: (content: string) => void;
  onStop: () => void;
};

type MentionState = {
  active: boolean;
  query: string;
  startOffset: number;
  anchorNode: Node | null;
};

type MentionedFile = FileEntry & { id: string };

let mentionIdCounter = 0;
function nextMentionId(): string {
  mentionIdCounter += 1;
  return `mention-${mentionIdCounter}`;
}

function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

function getPlainTextFromEditor(el: HTMLElement): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement) {
      if (node.dataset.mentionPath) {
        text += `@${node.dataset.mentionPath}`;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else {
        text += node.textContent ?? "";
      }
    }
  }
  return text;
}

function getMentionedFilesFromEditor(el: HTMLElement): MentionedFile[] {
  const files: MentionedFile[] = [];
  const chips = el.querySelectorAll<HTMLElement>("[data-mention-path]");
  for (const chip of chips) {
    const path = chip.dataset.mentionPath;
    if (path) {
      const type = chip.dataset.mentionType === "directory" ? "directory" : "file";
      files.push({ id: chip.dataset.mentionId ?? nextMentionId(), path, type });
    }
  }
  return files;
}

function detectMentionInEditor(el: HTMLElement): MentionState {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const anchorNode = sel.anchorNode;
  if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const text = anchorNode.textContent ?? "";
  const cursorOffset = sel.anchorOffset;
  const textBeforeCursor = text.slice(0, cursorOffset);

  const atIndex = textBeforeCursor.lastIndexOf("@");
  if (atIndex === -1) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  if (atIndex > 0 && !/\s/.test(textBeforeCursor[atIndex - 1])) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  const query = textBeforeCursor.slice(atIndex + 1);
  if (/\s/.test(query) && query.trim().includes(" ")) {
    return { active: false, query: "", startOffset: -1, anchorNode: null };
  }

  return { active: true, query: query.trimEnd(), startOffset: atIndex, anchorNode };
}

const FILE_ICON_SVG =
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/>';

const FOLDER_ICON_SVG =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';

function createChipElement(file: MentionedFile): HTMLSpanElement {
  const isDir = file.type === "directory";
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.mentionPath = file.path;
  chip.dataset.mentionId = file.id;
  chip.dataset.mentionType = file.type;
  chip.className = isDir
    ? "inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/15 px-1.5 py-0 text-xs text-amber-400 mx-0.5 align-baseline cursor-default select-none"
    : "inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/15 px-1.5 py-0 text-xs text-blue-400 mx-0.5 align-baseline cursor-default select-none";
  chip.setAttribute("title", file.path);

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("class", "h-3 w-3 shrink-0 inline-block");
  icon.innerHTML = isDir ? FOLDER_ICON_SVG : FILE_ICON_SVG;

  const label = document.createElement("span");
  label.className = "max-w-[140px] truncate";
  label.textContent = fileName(file.path);

  chip.appendChild(icon);
  chip.appendChild(label);

  return chip;
}

export function Composer({
  value,
  disabled,
  sending,
  showStop,
  stopping,
  mode,
  worktreeId,
  fileIndex,
  fileIndexLoading,
  onChange,
  onModeChange,
  onSubmitMessage,
  onStop,
}: ComposerProps) {
  const isPlan = mode === "plan";

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startOffset: -1, anchorNode: null });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mentionedFilesRef = useRef<MentionedFile[]>([]);
  const isComposingRef = useRef(false);
  const suppressInputRef = useRef(false);

  const cannotSend = disabled || (value.trim().length === 0 && mentionedFilesRef.current.length === 0);

  type SuggestionEntry = FileEntry & { highlighted?: string };

  const suggestions: SuggestionEntry[] = useMemo(() => {
    if (!mention.active) return [];
    const alreadyMentioned = new Set(mentionedFilesRef.current.map((f) => f.path));
    const available = fileIndex.filter((e) => !alreadyMentioned.has(e.path));

    if (!mention.query) {
      const dirs = available.filter((e) => e.type === "directory").slice(0, 5);
      const files = available.filter((e) => e.type === "file").slice(0, 20 - dirs.length);
      return [...dirs, ...files];
    }

    const results = fuzzysort.go(mention.query, available, { key: "path", limit: 20 });
    return results.map((r) => ({ ...r.obj, highlighted: r.highlight("<mark>", "</mark>") }));
  }, [mention.active, mention.query, fileIndex]);

  // Reset selected index when suggestions change
  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions]);

  const closeMention = useCallback(() => {
    setMention({ active: false, query: "", startOffset: -1, anchorNode: null });
    setSelectedIndex(0);
  }, []);

  const syncValueFromEditor = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const plainText = getPlainTextFromEditor(editor);
    mentionedFilesRef.current = getMentionedFilesFromEditor(editor);
    onChange(plainText);
  }, [onChange]);

  const selectSuggestion = useCallback(
    (entry: FileEntry) => {
      const editor = editorRef.current;
      if (!editor || !mention.anchorNode) return;

      const textNode = mention.anchorNode;
      const text = textNode.textContent ?? "";

      const mentionFile: MentionedFile = { ...entry, id: nextMentionId() };
      const chip = createChipElement(mentionFile);

      const beforeAt = text.slice(0, mention.startOffset);
      const afterQuery = text.slice(mention.startOffset + 1 + mention.query.length);

      const beforeNode = document.createTextNode(beforeAt);
      const afterNode = document.createTextNode(afterQuery.length > 0 ? afterQuery : "\u00A0");

      const parent = textNode.parentNode;
      if (!parent) return;

      suppressInputRef.current = true;
      parent.insertBefore(beforeNode, textNode);
      parent.insertBefore(chip, textNode);
      parent.insertBefore(afterNode, textNode);
      parent.removeChild(textNode);

      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(afterNode, afterQuery.length > 0 ? 0 : 1);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      closeMention();
      syncValueFromEditor();
      suppressInputRef.current = false;
    },
    [mention.anchorNode, mention.startOffset, mention.query, closeMention, syncValueFromEditor],
  );

  const handleInput = useCallback(() => {
    if (suppressInputRef.current) return;
    if (isComposingRef.current) return;

    const editor = editorRef.current;
    if (!editor) return;

    syncValueFromEditor();

    requestAnimationFrame(() => {
      if (editor) {
        const detected = detectMentionInEditor(editor);
        setMention(detected);
      }
    });
  }, [syncValueFromEditor]);

  const buildFinalContent = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return value;

    const parts: string[] = [];
    for (const node of editor.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? "");
      } else if (node instanceof HTMLElement) {
        if (node.dataset.mentionPath) {
          const type = node.dataset.mentionType === "directory" ? "directory" : "file";
          parts.push(serializeMention(node.dataset.mentionPath, type));
        } else if (node.tagName === "BR") {
          parts.push("\n");
        } else {
          parts.push(node.textContent ?? "");
        }
      }
    }
    return parts.join("").replace(/\u00A0/g, " ").trim();
  }, [value]);

  const handleSubmit = useCallback(() => {
    if (cannotSend) return;
    const content = buildFinalContent();
    if (!content.trim()) return;

    const editor = editorRef.current;
    if (editor) {
      editor.innerHTML = "";
    }
    mentionedFilesRef.current = [];
    onSubmitMessage(content);
    onChange("");
  }, [cannotSend, buildFinalContent, onSubmitMessage, onChange]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const text = event.clipboardData.getData("text/plain");
      if (!text) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      range.deleteContents();

      const lines = text.split("\n");
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          fragment.appendChild(document.createElement("br"));
        }
        if (lines[i]) {
          fragment.appendChild(document.createTextNode(lines[i]));
        }
      }

      const lastNode = fragment.lastChild;
      range.insertNode(fragment);

      if (lastNode) {
        const newRange = document.createRange();
        newRange.setStartAfter(lastNode);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      }

      syncValueFromEditor();
    },
    [syncValueFromEditor],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (mention.active && suggestions.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % suggestions.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          selectSuggestion(suggestions[selectedIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeMention();
          return;
        }
      }

      // Backspace: delete mention chips when cursor is adjacent
      if (event.key === "Backspace") {
        const sel = window.getSelection();
        const editor = editorRef.current;
        if (sel && sel.rangeCount > 0 && editor) {
          const anchorNode = sel.anchorNode;
          const anchorOffset = sel.anchorOffset;

          // Case A: Cursor at offset 0 of a text node, previous sibling is a chip
          if (
            anchorNode &&
            anchorNode.nodeType === Node.TEXT_NODE &&
            anchorOffset === 0 &&
            anchorNode.previousSibling instanceof HTMLElement &&
            anchorNode.previousSibling.dataset.mentionPath
          ) {
            event.preventDefault();
            anchorNode.previousSibling.remove();
            syncValueFromEditor();
            return;
          }

          // Case B: Cursor in editor element itself, positioned after a chip child
          if (
            anchorNode === editor &&
            anchorOffset > 0 &&
            editor.childNodes[anchorOffset - 1] instanceof HTMLElement &&
            (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.mentionPath
          ) {
            event.preventDefault();
            editor.childNodes[anchorOffset - 1].remove();
            syncValueFromEditor();
            return;
          }

          // Case C: Cursor at offset 1 of a text node containing only NBSP, previous sibling is a chip
          if (
            anchorNode &&
            anchorNode.nodeType === Node.TEXT_NODE &&
            anchorOffset === 1 &&
            anchorNode.textContent === "\u00A0" &&
            anchorNode.previousSibling instanceof HTMLElement &&
            anchorNode.previousSibling.dataset.mentionPath
          ) {
            event.preventDefault();
            const chip = anchorNode.previousSibling;
            anchorNode.textContent = "";
            chip.remove();
            syncValueFromEditor();
            return;
          }
        }
      }

      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        onModeChange(isPlan ? "default" : "plan");
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }

      if (showStop) {
        return;
      }

      event.preventDefault();
      handleSubmit();
    },
    [mention.active, suggestions, selectedIndex, selectSuggestion, closeMention, isPlan, onModeChange, showStop, handleSubmit, syncValueFromEditor],
  );

  useEffect(() => {
    if (!mention.active) return;

    const item = popoverRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, mention.active]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (value === "" && editor.innerHTML !== "") {
      editor.innerHTML = "";
      mentionedFilesRef.current = [];
    }
  }, [value]);

  return (
    <section className="pb-1 pt-0.5 safe-bottom lg:pb-2 lg:pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative rounded-2xl border border-input/50 bg-background/20 px-3 pb-11 pt-2.5 lg:rounded-3xl lg:px-4 lg:pb-12 lg:pt-3">
          {mention.active && (suggestions.length > 0 || fileIndexLoading) && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 z-50 mb-2 w-full max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {fileIndexLoading && suggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading files...</div>
              ) : (
                suggestions.map((entry, index) => (
                  <button
                    key={entry.path}
                    type="button"
                    data-index={index}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                      index === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSuggestion(entry);
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    {entry.type === "directory" ? (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    {entry.highlighted ? (
                      <span className="truncate" dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                    ) : (
                      <span className="truncate">{entry.path}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          <div
            ref={editorRef}
            role="textbox"
            aria-multiline="true"
            aria-placeholder={isPlan ? "Describe what you want to plan..." : "Message CodeSymphony... (type @ to mention files)"}
            contentEditable={!disabled}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              handleInput();
            }}
            data-placeholder={isPlan ? "Describe what you want to plan..." : "Message CodeSymphony... (type @ to mention files)"}
            className={`min-h-[60px] w-full resize-none border-none bg-transparent p-0 text-sm text-foreground shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none md:min-h-[74px] ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
          />

          <div className="absolute bottom-2 left-2.5 flex items-center lg:bottom-3 lg:left-3">
            <button
              type="button"
              onClick={() => onModeChange(isPlan ? "default" : "plan")}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                isPlan
                  ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              }`}
              aria-label={isPlan ? "Switch to execute mode" : "Switch to plan mode"}
            >
              {isPlan ? <Lightbulb className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {isPlan ? "Plan" : "Execute"}
            </button>
            <kbd className="ml-1.5 hidden text-[10px] text-muted-foreground/50 sm:inline">Shift+Tab</kbd>
          </div>

          <Button
            type="button"
            onClick={showStop ? onStop : handleSubmit}
            disabled={showStop ? stopping : cannotSend}
            size="icon"
            aria-label={showStop ? "Stop run" : "Send message"}
            className="absolute bottom-2 right-2.5 h-8 w-8 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/80 disabled:text-black/70 lg:bottom-3 lg:right-3"
          >
            {showStop ? <Square className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
            <span className="sr-only">
              {showStop ? (stopping ? "Stopping..." : "Stop run") : sending ? "Running..." : "Send message"}
            </span>
          </Button>
        </div>
      </div>
    </section>
  );
}
