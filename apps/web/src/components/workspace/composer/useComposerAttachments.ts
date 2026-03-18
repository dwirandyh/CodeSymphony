import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "../../../lib/attachments";
import {
  fileToAttachment,
  isImageMimeType,
  validateAttachmentSize,
} from "../../../lib/attachments";

export function useComposerAttachments({
  editorRef,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
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
      setAttachments((current) => {
        const resolved = typeof next === "function"
          ? next(current)
          : next;
        attachmentsRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

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
      const editor = editorRef.current;
      if (editor) {
        const chip = editor.querySelector(`[data-attachment-id="${id}"]`);
        if (chip) chip.remove();
      }
      applyAttachmentsChange((prev) => prev.filter((a) => a.id !== id));
    },
    [applyAttachmentsChange],
  );

  const handlePasteImages = useCallback(
    (clipboardData: DataTransfer): boolean => {
      const imageFiles = Array.from(clipboardData.files).filter((f) =>
        isImageMimeType(f.type),
      );
      if (imageFiles.length === 0) return false;

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
      return true;
    },
    [applyAttachmentsChange, startAttachmentRead, finishAttachmentRead],
  );

  const barAttachments = attachments.filter((a) => !a.isInline);

  return {
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
    startAttachmentRead,
    finishAttachmentRead,
  };
}
