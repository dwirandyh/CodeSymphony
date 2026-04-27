import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Pencil, Trash2, X } from "lucide-react";
import type { ChatQueuedMessage } from "@codesymphony/shared-types";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

type QueuedMessageListProps = {
  messages: ChatQueuedMessage[];
  disabled?: boolean;
  embedded?: boolean;
  onDelete: (queueMessageId: string) => void;
  onDispatch: (queueMessageId: string) => void;
  onUpdate: (queueMessageId: string, content: string) => Promise<boolean>;
};

type QueuedMessageItemProps = {
  message: ChatQueuedMessage;
  disabled: boolean;
  embedded: boolean;
  onDelete: (queueMessageId: string) => void;
  onDispatch: (queueMessageId: string) => void;
  onUpdate: (queueMessageId: string, content: string) => Promise<boolean>;
};

const QUEUED_MESSAGE_PREVIEW_STYLE: CSSProperties = {
  display: "-webkit-box",
  overflow: "hidden",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

function QueuedMessageItem({
  message,
  disabled,
  embedded,
  onDelete,
  onDispatch,
  onUpdate,
}: QueuedMessageItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    <div
      className={cn(
        "group flex items-start gap-2.5",
        embedded
          ? "py-2 first:pt-0 last:pb-0"
          : "rounded-2xl border border-border/45 bg-background/55 px-3 py-2.5 shadow-sm",
      )}
    >
      <div className="min-w-0 flex-1">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={draftContent}
            rows={1}
            disabled={editingDisabled}
            placeholder={placeholder}
            className={cn(
              "w-full resize-none overflow-hidden rounded-xl border border-border/50 px-3 py-2 text-[13px] leading-5 text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
              embedded ? "min-h-8 bg-background/70" : "min-h-9 bg-background",
            )}
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
          <p
            title={message.content || placeholder}
            style={message.content ? QUEUED_MESSAGE_PREVIEW_STYLE : undefined}
            className={cn(
              "break-words text-[13px] leading-5 text-foreground",
              !message.content && "italic text-muted-foreground",
            )}
          >
            {message.content || placeholder}
          </p>
        )}

        {isEditing ? (
          <div className="mt-1 text-[10px] text-muted-foreground/80">Cmd/Ctrl+Enter</div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {isEditing ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-300 dark:hover:text-emerald-200"
              disabled={!canSave}
              onClick={() => {
                void handleSave();
              }}
              aria-label="Save queued draft"
              title="Save queued draft"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              disabled={saving}
              onClick={handleCancel}
              aria-label="Cancel editing queued draft"
              title="Cancel editing queued draft"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-muted-foreground/80 hover:bg-secondary/60 hover:text-foreground"
              disabled={editingDisabled}
              onClick={() => setIsEditing(true)}
              aria-label="Edit queued draft"
              title="Edit queued draft"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-muted-foreground/80 hover:bg-secondary/60 hover:text-foreground"
              disabled={editingDisabled}
              onClick={() => onDispatch(message.id)}
              aria-label="Send queued draft now"
              title="Send queued draft now"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full text-muted-foreground/80 hover:bg-destructive/10 hover:text-destructive"
              disabled={editingDisabled}
              onClick={() => onDelete(message.id)}
              aria-label="Delete queued draft"
              title="Delete queued draft"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function QueuedMessageList({
  messages,
  disabled = false,
  embedded = false,
  onDelete,
  onDispatch,
  onUpdate,
}: QueuedMessageListProps) {
  const [collapsed, setCollapsed] = useState(false);

  if (messages.length === 0) {
    return null;
  }

  const queuedLabel = messages.length === 1 ? "1 queued draft" : `${messages.length} queued drafts`;
  const content = !collapsed ? (
    <div className={cn("mt-2.5", embedded ? "divide-y divide-border/35" : "space-y-2")}>
      {messages.map((message) => (
        <QueuedMessageItem
          key={message.id}
          message={message}
          disabled={disabled}
          embedded={embedded}
          onDelete={onDelete}
          onDispatch={onDispatch}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  ) : null;

  const body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[13px] font-medium text-foreground">{queuedLabel}</p>
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
          onClick={() => setCollapsed((current) => !current)}
          aria-label={collapsed ? "Expand queued drafts" : "Collapse queued drafts"}
          title={collapsed ? "Expand queued drafts" : "Collapse queued drafts"}
        >
          <span>{collapsed ? "Show" : "Hide"}</span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>
      {content}
    </>
  );

  if (embedded) {
    return <div className="mb-3 border-b border-border/40 pb-3">{body}</div>;
  }

  return (
    <section className="pb-2 pt-1.5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-[28px] border border-border/60 bg-card/80 px-3 py-3 shadow-sm backdrop-blur-sm">
          {body}
        </div>
      </div>
    </section>
  );
}
