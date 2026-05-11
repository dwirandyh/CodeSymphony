import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Folder } from "lucide-react";
import type { CliAgent } from "@codesymphony/shared-types";
import { cn } from "../../lib/utils";
import { parseUserMentions } from "../../lib/mentions";
import { useComposerMention } from "../../components/workspace/composer/useComposerMention";
import { useComposerSlashCommand } from "../../components/workspace/composer/useComposerSlashCommand";
import {
  getMentionedFilesFromEditor,
  getSerializedTextFromEditor,
  nextMentionId,
} from "../../components/workspace/composer/composerEditorUtils";
import {
  createChipElement,
  createSlashCommandChipElement,
} from "../../components/workspace/composer/composerChipUtils";
import { useFileIndex } from "../workspace/hooks/useFileIndex";
import { useSlashCommands } from "../workspace/hooks/useSlashCommands";

function normalizeEditorValue(value: string): string {
  return value.replace(/\u00A0/g, " ");
}

function appendPlainText(target: HTMLElement, text: string) {
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    if (index > 0) {
      target.appendChild(document.createElement("br"));
    }

    if (line.length > 0) {
      target.appendChild(document.createTextNode(line));
    }
  });
}

function hydrateEditorFromSerializedValue(editor: HTMLDivElement, value: string) {
  editor.innerHTML = "";

  if (!value) {
    return;
  }

  const segments = parseUserMentions(value);

  for (const segment of segments) {
    if (segment.kind === "text") {
      appendPlainText(editor, segment.value);
      continue;
    }

    if (segment.kind === "mention") {
      editor.appendChild(createChipElement({
        id: nextMentionId(),
        path: segment.path,
        type: segment.isDirectory ? "directory" : "file",
      }));
      continue;
    }

    editor.appendChild(createSlashCommandChipElement(segment.name, segment.trigger));
  }

  const lastNode = editor.lastChild;
  if (
    lastNode instanceof HTMLElement
    && (lastNode.dataset.mentionPath || lastNode.dataset.slashCommand)
  ) {
    editor.appendChild(document.createTextNode("\u00A0"));
  }
}

const VIEWPORT_PADDING = 16;
const POPOVER_GAP = 8;
const MAX_POPOVER_HEIGHT = 240;

type FloatingPopoverPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getActiveTriggerRect(editor: HTMLDivElement, triggerState: {
  active: boolean;
  startOffset: number;
  anchorNode: Node | null;
}): DOMRect | null {
  if (!triggerState.active || !(triggerState.anchorNode instanceof Text)) {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    return null;
  }

  const textNode = triggerState.anchorNode;
  if (selection.anchorNode !== textNode) {
    return null;
  }

  const triggerOffset = clamp(triggerState.startOffset, 0, textNode.length);
  const cursorOffset = clamp(selection.anchorOffset, triggerOffset + 1, textNode.length);
  const range = document.createRange();
  range.setStart(textNode, triggerOffset);
  range.setEnd(textNode, cursorOffset);

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0);
  return rects.at(-1) ?? null;
}

function getFloatingPopoverPosition(editor: HTMLDivElement, anchorRect: DOMRect | null): FloatingPopoverPosition {
  const editorRect = editor.getBoundingClientRect();
  const referenceRect = anchorRect ?? editorRect;
  const availableAbove = Math.max(0, referenceRect.top - VIEWPORT_PADDING - POPOVER_GAP);
  const availableBelow = Math.max(0, window.innerHeight - referenceRect.bottom - VIEWPORT_PADDING - POPOVER_GAP);
  const maxWidth = Math.max(0, window.innerWidth - (VIEWPORT_PADDING * 2));
  const preferredWidth = Math.min(420, Math.max(280, editorRect.width * 0.55));
  const width = Math.min(preferredWidth, maxWidth);
  const left = Math.min(
    Math.max(referenceRect.left, VIEWPORT_PADDING),
    window.innerWidth - VIEWPORT_PADDING - width,
  );

  const placeAbove = availableAbove >= availableBelow;
  const maxHeight = Math.min(MAX_POPOVER_HEIGHT, placeAbove ? availableAbove : availableBelow);
  const top = placeAbove
    ? Math.max(VIEWPORT_PADDING, referenceRect.top - POPOVER_GAP - maxHeight)
    : Math.min(window.innerHeight - VIEWPORT_PADDING - maxHeight, referenceRect.bottom + POPOVER_GAP);

  return { top, left, width, maxHeight };
}

type AutomationPromptEditorProps = {
  value: string;
  onChange: (value: string) => void;
  worktreeId: string | null;
  agent: CliAgent;
  placeholder: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
};

export function AutomationPromptEditor({
  value,
  onChange,
  worktreeId,
  agent,
  placeholder,
  className,
  disabled = false,
  testId,
}: AutomationPromptEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<FloatingPopoverPosition | null>(null);
  const fileIndexState = useFileIndex(worktreeId);
  const slashCommandsState = useSlashCommands(worktreeId, agent);

  const getSerializedValue = useCallback((editor: HTMLDivElement) => (
    normalizeEditorValue(getSerializedTextFromEditor(editor))
  ), []);

  const {
    mention,
    selectedIndex,
    setSelectedIndex,
    mentionedFilesRef,
    suggestions,
    fileIndexLoading,
    closeMention,
    syncValueFromEditor,
    selectSuggestion,
    detectMention,
  } = useComposerMention({
    editorRef,
    popoverRef,
    fileIndex: fileIndexState.entries,
    fileIndexLoading: fileIndexState.loading,
    getEditorValue: getSerializedValue,
    onChange,
  });

  const {
    slashCommand,
    selectedIndex: selectedSlashCommandIndex,
    setSelectedIndex: setSelectedSlashCommandIndex,
    suggestions: slashCommandSuggestions,
    slashCommandsLoading,
    closeSlashCommand,
    selectSuggestion: selectSlashCommandSuggestion,
    detectSlashCommand,
  } = useComposerSlashCommand({
    editorRef,
    popoverRef,
    slashCommands: slashCommandsState.commands,
    slashCommandsLoading: slashCommandsState.loading,
    getEditorValue: getSerializedValue,
    onChange,
  });

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const currentValue = getSerializedValue(editor);
    if (currentValue === value) {
      mentionedFilesRef.current = getMentionedFilesFromEditor(editor);
      return;
    }

    hydrateEditorFromSerializedValue(editor, value);
    mentionedFilesRef.current = getMentionedFilesFromEditor(editor);
  }, [getSerializedValue, mentionedFilesRef, value, worktreeId]);

  useEffect(() => {
    if (!mention.active && !slashCommand.active) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInsideEditor = editorRef.current?.contains(target) ?? false;
      const clickedInsidePopover = popoverRef.current?.contains(target) ?? false;

      if (clickedInsideEditor || clickedInsidePopover) {
        return;
      }

      closeMention();
      closeSlashCommand();
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [closeMention, closeSlashCommand, mention.active, slashCommand.active]);

  const showMentionPopover = mention.active && (suggestions.length > 0 || fileIndexLoading);
  const showSlashPopover = slashCommand.active && (slashCommandSuggestions.length > 0 || slashCommandsLoading);

  useLayoutEffect(() => {
    if (!showMentionPopover && !showSlashPopover) {
      setPopoverPosition(null);
      return;
    }

    const updatePosition = () => {
      const editor = editorRef.current;
      if (!editor) {
        setPopoverPosition(null);
        return;
      }

      const activeTriggerRect = showMentionPopover
        ? getActiveTriggerRect(editor, mention)
        : getActiveTriggerRect(editor, slashCommand);

      setPopoverPosition(getFloatingPopoverPosition(editor, activeTriggerRect));
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("selectionchange", updatePosition);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("selectionchange", updatePosition);
    };
  }, [mention, showMentionPopover, showSlashPopover, slashCommand, value]);

  const handleInput = useCallback(() => {
    if (disabled) {
      return;
    }

    syncValueFromEditor();
    detectMention();
    detectSlashCommand();
  }, [detectMention, detectSlashCommand, disabled, syncValueFromEditor]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) {
      return;
    }

    event.preventDefault();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const fragment = document.createDocumentFragment();
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement("br"));
      }
      if (line) {
        fragment.appendChild(document.createTextNode(line));
      }
    });

    const lastNode = fragment.lastChild;
    range.insertNode(fragment);

    if (lastNode) {
      const nextRange = document.createRange();
      nextRange.setStartAfter(lastNode);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }

    syncValueFromEditor();
    detectMention();
    detectSlashCommand();
  }, [detectMention, detectSlashCommand, syncValueFromEditor]);

  const removePreviousChip = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return false;
    }

    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;

    const removeChip = (chip: HTMLElement, clearTextNode?: Text) => {
      if (clearTextNode) {
        clearTextNode.textContent = "";
      }
      chip.remove();
      syncValueFromEditor();
      detectMention();
      detectSlashCommand();
    };

    if (
      anchorNode
      && anchorNode.nodeType === Node.TEXT_NODE
      && anchorOffset === 0
      && anchorNode.previousSibling instanceof HTMLElement
      && (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.slashCommand)
    ) {
      removeChip(anchorNode.previousSibling);
      return true;
    }

    if (
      anchorNode === editor
      && anchorOffset > 0
      && editor.childNodes[anchorOffset - 1] instanceof HTMLElement
      && (
        (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.mentionPath
        || (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.slashCommand
      )
    ) {
      removeChip(editor.childNodes[anchorOffset - 1] as HTMLElement);
      return true;
    }

    if (
      anchorNode
      && anchorNode.nodeType === Node.TEXT_NODE
      && anchorOffset === 1
      && anchorNode.textContent === "\u00A0"
      && anchorNode.previousSibling instanceof HTMLElement
      && (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.slashCommand)
    ) {
      removeChip(anchorNode.previousSibling, anchorNode as Text);
      return true;
    }

    return false;
  }, [detectMention, detectSlashCommand, syncValueFromEditor]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
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

    if (slashCommand.active && slashCommandSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSlashCommandIndex((prev) => (prev + 1) % slashCommandSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSlashCommandIndex((prev) => (prev - 1 + slashCommandSuggestions.length) % slashCommandSuggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectSlashCommandSuggestion(slashCommandSuggestions[selectedSlashCommandIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlashCommand();
        return;
      }
    }

    if (event.key === "Backspace" && removePreviousChip()) {
      event.preventDefault();
    }
  }, [
    closeMention,
    closeSlashCommand,
    mention.active,
    removePreviousChip,
    selectSuggestion,
    selectedIndex,
    selectedSlashCommandIndex,
    setSelectedIndex,
    setSelectedSlashCommandIndex,
    slashCommand.active,
    slashCommandSuggestions,
    suggestions,
    selectSlashCommandSuggestion,
  ]);

  const floatingPopoverStyle = popoverPosition
    ? {
        position: "fixed" as const,
        top: popoverPosition.top,
        left: popoverPosition.left,
        width: popoverPosition.width,
        maxHeight: popoverPosition.maxHeight,
      }
    : undefined;

  return (
    <div className="relative">
      {showMentionPopover && popoverPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              style={floatingPopoverStyle}
              className="z-[70] overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {fileIndexLoading && suggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading files...</div>
              ) : (
                suggestions.map((entry, index) => (
                  <button
                    key={entry.path}
                    type="button"
                    data-index={index}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                      index === selectedIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
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
                      <span className="truncate" dir="rtl" style={{ textAlign: "left" }} dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                    ) : (
                      <span className="truncate" dir="rtl" style={{ textAlign: "left" }}>{entry.path}</span>
                    )}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}

      {showSlashPopover && popoverPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popoverRef}
              style={floatingPopoverStyle}
              className="z-[70] overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {slashCommandsLoading && slashCommandSuggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading commands...</div>
              ) : (
                slashCommandSuggestions.map((entry, index) => (
                  <button
                    key={entry.name}
                    type="button"
                    data-index={index}
                    className={cn(
                      "flex w-full items-start px-3 py-2 text-left text-sm transition-colors",
                      index === selectedSlashCommandIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50",
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectSlashCommandSuggestion(entry);
                    }}
                    onMouseEnter={() => setSelectedSlashCommandIndex(index)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {entry.highlighted ? (
                          <span className="font-medium">
                            {slashCommand.trigger}
                            <span dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                          </span>
                        ) : (
                          <span className="font-medium">{slashCommand.trigger}{entry.name}</span>
                        )}
                        {entry.argumentHint ? (
                          <span className="truncate text-xs text-muted-foreground">{entry.argumentHint}</span>
                        ) : null}
                      </span>
                      {entry.shortDescription ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{entry.shortDescription}</span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}

      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionEnd={handleInput}
        data-placeholder={placeholder}
        data-testid={testId}
        className={cn(
          "w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition-colors empty:before:pointer-events-none empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      />
    </div>
  );
}
