import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, FileText, Folder, Lightbulb, Paperclip, Square, X, Zap } from "lucide-react";
import type { ChatMode, ChatThreadPermissionMode, FileEntry, ModelProvider } from "@codesymphony/shared-types";
import { Button } from "../../ui/button";
import { serializeMention } from "../../../lib/mentions";
import type { PendingAttachment } from "../../../lib/attachments";
import {
  generateAttachmentId,
  generateClipboardFilename,
} from "../../../lib/attachments";
import { createAttachmentChipElement } from "./composerChipUtils";
import { useComposerMention } from "./useComposerMention";
import { useComposerAttachments } from "./useComposerAttachments";

type ComposerSubmitPayload = {
  content: string;
  mode: ChatMode;
  attachments: PendingAttachment[];
};

type ComposerProps = {
  disabled: boolean;
  sending: boolean;
  showStop: boolean;
  stopping: boolean;
  threadId: string | null;
  worktreeId: string | null;
  mode: ChatMode;
  modeLocked: boolean;
  fileIndex: FileEntry[];
  fileIndexLoading: boolean;
  providers: ModelProvider[];
  permissionMode: ChatThreadPermissionMode;
  hasMessages: boolean;
  onSubmitMessage: (payload: ComposerSubmitPayload) => Promise<boolean>;
  onModeChange: (mode: ChatMode) => void;
  onStop: () => void;
  onSelectProvider: (id: string | null) => void;
  onPermissionModeChange: (permissionMode: ChatThreadPermissionMode) => void;
};

export function Composer({
  disabled,
  sending,
  showStop,
  stopping,
  threadId,
  worktreeId,
  mode,
  modeLocked,
  fileIndex,
  fileIndexLoading,
  providers,
  permissionMode,
  hasMessages,
  onSubmitMessage,
  onModeChange,
  onStop,
  onSelectProvider,
  onPermissionModeChange,
}: ComposerProps) {
  const [draftText, setDraftText] = useState("");
  const isPlan = mode === "plan";
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const [permissionPopoverOpen, setPermissionPopoverOpen] = useState(false);
  const permissionPopoverRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!modelPopoverOpen && !permissionPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (modelPopoverRef.current && !modelPopoverRef.current.contains(e.target as Node)) {
        setModelPopoverOpen(false);
      }
      if (permissionPopoverRef.current && !permissionPopoverRef.current.contains(e.target as Node)) {
        setPermissionPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [modelPopoverOpen, permissionPopoverOpen]);

  const activeProvider = useMemo(() => providers.find((p) => p.isActive) ?? null, [providers]);
  const modelLabel = activeProvider ? `${activeProvider.modelId} · ${activeProvider.name}` : "CLI";
  const permissionModeLabel = permissionMode === "full_access" ? "Full Access" : "Default";

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const suppressInputRef = useRef(false);
  const prevContentLenRef = useRef(0);
  const afterChipHTMLRef = useRef<string | null>(null);
  const lastStableHTMLRef = useRef<string>("");

  const {
    mention,
    selectedIndex,
    setSelectedIndex,
    mentionedFilesRef,
    suggestions,
    closeMention,
    syncValueFromEditor,
    selectSuggestion,
    detectMention,
  } = useComposerMention({
    editorRef,
    popoverRef,
    fileIndex,
    fileIndexLoading,
    onChange: setDraftText,
  });

  const {
    attachments,
    attachmentsRef,
    pendingAttachmentReads,
    pendingAttachmentReadsRef,
    applyAttachmentsChange,
    fileInputRef,
    isDragOver,
    handleFileInputChange,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    handlePasteImages,
    barAttachments,
  } = useComposerAttachments({
    editorRef,
  });

  const cannotSend = disabled
    || pendingAttachmentReads > 0
    || (draftText.trim().length === 0 && mentionedFilesRef.current.length === 0 && attachments.length === 0);

  const handleInput = useCallback(() => {
    if (suppressInputRef.current) return;

    const editor = editorRef.current;
    if (!editor) return;

    const currentText = editor.textContent ?? "";
    const prevLen = prevContentLenRef.current;
    const inserted = currentText.length - prevLen;

    const savedHTML = afterChipHTMLRef.current;
    if (savedHTML !== null && inserted > 10) {
      afterChipHTMLRef.current = null;

      editor.removeAttribute("contenteditable");
      editor.innerHTML = savedHTML;
      editor.setAttribute("contenteditable", "true");

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

    afterChipHTMLRef.current = null;

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

        editor.removeAttribute("contenteditable");
        editor.innerHTML = lastStableHTMLRef.current;
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

        applyAttachmentsChange((prev) => [...prev, att]);
        syncValueFromEditor();
        prevContentLenRef.current = (editor.textContent ?? "").length;
        lastStableHTMLRef.current = editor.innerHTML;
        return;
      }
    }

    prevContentLenRef.current = (editor.textContent ?? "").length;
    lastStableHTMLRef.current = editor.innerHTML;
    syncValueFromEditor();

    queueMicrotask(() => {
      if (editor) {
        detectMention();
      }
    });
  }, [syncValueFromEditor, applyAttachmentsChange, detectMention]);

  const buildFinalContent = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return draftText;

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
  }, [draftText]);

  const resetDraft = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.innerHTML = "";
    }
    mentionedFilesRef.current = [];
    closeMention();
    applyAttachmentsChange([]);
    setDraftText("");
    lastStableHTMLRef.current = "";
    prevContentLenRef.current = 0;
    afterChipHTMLRef.current = null;
  }, [applyAttachmentsChange, closeMention]);

  const handleSubmit = useCallback(async () => {
    if (cannotSend) return;
    if (pendingAttachmentReadsRef.current > 0) return;
    const content = buildFinalContent();
    const currentAttachments = attachmentsRef.current;
    if (!content.trim() && currentAttachments.length === 0) return;

    const editor = editorRef.current;
    const inlineAttachmentIds = new Set<string>();
    if (editor) {
      const chips = editor.querySelectorAll<HTMLElement>("[data-attachment-id]");
      for (const chip of chips) {
        if (chip.dataset.attachmentId) inlineAttachmentIds.add(chip.dataset.attachmentId);
      }
    }

    const allAttachments = [
      ...currentAttachments,
      ...inlineAttachmentIds.size > 0
        ? currentAttachments.filter((a) => inlineAttachmentIds.has(a.id))
        : [],
    ];

    const seen = new Set<string>();
    const dedupedAttachments = allAttachments.filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });

    const didSubmit = await onSubmitMessage({ content, mode, attachments: dedupedAttachments });
    if (didSubmit) {
      resetDraft();
    }
  }, [cannotSend, buildFinalContent, onSubmitMessage, mode, resetDraft]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const clipboardData = event.clipboardData;

      if (handlePasteImages(clipboardData)) {
        event.preventDefault();
        return;
      }

      const text = clipboardData.getData("text/plain");

      if (!text) {
        return;
      }

      if (text.length > 300) {
        const editor = editorRef.current;
        const preHTML = editor?.innerHTML ?? "";

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

          afterChipHTMLRef.current = editor.innerHTML;
        }

        return;
      }

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
    [syncValueFromEditor, applyAttachmentsChange, handlePasteImages],
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

      if (event.key === "Backspace") {
        const sel = window.getSelection();
        const editor = editorRef.current;
        if (sel && sel.rangeCount > 0 && editor) {
          const anchorNode = sel.anchorNode;
          const anchorOffset = sel.anchorOffset;

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
        if (!modeLocked) {
          onModeChange(isPlan ? "default" : "plan");
        }
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
    [mention.active, suggestions, selectedIndex, selectSuggestion, closeMention, isPlan, modeLocked, onModeChange, showStop, isMobile, handleSubmit, syncValueFromEditor, applyAttachmentsChange],
  );

  useEffect(() => {
    resetDraft();
  }, [threadId, worktreeId, resetDraft]);

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
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 lg:rounded-3xl">
              <span className="text-sm font-medium text-primary">Drop files here</span>
            </div>
          )}

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
              onClick={() => {
                if (!modeLocked) {
                  onModeChange(isPlan ? "default" : "plan");
                }
              }}
              disabled={modeLocked}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                isPlan
                  ? "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              } disabled:cursor-not-allowed disabled:opacity-50`}
              aria-label={isPlan ? "Switch to execute mode" : "Switch to plan mode"}
            >
              {isPlan ? <Lightbulb className="h-3 w-3" /> : <Zap className="h-3 w-3" />}
              {isPlan ? "Plan" : "Execute"}
            </button>
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
                aria-label="Select model"
              >
                <span className="max-w-[180px] truncate">{modelLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>

              {modelPopoverOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[240px] rounded-lg border border-border/60 bg-popover p-1 shadow-lg">
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
                      CLI
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

            <div className="relative" ref={permissionPopoverRef}>
              <button
                type="button"
                onClick={() => setPermissionPopoverOpen((open) => !open)}
                disabled={disabled}
                className="flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Select permission mode"
              >
                <span className="max-w-[160px] truncate">{permissionModeLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>

              {permissionPopoverOpen && (
                <div className="absolute bottom-full left-0 z-50 mb-1.5 w-[220px] rounded-lg border border-border/60 bg-popover p-1 shadow-lg">
                  <div className="max-h-48 overflow-y-auto">
                    {[
                      { value: "default" as const, label: "Default", description: "Ask before approval-gated actions" },
                      { value: "full_access" as const, label: "Full Access", description: "Always allow approval-gated actions" },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                          permissionMode === option.value
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground hover:bg-accent/50"
                        }`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onPermissionModeChange(option.value);
                          setPermissionPopoverOpen(false);
                        }}
                      >
                        <span>{option.label}</span>
                        <span className="text-[11px] text-muted-foreground">{option.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="absolute bottom-2 right-2.5 flex items-center gap-2 lg:bottom-3 lg:right-3">
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
