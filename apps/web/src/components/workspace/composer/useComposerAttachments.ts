import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingAttachment } from "../../../lib/attachments";
import {
  fileToAttachment,
  isImageMimeType,
  localAttachmentToPendingAttachment,
  validateAttachmentSize,
} from "../../../lib/attachments";
import { api } from "../../../lib/api";
import { isTauriDesktop } from "../../../lib/openExternalUrl";

const DESKTOP_DOM_DROP_FALLBACK_DELAY_MS = 150;
const DESKTOP_NATIVE_DROP_SUPPRESSION_MS = 500;

export function useComposerAttachments({
  editorRef,
}: {
  editorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [pendingAttachmentReads, setPendingAttachmentReads] = useState(0);
  const pendingAttachmentReadsRef = useRef(0);
  const nativeDesktopDropListenerReadyRef = useRef(false);
  const lastNativeDesktopDropAtRef = useRef<number | null>(null);

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
  const dragDepthRef = useRef(0);

  const hasDraggedFiles = useCallback((dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) {
      return false;
    }

    const types = Array.from(dataTransfer.types ?? []);
    if (types.includes("Files")) {
      return true;
    }

    return Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file");
  }, []);

  const extractDraggedFiles = useCallback((dataTransfer: DataTransfer | null): File[] => {
    if (!dataTransfer) {
      return [];
    }

    const filesFromItems = Array.from(dataTransfer.items ?? [])
      .map((item) => item.getAsFile())
      .filter((file): file is File => file instanceof File);
    if (filesFromItems.length > 0) {
      return filesFromItems;
    }

    return Array.from(dataTransfer.files ?? []);
  }, []);

  const appendBrowserFiles = useCallback(
    async (files: FileList | File[], source: PendingAttachment["source"]) => {
      const newAttachments: PendingAttachment[] = [];
      for (const file of Array.from(files)) {
        const sizeError = validateAttachmentSize(file);
        if (sizeError) continue;
        const attachment = await fileToAttachment(file, source);
        newAttachments.push(attachment);
      }
      if (newAttachments.length > 0) {
        applyAttachmentsChange((prev) => [...prev, ...newAttachments]);
      }
    },
    [applyAttachmentsChange],
  );

  const appendLocalFiles = useCallback(
    async (paths: string[]) => {
      const nextAttachments = await api.readLocalAttachments(paths);
      if (nextAttachments.length === 0) {
        return;
      }

      applyAttachmentsChange((prev) => [
        ...prev,
        ...nextAttachments.map((attachment) =>
          localAttachmentToPendingAttachment(attachment, "drag_drop")),
      ]);
    },
    [applyAttachmentsChange],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      startAttachmentRead();
      void (async () => {
        try {
          await appendBrowserFiles(files, "file_picker");
        } finally {
          finishAttachmentRead();
        }
      })();

      event.target.value = "";
    },
    [appendBrowserFiles, startAttachmentRead, finishAttachmentRead],
  );

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, [hasDraggedFiles]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, [hasDraggedFiles]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  }, [hasDraggedFiles]);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasDraggedFiles(event.dataTransfer)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOver(false);

      const files = extractDraggedFiles(event.dataTransfer);
      if (files.length === 0) return;

      if (isTauriDesktop() && nativeDesktopDropListenerReadyRef.current) {
        window.setTimeout(() => {
          const lastNativeDropAt = lastNativeDesktopDropAtRef.current;
          if (lastNativeDropAt !== null && Date.now() - lastNativeDropAt < DESKTOP_NATIVE_DROP_SUPPRESSION_MS) {
            return;
          }

          startAttachmentRead();
          void (async () => {
            try {
              await appendBrowserFiles(files, "drag_drop");
            } finally {
              finishAttachmentRead();
            }
          })();
        }, DESKTOP_DOM_DROP_FALLBACK_DELAY_MS);
        return;
      }

      startAttachmentRead();
      void (async () => {
        try {
          await appendBrowserFiles(files, "drag_drop");
        } finally {
          finishAttachmentRead();
        }
      })();
    },
    [appendBrowserFiles, extractDraggedFiles, finishAttachmentRead, hasDraggedFiles, startAttachmentRead],
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
          await appendBrowserFiles(imageFiles, "clipboard_image");
        } finally {
          finishAttachmentRead();
        }
      })();
      return true;
    },
    [appendBrowserFiles, startAttachmentRead, finishAttachmentRead],
  );

  useEffect(() => {
    if (!isTauriDesktop()) {
      return;
    }

    let active = true;
    let unlisten: null | (() => void) = null;

    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        if (!active) {
          return;
        }

        nativeDesktopDropListenerReadyRef.current = true;
        unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          const payload = event.payload as { type: string; paths?: string[] };

          if (payload.type === "over") {
            setIsDragOver(true);
            return;
          }

          dragDepthRef.current = 0;
          setIsDragOver(false);

          if (payload.type !== "drop") {
            return;
          }

          const paths = Array.isArray(payload.paths) ? payload.paths : [];
          if (paths.length === 0) {
            return;
          }

          lastNativeDesktopDropAtRef.current = Date.now();
          startAttachmentRead();
          void (async () => {
            try {
              await appendLocalFiles(paths);
            } finally {
              finishAttachmentRead();
            }
          })();
        });
      } catch {
        nativeDesktopDropListenerReadyRef.current = false;
        // Ignore native desktop drag/drop wiring failures and fall back to the DOM path.
      }
    })();

    return () => {
      active = false;
      nativeDesktopDropListenerReadyRef.current = false;
      lastNativeDesktopDropAtRef.current = null;
      unlisten?.();
    };
  }, [appendLocalFiles, finishAttachmentRead, startAttachmentRead]);

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
    handleDragEnter,
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
