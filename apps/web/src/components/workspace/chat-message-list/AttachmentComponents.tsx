import { memo, useState, useCallback } from "react";
import type { ChatAttachment } from "@codesymphony/shared-types";
import { Check, Copy, FileText, Paperclip } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../../ui/popover";
import { formatFileSize } from "./toolEventUtils";

export const AttachmentPopoverContent = memo(function AttachmentPopoverContent({ attachment }: { attachment: ChatAttachment }) {
  const [copied, setCopied] = useState(false);
  const isImage = attachment.mimeType.startsWith("image/");
  const hasContent = attachment.content.length > 0;

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(attachment.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [attachment.content]);

  return (
    <PopoverContent
      side="top"
      align="start"
      className="w-80 max-w-[90vw] p-0"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
        <Paperclip className="h-3 w-3 shrink-0 text-purple-400" />
        <span className="truncate text-xs font-medium">{attachment.filename}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {formatFileSize(attachment.sizeBytes)}
        </span>
      </div>
      <div className="bg-secondary/20">
        {isImage ? (
          <p className="px-3 py-4 text-xs italic text-muted-foreground text-center">
            Image file{attachment.storagePath ? ` saved at ${attachment.storagePath}` : ""}
          </p>
        ) : hasContent ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
            {attachment.content.length > 2000 ? `${attachment.content.slice(0, 2000)}…` : attachment.content}
          </pre>
        ) : (
          <p className="px-3 py-4 text-xs italic text-muted-foreground text-center">No content preview available</p>
        )}
      </div>
      {hasContent && !isImage && (
        <div className="flex justify-end border-t border-border/30 px-2 py-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </PopoverContent>
  );
});

export const AttachmentBlock = memo(function AttachmentBlock({ attachment }: { attachment: ChatAttachment }) {
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <div className="overflow-hidden rounded-lg border border-border/30 bg-secondary/20">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40"
          >
            {isImage ? (
              <Paperclip className="h-3 w-3 shrink-0 text-purple-400" />
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate font-medium">{attachment.filename}</span>
            <span className="shrink-0 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {formatFileSize(attachment.sizeBytes)}
            </span>
          </button>
        </PopoverTrigger>
        <AttachmentPopoverContent attachment={attachment} />
      </Popover>
    </div>
  );
});

export const InlineAttachmentChip = memo(function InlineAttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  return (
    <span className="inline-flex align-baseline mx-0.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-1.5 py-0 text-xs text-purple-400 cursor-pointer select-none hover:bg-purple-500/25"
            title={`${attachment.filename} (${formatFileSize(attachment.sizeBytes)})`}
          >
            <Paperclip className="h-3 w-3 shrink-0 inline-block" />
            <span className="max-w-[140px] truncate">{attachment.filename}</span>
          </button>
        </PopoverTrigger>
        <AttachmentPopoverContent attachment={attachment} />
      </Popover>
    </span>
  );
});
