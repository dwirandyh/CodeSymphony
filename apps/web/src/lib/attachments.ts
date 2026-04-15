export type PendingAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  content: string; // raw text or base64
  sizeBytes: number;
  source: "file_picker" | "drag_drop" | "clipboard_text" | "clipboard_image";
  previewUrl?: string; // Object URL for image preview
  isInline: boolean; // true = inline chip in editor, false = chip above input
};

const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

type PendingAttachmentSource = PendingAttachment["source"];

type PendingAttachmentDraft = {
  filename: string;
  mimeType: string;
  content: string;
  sizeBytes: number;
  source: PendingAttachmentSource;
  previewUrl?: string;
};

type LocalFilesystemAttachment = {
  filename: string;
  mimeType: string;
  content: string;
  sizeBytes: number;
};

let clipboardCounter = 0;

/** Generate a unique ID, with fallback for non-secure contexts (HTTP) where crypto.randomUUID is unavailable. */
export function generateAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback using crypto.getRandomValues (available in all contexts)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resetClipboardCounter(): void {
  clipboardCounter = 0;
}

export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function validateAttachmentSize(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return `File "${file.name}" exceeds 10 MB limit (${Math.round(file.size / 1024 / 1024)}MB)`;
  }
  return null;
}

function createPendingAttachment(input: PendingAttachmentDraft): PendingAttachment {
  return {
    id: generateAttachmentId(),
    filename: input.filename,
    mimeType: input.mimeType || "application/octet-stream",
    content: input.content,
    sizeBytes: input.sizeBytes,
    source: input.source,
    previewUrl: input.previewUrl,
    isInline: false,
  };
}

export function localAttachmentToPendingAttachment(
  attachment: LocalFilesystemAttachment,
  source: PendingAttachmentSource,
): PendingAttachment {
  const mimeType = attachment.mimeType || "application/octet-stream";
  const previewUrl = isImageMimeType(mimeType)
    ? `data:${mimeType};base64,${attachment.content}`
    : undefined;

  return createPendingAttachment({
    filename: attachment.filename,
    mimeType,
    content: attachment.content,
    sizeBytes: attachment.sizeBytes,
    source,
    previewUrl,
  });
}

export async function fileToAttachment(
  file: File,
  source: PendingAttachmentSource,
): Promise<PendingAttachment> {
  const isImage = isImageMimeType(file.type);

  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (isImage) {
        // Strip data URL prefix to get pure base64
        const result = reader.result as string;
        const base64 = result.split(",")[1] ?? "";
        resolve(base64);
      } else {
        resolve(reader.result as string);
      }
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });

  const previewUrl = isImage ? URL.createObjectURL(file) : undefined;

  return createPendingAttachment({
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    content,
    sizeBytes: file.size,
    source,
    previewUrl,
  });
}

export function detectClipboardTextLanguage(text: string): string {
  const trimmed = text.trim();

  // JSON — parseable JSON object or array
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON
    }
  }

  // HTML — requires doctype or <html>/<head>/<body> tags
  if (/<!DOCTYPE\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) return "html";

  // SQL — statement keywords at line start (very specific)
  if (/^(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s/im.test(trimmed)) return "sql";

  // CSS — selector { property: value; } pattern
  if (/[.#]?[a-zA-Z][\w-]*\s*\{[^}]*:[^}]*\}/s.test(trimmed)) return "css";

  // Shell — shebang only (very reliable)
  if (new RegExp("^#!/", "m").test(trimmed)) return "sh";

  // Everything else → txt (avoid false positives between similar languages)
  return "txt";
}

export function generateClipboardFilename(text: string): string {
  void text;
  clipboardCounter++;
  return `pasted-${clipboardCounter}`;
}

export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 1;
  }

  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return Math.max(1, lines.length);
}

export function getClipboardTextDisplayLabel(text: string): string {
  const lineCount = countTextLines(text);
  return `Paste text ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

export function getAttachmentDisplayLabel(attachment: {
  filename: string;
  source: PendingAttachment["source"];
  content: string;
}): string {
  if (attachment.source === "clipboard_text") {
    return getClipboardTextDisplayLabel(attachment.content);
  }

  return attachment.filename;
}
