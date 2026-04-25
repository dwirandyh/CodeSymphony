import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Paperclip, Pencil, Trash2, X } from "lucide-react";
import type { ChatQueuedMessage } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type QueuedMessageListProps = {
  messages: ChatQueuedMessage[];
  disabled?: boolean;
  onDelete: (queueMessageId: string) => void;
  onDispatch: (queueMessageId: string) => void;
  onUpdate: (queueMessageId: string, content: string) => Promise<boolean>;
};

type QueuedMessageItemProps = {
  message: ChatQueuedMessage;
  disabled: boolean;
  onDelete: (queueMessageId: string) => void;
  onDispatch: (queueMessageId: string) => void;
  onUpdate: (queueMessageId: string, content: string) => Promise<boolean>;
};

function formatAttachmentSummary(message: ChatQueuedMessage): string | null {
  const count = message.attachments.length;
  if (count === 0) {
    return null;
  }

  return count === 1 ? "1 attachment" : `${count} attachments`;
}

function getStatusLabel(message: ChatQueuedMessage): string {
  if (message.status === "dispatching") {
    return "Dispatching";
  }
  if (message.status === "dispatch_requested") {
    return "Send next";
  }
  return "Queued";
}

function QueuedMessageItem({
  message,
  disabled,
  onDelete,
  onDispatch,
  onUpdate,
}: QueuedMessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentSummary = formatAttachmentSummary(message);
  const statusLabel = getStatusLabel(message);
  const placeholder = message.attachments.length > 0 ? "Attachment only draft" : "Write queued message";
  const normalizedCurrentContent = message.content.trim();
  const normalizedDraftContent = draftContent.trim();
  const editingDisabled = disabled || saving || message.status === "dispatching";
  const canSave = !editingDisabled
    && normalizedDraftContent !== normalizedCurrentContent
    && (normalizedDraftContent.length > 0 || message.attachments.length > 0);

  useEffect(() => {
    if (!isEditing) {
      setDraftContent(message.content);
    }
  }, [isEditing, message.content]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [isEditing]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draftContent, isEditing]);

  async function handleSave() {
    if (!canSave) {
      return;
    }

    setSaving(true);
    const didUpdate = await onUpdate(message.id, normalizedDraftContent);
    setSaving(false);
    if (didUpdate) {
      setIsEditing(false);
    }
  }

  function handleCancel() {
    setDraftContent(message.content);
    setIsEditing(false);
    setSaving(false);
  }

  return (
    <div className="rounded-[20px] border border-border/55 bg-background/65 px-3 py-2.5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <textarea
              ref={textareaRef}
              value={draftContent}
              rows={1}
              disabled={editingDisabled}
              placeholder={placeholder}
              className="min-h-[2.25rem] w-full resize-none overflow-hidden rounded-xl border border-border/60 bg-background px-3 py-2 text-[15px] leading-6 text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSave();
                  return;
                }

                if (event.key === "Escape") {
                  event.preventDefault();
                  handleCancel();
                }
              }}
            />
          ) : (
            <p className="whitespace-pre-wrap break-words px-1 py-1 text-[15px] leading-6 text-foreground">
              {message.content || placeholder}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-secondary/80 px-2 py-0.5 font-medium text-foreground/80">
              {message.mode === "plan" ? "Plan" : "Execute"}
            </span>
            {attachmentSummary ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary/40 px-2 py-0.5">
                <Paperclip className="h-3 w-3" />
                {attachmentSummary}
              </span>
            ) : null}
            <span className={cn(
              "rounded-full px-2 py-0.5 font-medium",
              message.status === "dispatching"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : message.status === "dispatch_requested"
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "bg-secondary/40 text-muted-foreground",
            )}
            >
              {statusLabel}
            </span>
            {isEditing ? (
              <span className="text-[10px] text-muted-foreground/80">Ctrl/Cmd+Enter to save</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {isEditing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-emerald-600 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
                disabled={!canSave}
                onClick={() => {
                  void handleSave();
                }}
                aria-label="Save queued draft"
                title="Save queued draft"
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                disabled={saving}
                onClick={handleCancel}
                aria-label="Cancel editing queued draft"
                title="Cancel editing queued draft"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                disabled={editingDisabled}
                onClick={() => setIsEditing(true)}
                aria-label="Edit queued draft"
                title="Edit queued draft"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                disabled={editingDisabled}
                onClick={() => onDispatch(message.id)}
                aria-label="Send queued draft now"
                title="Send queued draft now"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-destructive"
                disabled={editingDisabled}
                onClick={() => onDelete(message.id)}
                aria-label="Delete queued draft"
                title="Delete queued draft"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function QueuedMessageList({
  messages,
  disabled = false,
  onDelete,
  onDispatch,
  onUpdate,
}: QueuedMessageListProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (messages.length === 0) {
    return null;
  }

  return (
    <section className="pb-2 pt-1.5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="overflow-hidden rounded-[28px] border border-border/60 bg-card/80 shadow-sm backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3 px-4 py-3 lg:px-5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[15px] font-semibold text-foreground">
                {messages.length} Queued
              </span>
              <span className="truncate text-[15px] text-muted-foreground">to send</span>
            </div>
            <button
              type="button"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
              onClick={() => setCollapsed((current) => !current)}
              aria-label={collapsed ? "Expand queued drafts" : "Collapse queued drafts"}
              title={collapsed ? "Expand queued drafts" : "Collapse queued drafts"}
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform", collapsed && "-rotate-90")} />
            </button>
          </div>

          {!collapsed ? (
            <div className="space-y-2 border-t border-border/50 px-2.5 py-2.5 lg:px-3 lg:py-3">
              {messages.map((message) => (
                <QueuedMessageItem
                  key={message.id}
                  message={message}
                  disabled={disabled}
                  onDelete={onDelete}
                  onDispatch={onDispatch}
                  onUpdate={onUpdate}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
