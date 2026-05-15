import type { ReactNode } from "react";
import { memo, useState, useCallback, useMemo } from "react";
import type { ChatAttachment } from "@codesymphony/shared-types";
import { Check, Copy, FileText, Paperclip } from "lucide-react";
import { getAttachmentDisplayLabel } from "../../../lib/attachments";
import { Popover, PopoverTrigger, PopoverContent } from "../../ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../ui/dialog";
import { ZoomableImage } from "../ZoomableImage";
import { formatFileSize } from "./toolEventUtils";

function getImageSource(attachment: AttachmentPreviewAttachment): string | null {
  if (!attachment.mimeType.startsWith("image/") || attachment.content.length === 0) {
    return null;
  }

  if (attachment.content.startsWith("data:")) {
    return attachment.content;
  }

  if (attachment.mimeType === "image/svg+xml" && attachment.content.trimStart().startsWith("<svg")) {
    return `data:${attachment.mimeType};utf8,${encodeURIComponent(attachment.content)}`;
  }

  return `data:${attachment.mimeType};base64,${attachment.content}`;
}

const ImageAttachmentDialog = memo(function ImageAttachmentDialog({ attachment, children }: {
  attachment: ChatAttachment;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const imageSource = useMemo(() => getImageSource(attachment), [attachment]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="h-[100dvh] w-[100vw] max-w-none gap-0 border-none bg-black/95 p-0 shadow-none sm:rounded-none">
        <DialogTitle className="sr-only">{attachment.filename}</DialogTitle>
        <DialogDescription className="sr-only">
          Zoomable preview for {attachment.filename}
        </DialogDescription>
        {imageSource ? <ZoomableImage src={imageSource} alt={attachment.filename} /> : null}
      </DialogContent>
    </Dialog>
  );
});

type AttachmentPreviewAttachment = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: string;
  source: ChatAttachment["source"];
  storagePath?: string | null;
};

export const AttachmentPreviewPanel = memo(function AttachmentPreviewPanel({
  attachment,
}: {
  attachment: AttachmentPreviewAttachment;
}) {
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
    <div className="w-80 max-w-[90vw] overflow-hidden rounded-lg border border-border/30 bg-popover">
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
    </div>
  );
});

const AttachmentPopoverContent = memo(function AttachmentPopoverContent({ attachment }: { attachment: ChatAttachment }) {
  return (
    <PopoverContent
      side="top"
      align="start"
      className="w-auto border-none bg-transparent p-0 shadow-none"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <AttachmentPreviewPanel attachment={attachment} />
    </PopoverContent>
  );
});

export const AttachmentBlock = memo(function AttachmentBlock({ attachment }: { attachment: ChatAttachment }) {
  const isImage = attachment.mimeType.startsWith("image/");
  const imageSource = useMemo(() => getImageSource(attachment), [attachment]);
  const button = (
    <button
      type="button"
      className={isImage
        ? "flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-secondary/40"
        : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-secondary/40"}
    >
      {isImage ? imageSource ? (
        <img
          src={imageSource}
          alt={attachment.filename}
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-secondary/60">
          <Paperclip className="h-3.5 w-3.5 text-purple-400" />
        </div>
      ) : (
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{attachment.filename}</span>
        {isImage ? (
          <span className="block text-[10px] text-muted-foreground">
            {formatFileSize(attachment.sizeBytes)}
          </span>
        ) : null}
      </span>
      {!isImage ? (
        <span className="shrink-0 rounded bg-secondary/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {formatFileSize(attachment.sizeBytes)}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border/30 bg-secondary/20">
      {isImage ? (
        <ImageAttachmentDialog attachment={attachment}>
          {button}
        </ImageAttachmentDialog>
      ) : (
        <Popover>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
          <AttachmentPopoverContent attachment={attachment} />
        </Popover>
      )}
    </div>
  );
});

export const InlineAttachmentChip = memo(function InlineAttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  const label = getAttachmentDisplayLabel(attachment);
  const isImage = attachment.mimeType.startsWith("image/");
  const chip = (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md border border-purple-500/30 bg-purple-500/15 px-1.5 py-0 text-xs text-purple-400 cursor-pointer select-none hover:bg-purple-500/25"
      title={`${attachment.filename} (${formatFileSize(attachment.sizeBytes)})`}
    >
      <Paperclip className="h-3 w-3 shrink-0 inline-block" />
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );

  return (
    <span className="inline-flex align-baseline mx-0.5">
      {isImage ? (
        <ImageAttachmentDialog attachment={attachment}>
          {chip}
        </ImageAttachmentDialog>
      ) : (
        <Popover>
          <PopoverTrigger asChild>{chip}</PopoverTrigger>
          <AttachmentPopoverContent attachment={attachment} />
        </Popover>
      )}
    </span>
  );
});
