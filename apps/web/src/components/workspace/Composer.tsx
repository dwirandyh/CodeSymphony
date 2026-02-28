import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import fuzzysort from "fuzzysort";
import { ArrowUp, ChevronDown, FileText, Folder, Lightbulb, Paperclip, Square, X, Zap } from "lucide-react";
import type { ChatMode, FileEntry, ModelProvider } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { serializeMention } from "../../lib/mentions";
import type { PendingAttachment } from "../../lib/attachments";
import {
  fileToAttachment,
  generateAttachmentId,
  generateClipboardFilename,
  isImageMimeType,
  validateAttachmentSize,
} from "../../lib/attachments";

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
  providers: ModelProvider[];
  hasMessages: boolean;
  attachments: PendingAttachment[];
  onAttachmentsChange: (attachments: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[])) => void;
  onChange: (nextValue: string) => void;
  onModeChange: (mode: ChatMode) => void;
  onSubmitMessage: (content: string, attachments: PendingAttachment[]) => void;
  onStop: () => void;
  onSelectProvider: (id: string | null) => void;
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
      if (node.dataset.attachmentId) {
        text += `{{attachment:${node.dataset.attachmentId}}}`;
      } else if (node.dataset.mentionPath) {
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

const PAPERCLIP_ICON_SVG =
  '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';

function createAttachmentChipElement(attachment: PendingAttachment): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.attachmentId = attachment.id;
  chip.className =
    "inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-1.5 py-0 text-xs text-purple-400 mx-0.5 align-baseline cursor-default select-none";
  chip.setAttribute("title", attachment.filename);

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("class", "h-3 w-3 shrink-0 inline-block");
  icon.innerHTML = PAPERCLIP_ICON_SVG;

  const label = document.createElement("span");
  label.className = "max-w-[140px] truncate";
  label.textContent = attachment.filename;

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
  providers,
  hasMessages,
  attachments,
  onAttachmentsChange,
  onChange,
  onModeChange,
  onSubmitMessage,
  onStop,
  onSelectProvider,
}: ComposerProps) {
  const isPlan = mode === "plan";
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 767px)");
    setIsMobile(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Close model popover on outside click
  useEffect(() => {
    if (!modelPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPopoverRef.current && !modelPopoverRef.current.contains(e.target as Node)) {
        setModelPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelPopoverOpen]);

  const activeProvider = useMemo(() => providers.find((p) => p.isActive) ?? null, [providers]);
  const modelLabel = activeProvider ? `${activeProvider.modelId} · ${activeProvider.name}` : "Default";

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [mention, setMention] = useState<MentionState>({ active: false, query: "", startOffset: -1, anchorNode: null });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const mentionedFilesRef = useRef<MentionedFile[]>([]);
  const isComposingRef = useRef(false);
  const suppressInputRef = useRef(false);
  const prevContentLenRef = useRef(0);
  // Stores editor innerHTML right after chip insertion by handlePaste.
  // If preventDefault() failed on mobile, handleInput will restore this HTML
  // to remove the raw text the browser forcefully inserted.
  const afterChipHTMLRef = useRef<string | null>(null);
  // Stores the last stable editor innerHTML (after chip insertions and normal edits).
  // Used by handleInput CASE 2 to preserve existing chips when rebuilding the editor.
  const lastStableHTMLRef = useRef<string>("");
  const attachmentsRef = useRef<PendingAttachment[]>(attachments);
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const pendingAttachmentReadsRef = useRef(0);

  const startAttachmentRead = useCallback(() => {
    pendingAttachmentReadsRef.current += 1;
    setPendingAttachmentReads((current) => current + 1);
  }, []);

  const finishAttachmentRead = useCallback(() => {
    pendingAttachmentReadsRef.current = Math.max(0, pendingAttachmentReadsRef.current - 1);
    setPendingAttachmentReads((current) => Math.max(0, current - 1));
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const applyAttachmentsChange = useCallback(
    (next: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[])) => {
      const resolved = typeof next === "function"
        ? next(attachmentsRef.current)
        : next;
      attachmentsRef.current = resolved;
      onAttachmentsChange(resolved);
    },
    [onAttachmentsChange],
  );

  const cannotSend = disabled
    || pendingAttachmentReads > 0
    || (value.trim().length === 0 && mentionedFilesRef.current.length === 0 && attachments.length === 0);

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

    const editor = editorRef.current;
    if (!editor) return;

    const currentText = editor.textContent ?? "";
    const prevLen = prevContentLenRef.current;
    const inserted = currentText.length - prevLen;

    // Case 1: handlePaste already inserted a chip, but preventDefault() failed
    // on mobile — browser forcefully added raw text. Restore the saved HTML.
    const savedHTML = afterChipHTMLRef.current;
    if (savedHTML !== null && inserted > 10) {
      afterChipHTMLRef.current = null;

      // Disable contentEditable to prevent input events during DOM manipulation
      editor.removeAttribute("contenteditable");
      editor.innerHTML = savedHTML;
      editor.setAttribute("contenteditable", "true");

      // Place cursor at end
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }

      syncValueFromEditor();
      prevContentLenRef.current = (editor.textContent ?? "").length;
      lastStableHTMLRef.current = editor.innerHTML;
      return;
    }

    // Clear the ref on normal input (no large insertion after paste)
    afterChipHTMLRef.current = null;

    // Case 2: onPaste never fired at all (some mobile keyboards/clipboard managers)
    // Detect large insertion and create attachment from scratch
    if (inserted > 300) {
      const pastedText = currentText.slice(prevLen).trim() || currentText.trim();
      if (pastedText.length > 300) {
        const filename = generateClipboardFilename(pastedText);
        const att: PendingAttachment = {
          id: generateAttachmentId(),
          filename,
          mimeType: "text/plain",
          content: pastedText,
          sizeBytes: new Blob([pastedText]).size,
          source: "clipboard_text",
          isInline: true,
        };

        // Restore from last stable HTML to preserve existing chips,
        // instead of using textContent which flattens chips to plain text.
        // Disable contentEditable to prevent input events during DOM manipulation
        editor.removeAttribute("contenteditable");
        editor.innerHTML = lastStableHTMLRef.current;
        const chip = createAttachmentChipElement(att);
        const space = document.createTextNode("\u00A0");
        editor.appendChild(chip);
        editor.appendChild(space);
        editor.setAttribute("contenteditable", "true");

        // Place cursor at end
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.setStartAfter(space);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }

        applyAttachmentsChange((prev) => [...prev, att]);
        syncValueFromEditor();
        prevContentLenRef.current = (editor.textContent ?? "").length;
        lastStableHTMLRef.current = editor.innerHTML;
        return;
      }
    }

    // Normal input
    prevContentLenRef.current = (editor.textContent ?? "").length;
    lastStableHTMLRef.current = editor.innerHTML;
    syncValueFromEditor();

    queueMicrotask(() => {
      if (editor) {
        const detected = detectMentionInEditor(editor);
        setMention(detected);
      }
    });
  }, [syncValueFromEditor, onAttachmentsChange]);

  const buildFinalContent = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return value;

    const parts: string[] = [];
    for (const node of editor.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? "");
      } else if (node instanceof HTMLElement) {
        if (node.dataset.attachmentId) {
          parts.push(`{{attachment:${node.dataset.attachmentId}}}`);
        } else if (node.dataset.mentionPath) {
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
    if (pendingAttachmentReadsRef.current > 0) return;
    const content = buildFinalContent();
    const currentAttachments = attachmentsRef.current;
    if (!content.trim() && currentAttachments.length === 0) return;

    // Collect inline attachments from the editor
    const editor = editorRef.current;
    const inlineAttachmentIds = new Set<string>();
    if (editor) {
      const chips = editor.querySelectorAll<HTMLElement>("[data-attachment-id]");
      for (const chip of chips) {
        if (chip.dataset.attachmentId) inlineAttachmentIds.add(chip.dataset.attachmentId);
      }
    }

    // Combine all attachments (bar attachments + inline)
    const allAttachments = [
      ...currentAttachments,
      ...inlineAttachmentIds.size > 0
        ? currentAttachments.filter((a) => inlineAttachmentIds.has(a.id))
        : [],
    ];

    // Deduplicate
    const seen = new Set<string>();
    const dedupedAttachments = allAttachments.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    if (editor) {
      editor.innerHTML = "";
    }
    mentionedFilesRef.current = [];
    onSubmitMessage(content, dedupedAttachments);
    applyAttachmentsChange([]);
    onChange("");
  }, [cannotSend, buildFinalContent, onSubmitMessage, applyAttachmentsChange, onChange]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;

      // Check for image files
      const imageFiles = Array.from(clipboardData.files).filter((f) =>
        isImageMimeType(f.type),
      );
      if (imageFiles.length > 0) {
        event.preventDefault();
        startAttachmentRead();
        void (async () => {
          try {
            const newAttachments: PendingAttachment[] = [];
            for (const file of imageFiles) {
              const sizeError = validateAttachmentSize(file);
              if (sizeError) continue;
              const att = await fileToAttachment(file, "clipboard_image");
              newAttachments.push(att);
            }
            if (newAttachments.length > 0) {
              applyAttachmentsChange((prev) => [...prev, ...newAttachments]);
            }
          } finally {
            finishAttachmentRead();
          }
        })();
        return;
      }

      // Check for text — if clipboard API is restricted (common on mobile),
      // let the browser paste natively; handleInput will catch large pastes
      const text = clipboardData.getData("text/plain");

      if (!text) {
        return;
      }

      // Auto-convert long text to attachment
      if (text.length > 300) {
        const editor = editorRef.current;
        const preHTML = editor?.innerHTML ?? "";

        // Try to prevent default — may fail silently on some mobile browsers
        event.preventDefault();

        const filename = generateClipboardFilename(text);
        const att: PendingAttachment = {
          id: generateAttachmentId(),
          filename,
          mimeType: "text/plain",
          content: text,
          sizeBytes: new Blob([text]).size,
          source: "clipboard_text",
          isInline: true,
        };

        applyAttachmentsChange((prev) => [...prev, att]);

        // Insert chip synchronously. Disable contentEditable during DOM manipulation
        // to prevent the browser from firing input events that cause infinite loops on mobile.
        if (editor) {
          editor.removeAttribute("contenteditable");
          editor.innerHTML = preHTML;
          const chip = createAttachmentChipElement(att);
          const space = document.createTextNode("\u00A0");
          editor.appendChild(chip);
          editor.appendChild(space);
          editor.setAttribute("contenteditable", "true");

          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.setStartAfter(space);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }

          syncValueFromEditor();
          prevContentLenRef.current = (editor.textContent ?? "").length;
          lastStableHTMLRef.current = editor.innerHTML;

          // Save the HTML so handleInput can restore it if preventDefault() failed
          // and the browser forcefully inserts raw text after this.
          afterChipHTMLRef.current = editor.innerHTML;
        }

        return;
      }

      // Normal short text paste
      event.preventDefault();
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
      prevContentLenRef.current = (editorRef.current?.textContent ?? "").length;
      lastStableHTMLRef.current = editorRef.current?.innerHTML ?? "";
    },
    [syncValueFromEditor, applyAttachmentsChange, startAttachmentRead, finishAttachmentRead],
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

      // Backspace: delete mention/attachment chips when cursor is adjacent
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
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId)
          ) {
            event.preventDefault();
            const chip = anchorNode.previousSibling;
            const attachmentId = chip.dataset.attachmentId;
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
            syncValueFromEditor();
            return;
          }

          // Case B: Cursor in editor element itself, positioned after a chip child
          if (
            anchorNode === editor &&
            anchorOffset > 0 &&
            editor.childNodes[anchorOffset - 1] instanceof HTMLElement &&
            ((editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.mentionPath ||
             (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.attachmentId)
          ) {
            event.preventDefault();
            const chip = editor.childNodes[anchorOffset - 1] as HTMLElement;
            const attachmentId = chip.dataset.attachmentId;
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
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
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId)
          ) {
            event.preventDefault();
            const chip = anchorNode.previousSibling;
            const attachmentId = chip.dataset.attachmentId;
            anchorNode.textContent = "";
            chip.remove();
            if (attachmentId) {
              applyAttachmentsChange((prev) => prev.filter((a) => a.id !== attachmentId));
            }
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

      if (isMobile) {
        return;
      }

      event.preventDefault();
      handleSubmit();
    },
    [mention.active, suggestions, selectedIndex, selectSuggestion, closeMention, isPlan, onModeChange, showStop, isMobile, handleSubmit, syncValueFromEditor, applyAttachmentsChange],
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
      lastStableHTMLRef.current = "";
      prevContentLenRef.current = 0;
    }
  }, [value]);

  // ── File input + drag-and-drop ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      startAttachmentRead();
      void (async () => {
        try {
          const newAttachments: PendingAttachment[] = [];
          for (const file of Array.from(files)) {
            const sizeError = validateAttachmentSize(file);
            if (sizeError) continue;
            const att = await fileToAttachment(file, "file_picker");
            newAttachments.push(att);
          }
          if (newAttachments.length > 0) {
            applyAttachmentsChange((prev) => [...prev, ...newAttachments]);
          }
        } finally {
          finishAttachmentRead();
        }
      })();

      // Reset file input so the same file can be re-selected
      event.target.value = "";
    },
    [applyAttachmentsChange, startAttachmentRead, finishAttachmentRead],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragOver(false);

      const files = event.dataTransfer.files;
      if (!files || files.length === 0) return;

      startAttachmentRead();
      void (async () => {
        try {
          const newAttachments: PendingAttachment[] = [];
          for (const file of Array.from(files)) {
            const sizeError = validateAttachmentSize(file);
            if (sizeError) continue;
            const att = await fileToAttachment(file, "drag_drop");
            newAttachments.push(att);
          }
          if (newAttachments.length > 0) {
            applyAttachmentsChange((prev) => [...prev, ...newAttachments]);
          }
        } finally {
          finishAttachmentRead();
        }
      })();
    },
    [applyAttachmentsChange, startAttachmentRead, finishAttachmentRead],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      // Also remove inline chip from editor if present
      const editor = editorRef.current;
      if (editor) {
        const chip = editor.querySelector(`[data-attachment-id="${id}"]`);
        if (chip) chip.remove();
      }
      applyAttachmentsChange((prev) => prev.filter((a) => a.id !== id));
    },
    [applyAttachmentsChange],
  );

  // Non-inline attachments shown as chips above the editor
  const barAttachments = attachments.filter((a) => !a.isInline);

  return (
    <section className="pb-1 pt-0.5 safe-bottom lg:pb-2 lg:pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`relative rounded-2xl border bg-background/20 px-3 pb-11 pt-2.5 lg:rounded-3xl lg:px-4 lg:pb-12 lg:pt-3 transition-colors ${
            isDragOver ? "border-primary/60 bg-primary/5" : "border-input/50"
          }`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* ── Drag overlay ── */}
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 lg:rounded-3xl">
              <span className="text-sm font-medium text-primary">Drop files here</span>
            </div>
          )}

          {/* ── Hidden file input ── */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="text/*,image/*,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.md,.json,.yaml,.yml,.toml,.sql,.sh,.css,.scss,.html,.xml,.svg"
            className="hidden"
            onChange={handleFileInputChange}
          />

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
                      <span className="truncate" dir="rtl" style={{ textAlign: "left" }} dangerouslySetInnerHTML={{ __html: entry.highlighted }} />
                    ) : (
                      <span className="truncate" dir="rtl" style={{ textAlign: "left" }}>{entry.path}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          {/* ── Attachment bar ── */}
          {barAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {barAttachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-secondary/40 px-2 py-1 text-xs text-foreground"
                >
                  {att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.filename}
                      className="h-6 w-6 rounded object-cover"
                    />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="max-w-[120px] truncate">{att.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                    aria-label={`Remove ${att.filename}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
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
            className={`min-h-[60px] max-h-[140px] w-full overflow-y-auto resize-none border-none bg-transparent p-0 text-sm text-foreground shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none md:min-h-[74px] md:max-h-[400px] ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
          />

          <div className="absolute bottom-2 left-2.5 flex items-center gap-2 lg:bottom-3 lg:left-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex items-center justify-center rounded-full bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:opacity-50"
              aria-label="Attach files"
            >
              <Paperclip className="h-3 w-3" />
            </button>
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
            <kbd className="hidden text-[10px] text-muted-foreground/50 sm:inline">Shift+Tab</kbd>
          </div>

          <div className="absolute bottom-2 right-2.5 flex items-center gap-2 lg:bottom-3 lg:right-3">
            {/* Model selector */}
            <div className="relative" ref={modelPopoverRef}>
              <button
                type="button"
                onClick={() => !hasMessages && setModelPopoverOpen(!modelPopoverOpen)}
                disabled={hasMessages}
                title={hasMessages ? "Model is locked for this thread. Start a new thread to change models." : undefined}
                className={`flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors ${
                  hasMessages
                    ? "cursor-not-allowed opacity-50"
                    : "hover:bg-secondary/70 hover:text-foreground"
                }`}
              >
                <span className="max-w-[180px] truncate">{modelLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>

              {modelPopoverOpen && (
                <div className="absolute bottom-full right-0 z-50 mb-1.5 w-[240px] rounded-lg border border-border/60 bg-popover p-1 shadow-lg">
                  <div className="max-h-48 overflow-y-auto">
                    <button
                      type="button"
                      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        !activeProvider
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent/50"
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelectProvider(null);
                        setModelPopoverOpen(false);
                      }}
                    >
                      Default (CLI)
                    </button>
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                          p.isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-accent/50"
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onSelectProvider(p.id);
                          setModelPopoverOpen(false);
                        }}
                      >
                        <span className="truncate">{p.modelId}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="truncate text-muted-foreground">{p.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <Button
              type="button"
              onClick={showStop ? onStop : handleSubmit}
              disabled={showStop ? stopping : cannotSend}
              size="icon"
              aria-label={showStop ? "Stop run" : "Send message"}
              className="h-8 w-8 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/80 disabled:text-black/70"
            >
              {showStop ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <ArrowUp className="h-3.5 w-3.5" />}
              <span className="sr-only">
                {showStop ? (stopping ? "Stopping..." : "Stop run") : sending ? "Running..." : "Send message"}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
