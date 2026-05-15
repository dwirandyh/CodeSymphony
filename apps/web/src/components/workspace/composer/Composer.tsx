import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Folder,
  Lightbulb,
  Plus,
  SlidersHorizontal,
  ShieldCheck,
  Square,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  type ChatQueuedMessage,
  type ChatThreadKind,
  type CodexModelCatalogEntry,
  type CursorModelCatalogEntry,
  type ChatMode,
  type ChatThreadPermissionMode,
  type CliAgent,
  type FileEntry,
  type ModelProvider,
  type OpencodeModelCatalogEntry,
  type SlashCommand,
  type UpdateChatThreadAgentSelectionInput,
} from "@codesymphony/shared-types";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog";
import type { PendingAttachment } from "../../../lib/attachments";
import type { RuntimeInfo } from "../../../lib/api";
import { debugLog } from "../../../lib/debugLog";
import {
  generateAttachmentId,
  generateClipboardFilename,
} from "../../../lib/attachments";
import { cn } from "../../../lib/utils";
import { AttachmentPreviewPanel } from "../chat-message-list/AttachmentComponents";
import { QueuedMessageList } from "../QueuedMessageList";
import { createAttachmentChipElement } from "./composerChipUtils";
import { getSerializedTextFromEditor } from "./composerEditorUtils";
import {
  buildComposerDraftFragment,
  clearPersistedComposerDraft,
  readPersistedComposerDraft,
  resolveComposerDraftStorageId,
  writePersistedComposerDraft,
} from "./composerDraftPersistence";
import { useComposerMention } from "./useComposerMention";
import { useComposerAttachments } from "./useComposerAttachments";
import { useComposerSlashCommand } from "./useComposerSlashCommand";
import { useFileIndex } from "../../../pages/workspace/hooks/useFileIndex";
import { resolveAgentDefaultModel } from "../../../lib/agentModelDefaults";
import {
  AgentIcon,
  AgentModelSelector,
  AGENT_LABELS,
  buildAgentSelectionOptions,
  getCurrentAgentSelectionOption,
  isFirstCustomModelOption,
  type AgentSelectionOption,
} from "./AgentModelSelector";

type ComposerSubmitPayload = {
  content: string;
  mode: ChatMode;
  attachments: PendingAttachment[];
};

type ComposerProps = {
  disabled: boolean;
  sending: boolean;
  queueing?: boolean;
  showStop: boolean;
  stopping: boolean;
  attachedTop?: boolean;
  threadId: string | null;
  worktreeId: string | null;
  mode: ChatMode;
  modeLocked: boolean;
  fileIndex?: FileEntry[];
  fileIndexLoading?: boolean;
  slashCommands: SlashCommand[];
  slashCommandsLoading: boolean;
  providers: ModelProvider[];
  codexModels?: readonly CodexModelCatalogEntry[];
  cursorModels?: readonly CursorModelCatalogEntry[];
  opencodeModels: readonly OpencodeModelCatalogEntry[];
  agent?: CliAgent;
  model?: string;
  modelProviderId?: string | null;
  runtimeInfo?: RuntimeInfo | null;
  threadKind?: ChatThreadKind | null;
  threadRunning?: boolean;
  permissionMode: ChatThreadPermissionMode;
  hasMessages: boolean;
  queuedMessages?: ChatQueuedMessage[];
  onSubmitMessage: (payload: ComposerSubmitPayload) => Promise<boolean>;
  onQueueDraft?: (payload: ComposerSubmitPayload) => Promise<boolean>;
  onModeChange: (mode: ChatMode) => void;
  onStop: () => void;
  onAgentSelectionChange?: (selection: UpdateChatThreadAgentSelectionInput) => void;
  onPermissionModeChange: (permissionMode: ChatThreadPermissionMode) => void;
  onDeleteQueuedMessage?: (queueMessageId: string) => void;
  onDispatchQueuedMessage?: (queueMessageId: string) => void;
  onUpdateQueuedMessage?: (queueMessageId: string, content: string) => Promise<boolean>;
};

type ModelSelectionBlockedReasonParams = {
  threadId: string | null;
  hasMessages: boolean;
  threadKind: ChatThreadKind | null | undefined;
  threadRunning: boolean;
  agent: CliAgent;
  modelProviderId: string | null;
  currentProvider: ModelProvider | null;
};

type PermissionOption = {
  value: ChatThreadPermissionMode;
  label: string;
  description: string;
  icon: LucideIcon;
};

const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Ask before approval-gated actions",
    icon: Clock3,
  },
  {
    value: "full_access",
    label: "Full Access",
    description: "Always allow approval-gated actions",
    icon: ShieldCheck,
  },
];

function getModelSelectionBlockedReason(params: ModelSelectionBlockedReasonParams): string | null {
  if (!params.threadId) {
    return "Start a new thread before choosing an agent or model.";
  }

  if (params.threadRunning) {
    return "Wait for the current run to finish before changing the model.";
  }

  if (!params.hasMessages) {
    return null;
  }

  if (params.threadKind !== "default") {
    return "Review threads keep their model locked. Start a new thread to change it.";
  }

  if (
    params.agent === "claude"
    && params.modelProviderId !== null
    && Boolean(params.currentProvider?.baseUrl?.trim())
  ) {
    return "Claude threads using a custom endpoint keep their model locked after the first message.";
  }

  if (params.modelProviderId !== null) {
    return "Threads using a custom model provider keep their model locked after the first message.";
  }

  return null;
}

function AttachmentPreviewDialog({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: PendingAttachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!attachment) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-fit border-none bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">Attachment preview</DialogTitle>
        <DialogDescription className="sr-only">{attachment.filename}</DialogDescription>
        <AttachmentPreviewPanel attachment={attachment} />
      </DialogContent>
    </Dialog>
  );
}

function getComposerDraftStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function moveComposerCaretToEnd(editor: HTMLDivElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function ComposerContent({
  disabled,
  sending,
  queueing = false,
  showStop,
  stopping,
  attachedTop = false,
  threadId,
  worktreeId,
  mode,
  modeLocked,
  fileIndex,
  fileIndexLoading,
  slashCommands,
  slashCommandsLoading,
  providers,
  codexModels = [],
  cursorModels = [],
  opencodeModels,
  agent: providedAgent,
  model: providedModel,
  modelProviderId: providedModelProviderId,
  runtimeInfo = null,
  threadKind,
  threadRunning = false,
  permissionMode,
  hasMessages,
  queuedMessages = [],
  onSubmitMessage,
  onQueueDraft,
  onModeChange,
  onStop,
  onAgentSelectionChange: onAgentSelectionChangeProp,
  onPermissionModeChange,
  onDeleteQueuedMessage,
  onDispatchQueuedMessage,
  onUpdateQueuedMessage,
}: ComposerProps) {
  const [draftText, setDraftText] = useState("");
  const [attachmentPreviewId, setAttachmentPreviewId] = useState<string | null>(null);
  const agent = providedAgent ?? "claude";
  const model = providedModel ?? resolveAgentDefaultModel(agent);
  const modelProviderId = providedModelProviderId ?? null;
  const onAgentSelectionChange = onAgentSelectionChangeProp ?? (() => {});
  const isPlan = mode === "plan";
  const [modelPreviewAgent, setModelPreviewAgent] = useState<CliAgent>(agent);
  const [permissionPopoverOpen, setPermissionPopoverOpen] = useState(false);
  const permissionPopoverRef = useRef<HTMLDivElement>(null);
  const [permissionPreviewMode, setPermissionPreviewMode] = useState<ChatThreadPermissionMode | null>(null);
  const [mobileSessionSheetOpen, setMobileSessionSheetOpen] = useState(false);
  const hasProvidedFileIndex = fileIndex !== undefined && typeof fileIndexLoading === "boolean";
  const [hasRequestedFileIndex, setHasRequestedFileIndex] = useState(() => hasProvidedFileIndex);
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
    if (!permissionPopoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (permissionPopoverRef.current && !permissionPopoverRef.current.contains(e.target as Node)) {
        setPermissionPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [permissionPopoverOpen]);

  useEffect(() => {
    setModelPreviewAgent(agent);
  }, [agent]);

  useEffect(() => {
    if (!isMobile) {
      setMobileSessionSheetOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (!mobileSessionSheetOpen) {
      return;
    }
    setPermissionPopoverOpen(false);
    setPermissionPreviewMode(null);
  }, [mobileSessionSheetOpen]);

  useEffect(() => {
    setHasRequestedFileIndex(hasProvidedFileIndex);
  }, [hasProvidedFileIndex, worktreeId]);

  const queuedMessageHandlers = onDeleteQueuedMessage && onDispatchQueuedMessage && onUpdateQueuedMessage
    ? {
      onDelete: onDeleteQueuedMessage,
      onDispatch: onDispatchQueuedMessage,
      onUpdate: onUpdateQueuedMessage,
    }
    : null;
  const canRenderQueuedMessages = queuedMessages.length > 0 && queuedMessageHandlers !== null;
  const codexBuiltinModelOverride = runtimeInfo?.codexCliProviderOverride?.model ?? null;
  const agentOptions = useMemo<Record<CliAgent, AgentSelectionOption[]>>(() => buildAgentSelectionOptions({
    providers,
    codexModels,
    cursorModels,
    opencodeModels,
    codexBuiltinModelOverride,
  }), [codexBuiltinModelOverride, codexModels, cursorModels, opencodeModels, providers]);
  const currentProvider = useMemo(
    () => (modelProviderId ? providers.find((provider) => provider.id === modelProviderId) ?? null : null),
    [modelProviderId, providers],
  );
  const selectionBlockedReason = useMemo(() => getModelSelectionBlockedReason({
    threadId,
    hasMessages,
    threadKind,
    threadRunning,
    agent,
    modelProviderId,
    currentProvider,
  }), [agent, currentProvider, hasMessages, modelProviderId, threadId, threadKind, threadRunning]);
  const selectionLocked = selectionBlockedReason !== null;
  const showAgentList = !hasMessages;
  const modelPreviewTargetAgent = showAgentList ? modelPreviewAgent : agent;
  const modelPreviewOptions = useMemo(() => {
    const options = agentOptions[modelPreviewTargetAgent];
    if (!hasMessages) {
      return options;
    }

    return options.filter((option) => option.modelProviderId === modelProviderId);
  }, [agentOptions, hasMessages, modelPreviewTargetAgent, modelProviderId]);
  const currentSelection = useMemo(
    () => getCurrentAgentSelectionOption(agentOptions, {
      agent,
      model,
      modelProviderId,
    }),
    [agent, agentOptions, model, modelProviderId],
  );
  const modelLabel = `${AGENT_LABELS[agent]} · ${currentSelection.label}`;
  const activePermissionOption = useMemo(
    () => PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[0],
    [permissionMode],
  );
  const previewPermissionOption = useMemo(
    () => PERMISSION_OPTIONS.find((option) => option.value === permissionPreviewMode) ?? null,
    [permissionPreviewMode],
  );
  const permissionTriggerClassName = permissionMode === "full_access" ? "text-orange-500" : "text-muted-foreground";
  const mobileSessionSummaryLabel = permissionMode === "full_access"
    ? `${AGENT_LABELS[agent]} · Full Access`
    : modelLabel;

  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);
  const suppressInputRef = useRef(false);
  const prevContentLenRef = useRef(0);
  const afterChipHTMLRef = useRef<string | null>(null);
  const lastStableHTMLRef = useRef<string>("");
  const shouldLoadInternalFileIndex = !hasProvidedFileIndex && hasRequestedFileIndex;
  const fileIndexState = useFileIndex(shouldLoadInternalFileIndex ? worktreeId : null);
  const mentionFileIndex = fileIndex ?? fileIndexState.entries;
  const mentionFileIndexLoading = fileIndexLoading ?? fileIndexState.loading;
  const draftStorageId = useMemo(
    () => resolveComposerDraftStorageId({ threadId, worktreeId }),
    [threadId, worktreeId],
  );
  const persistDraftContent = useCallback((content: string) => {
    const storage = getComposerDraftStorage();
    if (!storage) {
      return;
    }

    writePersistedComposerDraft(storage, {
      draftId: draftStorageId,
      content,
    });
  }, [draftStorageId]);
  const clearStoredDraft = useCallback(() => {
    const storage = getComposerDraftStorage();
    if (!storage) {
      return;
    }

    clearPersistedComposerDraft(storage, draftStorageId);
  }, [draftStorageId]);
  const handleDraftChange = useCallback((nextDraftText: string) => {
    setDraftText(nextDraftText);

    const editor = editorRef.current;
    const nextPersistedContent = editor
      ? getSerializedTextFromEditor(editor).replace(/\u00A0/g, " ")
      : nextDraftText;

    persistDraftContent(nextPersistedContent);
  }, [persistDraftContent]);

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
    fileIndex: mentionFileIndex,
    fileIndexLoading: mentionFileIndexLoading,
    onChange: handleDraftChange,
  });

  useEffect(() => {
    if (!hasProvidedFileIndex && mention.active && !hasRequestedFileIndex) {
      setHasRequestedFileIndex(true);
    }
  }, [hasProvidedFileIndex, hasRequestedFileIndex, mention.active]);

  const {
    attachments,
    attachmentsRef,
    pendingAttachmentReads,
    pendingAttachmentReadsRef,
    applyAttachmentsChange,
    fileInputRef,
    isDragOver,
    handleFileInputChange,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removeAttachment,
    handlePasteImages,
    barAttachments,
  } = useComposerAttachments({
    editorRef,
  });

  const {
    slashCommand,
    selectedIndex: selectedSlashCommandIndex,
    setSelectedIndex: setSelectedSlashCommandIndex,
    suggestions: slashCommandSuggestions,
    slashCommandsLoading: slashCommandLoading,
    closeSlashCommand,
    selectSuggestion: selectSlashCommandSuggestion,
    detectSlashCommand,
  } = useComposerSlashCommand({
    editorRef,
    popoverRef,
    slashCommands,
    slashCommandsLoading,
    onChange: handleDraftChange,
  });

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

  const cannotSend = disabled
    || pendingAttachmentReads > 0
    || (draftText.trim().length === 0 && mentionedFilesRef.current.length === 0 && attachments.length === 0);
  const cannotQueue = cannotSend || !onQueueDraft;
  const composerPlaceholder = isPlan
    ? "Describe what you want to plan..."
    : "Message CodeSymphony... (type / or $ for commands, @ to mention files)";
  const selectedAttachmentPreview = useMemo(
    () => attachments.find((attachment) => attachment.id === attachmentPreviewId) ?? null,
    [attachmentPreviewId, attachments],
  );

  useEffect(() => {
    if (attachmentPreviewId && !selectedAttachmentPreview) {
      setAttachmentPreviewId(null);
    }
  }, [attachmentPreviewId, selectedAttachmentPreview]);

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
    detectMention();
    detectSlashCommand();
  }, [syncValueFromEditor, applyAttachmentsChange, detectMention, detectSlashCommand]);

  const buildFinalContent = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) return draftText;
    return getSerializedTextFromEditor(editor).replace(/\u00A0/g, " ").trim();
  }, [draftText]);

  const clearComposerState = useCallback(() => {
    const editor = editorRef.current;
    if (editor) {
      editor.innerHTML = "";
    }
    mentionedFilesRef.current = [];
    closeMention();
    closeSlashCommand();
    applyAttachmentsChange([]);
    setAttachmentPreviewId(null);
    setDraftText("");
    lastStableHTMLRef.current = "";
    prevContentLenRef.current = 0;
    afterChipHTMLRef.current = null;
  }, [applyAttachmentsChange, closeMention, closeSlashCommand]);
  const resetDraft = useCallback((options?: { clearPersisted?: boolean }) => {
    clearComposerState();
    if (options?.clearPersisted) {
      clearStoredDraft();
    }
  }, [clearComposerState, clearStoredDraft]);

  const buildSubmissionPayload = useCallback((): {
    content: string;
    attachments: PendingAttachment[];
  } | null => {
    const content = buildFinalContent();
    const currentAttachments = attachmentsRef.current;
    if (!content.trim() && currentAttachments.length === 0) {
      return null;
    }

    const editor = editorRef.current;
    const inlineAttachmentIds = new Set<string>();
    if (editor) {
      const chips = editor.querySelectorAll<HTMLElement>("[data-attachment-id]");
      for (const chip of chips) {
        if (chip.dataset.attachmentId) {
          inlineAttachmentIds.add(chip.dataset.attachmentId);
        }
      }
    }

    const allAttachments = [
      ...currentAttachments,
      ...inlineAttachmentIds.size > 0
        ? currentAttachments.filter((attachment) => inlineAttachmentIds.has(attachment.id))
        : [],
    ];

    const seen = new Set<string>();
    const dedupedAttachments = allAttachments.filter((attachment) => {
      if (seen.has(attachment.id)) {
        return false;
      }
      seen.add(attachment.id);
      return true;
    });

    return {
      content,
      attachments: dedupedAttachments,
    };
  }, [buildFinalContent]);

  const handleSubmit = useCallback(async () => {
    if (cannotSend) return;
    if (pendingAttachmentReadsRef.current > 0) return;
    const payload = buildSubmissionPayload();
    if (!payload) return;

    const didSubmit = await onSubmitMessage({ content: payload.content, mode, attachments: payload.attachments });
    if (didSubmit) {
      resetDraft({ clearPersisted: true });
    }
  }, [buildSubmissionPayload, cannotSend, onSubmitMessage, mode, resetDraft]);

  const handleQueueDraft = useCallback(async () => {
    if (cannotQueue || pendingAttachmentReadsRef.current > 0 || !onQueueDraft) {
      return;
    }

    const payload = buildSubmissionPayload();
    if (!payload) {
      return;
    }

    const didQueue = await onQueueDraft({ content: payload.content, mode, attachments: payload.attachments });
    if (didQueue) {
      resetDraft({ clearPersisted: true });
    }
  }, [buildSubmissionPayload, cannotQueue, mode, onQueueDraft, resetDraft]);

  const primaryAction: "send" | "queue" | "stop" =
    sending || stopping
      ? "stop"
      : showStop
        ? (!cannotQueue ? "queue" : "stop")
        : "send";
  const primaryActionDisabled =
    primaryAction === "send"
      ? cannotSend
      : primaryAction === "queue"
        ? (cannotQueue || queueing)
        : stopping;
  const primaryActionLabel =
    primaryAction === "send"
      ? (sending ? "Running..." : "Send message")
      : primaryAction === "queue"
        ? (queueing ? "Queueing..." : "Queue draft")
        : (stopping ? "Stopping..." : "Stop run");
  const handlePrimaryAction = primaryAction === "send"
    ? handleSubmit
    : primaryAction === "queue"
      ? handleQueueDraft
      : onStop;

  useEffect(() => {
    debugLog("thread.workspace.composer", "[DEBUG-new-thread-send] primaryAction.state", {
      threadId,
      worktreeId,
      sending,
      showStop,
      stopping,
      primaryAction,
      primaryActionDisabled,
      primaryActionLabel,
      cannotSend,
      cannotQueue,
      draftLength: draftText.length,
      attachmentCount: attachments.length,
      queuedMessageCount: queuedMessages.length,
      threadRunning,
      disabled,
    }, {
      threadId,
      worktreeId,
    });
  }, [
    attachments.length,
    cannotQueue,
    cannotSend,
    disabled,
    draftText.length,
    primaryAction,
    primaryActionDisabled,
    primaryActionLabel,
    queuedMessages.length,
    sending,
    showStop,
    stopping,
    threadId,
    threadRunning,
    worktreeId,
  ]);

  const handleEditorAttachmentPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-attachment-id]")
      : null;
    if (!target) {
      return;
    }

    event.preventDefault();
  }, []);

  const handleEditorAttachmentClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-attachment-id]")
      : null;
    if (!target?.dataset.attachmentId) {
      return;
    }

    event.preventDefault();
    setAttachmentPreviewId(target.dataset.attachmentId);
  }, []);

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
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId || anchorNode.previousSibling.dataset.slashCommand)
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
             (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.attachmentId ||
             (editor.childNodes[anchorOffset - 1] as HTMLElement).dataset.slashCommand)
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
            (anchorNode.previousSibling.dataset.mentionPath || anchorNode.previousSibling.dataset.attachmentId || anchorNode.previousSibling.dataset.slashCommand)
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
    [mention.active, suggestions, selectedIndex, selectSuggestion, closeMention, slashCommand.active, slashCommandSuggestions, selectedSlashCommandIndex, selectSlashCommandSuggestion, closeSlashCommand, isPlan, modeLocked, onModeChange, showStop, isMobile, handleSubmit, syncValueFromEditor, applyAttachmentsChange],
  );

  useEffect(() => {
    clearComposerState();

    const editor = editorRef.current;
    const storage = getComposerDraftStorage();
    const persistedDraft = storage
      ? readPersistedComposerDraft(storage, draftStorageId)
      : null;

    if (!editor || !persistedDraft) {
      if (storage && draftStorageId && !persistedDraft) {
        clearPersistedComposerDraft(storage, draftStorageId);
      }
      return;
    }

    editor.replaceChildren(buildComposerDraftFragment(persistedDraft));
    moveComposerCaretToEnd(editor);
    syncValueFromEditor();
    prevContentLenRef.current = (editor.textContent ?? "").length;
    lastStableHTMLRef.current = editor.innerHTML;
  }, [clearComposerState, draftStorageId, syncValueFromEditor]);

  const renderModelOptionList = (mobile: boolean) => (
    <div className={cn("max-h-[min(18rem,calc(100vh-10rem))] overflow-y-auto", mobile && "pt-1")}>
      {modelPreviewOptions.map((option, index) => {
        const selected = option.agent === agent
          && option.model === model
          && option.modelProviderId === modelProviderId;
        const showCustomSeparator = isFirstCustomModelOption(modelPreviewOptions, index);

        return (
          <div key={option.id}>
            {showCustomSeparator ? (
              <div
                data-model-separator="custom"
                className="mx-2.5 my-1 border-t border-border/60"
              />
            ) : null}
            <button
              type="button"
              disabled={selectionLocked}
              title={option.model}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                selected
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              } disabled:cursor-not-allowed disabled:opacity-60`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (selectionLocked) {
                    return;
                  }
                onAgentSelectionChange({
                  agent: option.agent,
                    model: option.model,
                    modelProviderId: option.modelProviderId,
                  });
                  if (mobile) {
                    setMobileSessionSheetOpen(false);
                  }
                }}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
              {option.source === "custom" || !mobile ? (
                <span className="max-w-[7rem] truncate text-[10px] text-muted-foreground">
                  {option.detail}
                </span>
              ) : null}
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          </div>
        );
      })}
    </div>
  );

  const renderModelOptions = (mobile: boolean) => (
    <>
      {showAgentList ? (
        <div className="space-y-1" data-cli-agent-list="true">
          {(Object.keys(AGENT_LABELS) as CliAgent[]).map((entryAgent) => {
            const selectedAgent = modelPreviewAgent === entryAgent;
            const currentAgent = agent === entryAgent;

            return (
              <button
                key={entryAgent}
                type="button"
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                  selectedAgent
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50"
                }`}
                aria-current={currentAgent ? "true" : undefined}
                onMouseEnter={() => {
                  if (!mobile) {
                    setModelPreviewAgent(entryAgent);
                  }
                }}
                onMouseOver={() => {
                  if (!mobile) {
                    setModelPreviewAgent(entryAgent);
                  }
                }}
                onFocus={() => setModelPreviewAgent(entryAgent)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setModelPreviewAgent(entryAgent);
                }}
              >
                <AgentIcon agent={entryAgent} aria-hidden="true" className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{AGENT_LABELS[entryAgent]}</span>
                {currentAgent ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {mobile ? (
        <div
          data-agent-model-panel="stacked"
          className={cn(
            showAgentList ? "mt-1 border-t border-border/60 pt-1" : "pt-1",
            selectionBlockedReason ? "space-y-2" : "",
          )}
        >
          {selectionBlockedReason ? (
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
              {selectionBlockedReason}
            </p>
          ) : null}
          {renderModelOptionList(true)}
        </div>
      ) : null}
    </>
  );

  const renderPermissionOptions = (mobile: boolean) => (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-popover p-1 shadow-lg",
        mobile ? "w-full" : "w-[220px]",
      )}
      onMouseLeave={() => setPermissionPreviewMode(null)}
    >
      <div className="max-h-48 overflow-y-auto">
        {PERMISSION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              permissionMode === option.value
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50"
            }`}
            aria-label={`${option.label}. ${option.description}`}
            aria-current={permissionMode === option.value ? "true" : undefined}
            onMouseEnter={() => setPermissionPreviewMode(option.value)}
            onFocus={() => setPermissionPreviewMode(option.value)}
            onBlur={() => setPermissionPreviewMode((current) => (current === option.value ? null : current))}
            onMouseDown={(e) => {
              e.preventDefault();
              onPermissionModeChange(option.value);
              setPermissionPreviewMode(null);
              setPermissionPopoverOpen(false);
              if (mobile) {
                setMobileSessionSheetOpen(false);
              }
            }}
          >
            <option.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{option.label}</span>
              {mobile ? (
                <span className="mt-0.5 block whitespace-normal text-[10px] leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            {permissionMode === option.value ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <section className="pb-1 pt-0.5 safe-bottom lg:pb-2 lg:pt-1">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`relative border bg-background/35 px-3 pb-11 pt-2.5 shadow-sm backdrop-blur-sm lg:px-4 lg:pb-12 lg:pt-3 transition-colors ${
            attachedTop ? "rounded-b-2xl rounded-t-none lg:rounded-b-3xl lg:rounded-t-none" : "rounded-2xl lg:rounded-3xl"
          } ${
            isDragOver ? "border-primary/60 bg-primary/5" : "border-input/50"
          }`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className={`absolute inset-0 z-10 flex items-center justify-center bg-primary/10 ${attachedTop ? "rounded-b-2xl rounded-t-none lg:rounded-b-3xl" : "rounded-2xl lg:rounded-3xl"}`}>
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

          {canRenderQueuedMessages ? (
            <QueuedMessageList
              embedded
              messages={queuedMessages}
              disabled={disabled}
              onDelete={queuedMessageHandlers.onDelete}
              onDispatch={queuedMessageHandlers.onDispatch}
              onUpdate={queuedMessageHandlers.onUpdate}
            />
          ) : null}

          {mention.active && (suggestions.length > 0 || mentionFileIndexLoading) && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 z-50 mb-2 w-full max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {mentionFileIndexLoading && suggestions.length === 0 ? (
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

          {slashCommand.active && (slashCommandSuggestions.length > 0 || slashCommandLoading) && (
            <div
              ref={popoverRef}
              className="absolute bottom-full left-0 z-50 mb-2 w-full max-h-60 overflow-y-auto rounded-xl border border-border/60 bg-popover shadow-lg"
            >
              {slashCommandLoading && slashCommandSuggestions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading commands...</div>
              ) : (
                slashCommandSuggestions.map((entry, index) => (
                  <button
                    key={entry.name}
                    type="button"
                    data-index={index}
                    className={`flex w-full items-start px-3 py-2 text-left text-sm transition-colors ${
                      index === selectedSlashCommandIndex
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-accent/50"
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault();
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
            aria-placeholder={composerPlaceholder}
            contentEditable={!disabled}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onPointerDownCapture={handleEditorAttachmentPointerDown}
            onClick={handleEditorAttachmentClick}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              handleInput();
            }}
            data-placeholder={composerPlaceholder}
            className={`min-h-[60px] max-h-[140px] w-full overflow-y-auto resize-none border-none bg-transparent p-0 text-sm text-foreground shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0 empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none md:min-h-[74px] md:max-h-[400px] ${
              disabled ? "cursor-not-allowed opacity-50" : ""
            }`}
          />

          <div className="absolute bottom-2 left-2.5 right-12 flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:bottom-3 lg:left-3 lg:right-auto lg:overflow-visible">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex items-center justify-center rounded-full bg-secondary/60 p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground disabled:opacity-50"
              aria-label="Attach files"
            >
              <Plus className="h-3.5 w-3.5" />
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
            {isMobile ? (
              <Dialog open={mobileSessionSheetOpen} onOpenChange={setMobileSessionSheetOpen}>
                <button
                  type="button"
                  onClick={() => {
                    if (disabled) {
                      return;
                    }
                    setModelPreviewAgent(agent);
                    setMobileSessionSheetOpen(true);
                  }}
                  disabled={disabled}
                  title={selectionBlockedReason ?? undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium transition-colors",
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-secondary/70 hover:text-foreground",
                    permissionMode === "full_access" ? "text-orange-500" : "text-muted-foreground",
                  )}
                  aria-label="Open session settings"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                  <AgentIcon agent={agent} aria-hidden="true" className="h-3.5 w-3.5" />
                  <span className="max-w-[96px] truncate">{mobileSessionSummaryLabel}</span>
                  {permissionMode === "full_access" ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
                <DialogContent className="bottom-0 left-0 top-auto grid w-full max-w-none translate-x-0 translate-y-0 gap-3 rounded-b-none rounded-t-3xl border-border/70 bg-card/98 px-4 pb-4 pt-5 shadow-2xl md:bottom-auto md:left-[50%] md:top-[50%] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl">
                  <DialogTitle className="text-base">Session settings</DialogTitle>
                  <DialogDescription className="text-xs">
                    Choose agent, model, and permission mode for this thread.
                  </DialogDescription>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Agent and model
                      </div>
                      <div className="rounded-2xl border border-border/60 bg-background/40 p-1">
                        {renderModelOptions(true)}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Permission mode
                      </div>
                      {renderPermissionOptions(true)}
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            ) : (
              <>
                <AgentModelSelector
                  selection={{ agent, model, modelProviderId }}
                  providers={providers}
                  codexModels={codexModels}
                  cursorModels={cursorModels}
                  opencodeModels={opencodeModels}
                  codexBuiltinModelOverride={codexBuiltinModelOverride}
                  showAgentList={showAgentList}
                  selectionLockedReason={selectionBlockedReason}
                  onSelectionChange={(nextSelection) => {
                    onAgentSelectionChange(nextSelection);
                  }}
                />

                <div className="relative" ref={permissionPopoverRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setPermissionPopoverOpen((open) => {
                        const nextOpen = !open;
                        if (!nextOpen) {
                          setPermissionPreviewMode(null);
                        }
                        return nextOpen;
                      });
                    }}
                    disabled={disabled}
                    className={`flex items-center gap-1.5 rounded-full bg-secondary/40 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary/70 disabled:cursor-not-allowed disabled:opacity-50 ${permissionTriggerClassName} ${
                      permissionMode === "full_access" ? "hover:text-orange-400" : "hover:text-foreground"
                    }`}
                    aria-label="Select permission mode"
                  >
                    <activePermissionOption.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[160px] truncate">{activePermissionOption.label}</span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </button>

                  {permissionPopoverOpen && (
                    <div className="absolute bottom-full left-0 z-50 mb-1.5">
                      <div className="relative">
                        {renderPermissionOptions(false)}
                        {previewPermissionOption ? (
                          <div className="absolute left-full top-0 ml-2 w-[220px] rounded-lg border border-border/60 bg-popover/95 p-3 shadow-lg">
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              {previewPermissionOption.description}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="absolute bottom-2 right-2.5 flex items-center gap-2 lg:bottom-3 lg:right-3">
            <Button
              type="button"
              onClick={handlePrimaryAction}
              disabled={primaryActionDisabled}
              size="icon"
              aria-label={primaryActionLabel}
              className="h-8 w-8 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white/80 disabled:text-black/70"
            >
              {primaryAction === "send" || primaryAction === "queue"
                ? <ArrowUp className="h-3.5 w-3.5" />
                : <Square className="h-3.5 w-3.5" fill="currentColor" />}
              <span className="sr-only">{primaryActionLabel}</span>
            </Button>
          </div>
        </div>
      </div>
      <AttachmentPreviewDialog
        attachment={selectedAttachmentPreview}
        open={selectedAttachmentPreview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAttachmentPreviewId(null);
          }
        }}
      />
    </section>
  );
}

export function Composer(props: ComposerProps) {
  return <ComposerContent {...props} />;
}
