import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countTextLines,
  generateAttachmentId,
  getAttachmentDisplayLabel,
  getClipboardTextDisplayLabel,
  resetClipboardCounter,
  isImageMimeType,
  localAttachmentToPendingAttachment,
  validateAttachmentSize,
  fileToAttachment,
  detectClipboardTextLanguage,
  generateClipboardFilename,
} from "./attachments";

describe("generateAttachmentId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a session-local attachment ID", () => {
    const id = generateAttachmentId();
    expect(id).toMatch(/^attachment-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("returns unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateAttachmentId()));
    expect(ids.size).toBe(10);
  });

  it("does not depend on crypto availability", () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => {
        throw new Error("randomUUID should not be called");
      }),
      getRandomValues: vi.fn(() => {
        throw new Error("getRandomValues should not be called");
      }),
    });

    const id = generateAttachmentId();
    expect(id.startsWith("attachment-")).toBe(true);
  });
});

describe("isImageMimeType", () => {
  it("returns true for image types", () => {
    expect(isImageMimeType("image/png")).toBe(true);
    expect(isImageMimeType("image/jpeg")).toBe(true);
    expect(isImageMimeType("image/gif")).toBe(true);
    expect(isImageMimeType("image/webp")).toBe(true);
  });

  it("returns false for non-image types", () => {
    expect(isImageMimeType("text/plain")).toBe(false);
    expect(isImageMimeType("application/json")).toBe(false);
  });
});

describe("validateAttachmentSize", () => {
  it("returns null for small files", () => {
    const file = new File(["hello"], "test.txt");
    expect(validateAttachmentSize(file)).toBeNull();
  });

  it("returns error for large files", () => {
    const bigContent = new Uint8Array(11 * 1024 * 1024);
    const file = new File([bigContent], "big.bin");
    const error = validateAttachmentSize(file);
    expect(error).toContain("exceeds 10 MB");
    expect(error).toContain("big.bin");
  });
});

describe("fileToAttachment", () => {
  it("reads text file as text", async () => {
    const file = new File(["hello world"], "test.txt", { type: "text/plain" });
    const attachment = await fileToAttachment(file, "file_picker");
    expect(attachment.filename).toBe("test.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.content).toBe("hello world");
    expect(attachment.source).toBe("file_picker");
    expect(attachment.isInline).toBe(false);
    expect(attachment.previewUrl).toBeUndefined();
  });

  it("reads image file as base64", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => "blob:test-url";
    try {
      const pixels = new Uint8Array([137, 80, 78, 71]);
      const file = new File([pixels], "img.png", { type: "image/png" });
      const attachment = await fileToAttachment(file, "drag_drop");
      expect(attachment.mimeType).toBe("image/png");
      expect(attachment.previewUrl).toBeTruthy();
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  it("uses fallback mime type", async () => {
    const file = new File(["data"], "unknown", { type: "" });
    const attachment = await fileToAttachment(file, "clipboard_text");
    expect(attachment.mimeType).toBe("application/octet-stream");
  });
});

describe("localAttachmentToPendingAttachment", () => {
  it("creates image previews from native desktop attachment payloads", () => {
    const attachment = localAttachmentToPendingAttachment({
      filename: "drop.png",
      mimeType: "image/png",
      content: "aGVsbG8=",
      sizeBytes: 5,
    }, "drag_drop");

    expect(attachment.previewUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(attachment.source).toBe("drag_drop");
  });

  it("does not create previews for text attachments", () => {
    const attachment = localAttachmentToPendingAttachment({
      filename: "drop.txt",
      mimeType: "text/plain",
      content: "hello",
      sizeBytes: 5,
    }, "drag_drop");

    expect(attachment.previewUrl).toBeUndefined();
    expect(attachment.content).toBe("hello");
  });
});

describe("detectClipboardTextLanguage", () => {
  it("detects JSON object", () => {
    expect(detectClipboardTextLanguage('{"key": "value"}')).toBe("json");
  });

  it("detects JSON array", () => {
    expect(detectClipboardTextLanguage('[1, 2, 3]')).toBe("json");
  });

  it("returns txt for invalid JSON-like text", () => {
    expect(detectClipboardTextLanguage("{not json}")).toBe("txt");
  });

  it("detects HTML with doctype", () => {
    expect(detectClipboardTextLanguage("<!DOCTYPE html><html></html>")).toBe("html");
  });

  it("detects HTML with html tag", () => {
    expect(detectClipboardTextLanguage("<html><body>Hi</body></html>")).toBe("html");
  });

  it("detects SQL SELECT", () => {
    expect(detectClipboardTextLanguage("SELECT * FROM users WHERE id = 1")).toBe("sql");
  });

  it("detects SQL INSERT", () => {
    expect(detectClipboardTextLanguage("INSERT INTO users VALUES (1, 'test')")).toBe("sql");
  });

  it("detects SQL CREATE TABLE", () => {
    expect(detectClipboardTextLanguage("CREATE TABLE users (id INT)")).toBe("sql");
  });

  it("detects CSS", () => {
    expect(detectClipboardTextLanguage(".container { display: flex; }")).toBe("css");
  });

  it("detects shell scripts with shebang", () => {
    expect(detectClipboardTextLanguage("#!/bin/bash\necho hello")).toBe("sh");
  });

  it("returns txt for plain text", () => {
    expect(detectClipboardTextLanguage("just some text")).toBe("txt");
  });
});

describe("generateClipboardFilename", () => {
  beforeEach(() => {
    resetClipboardCounter();
  });

  it("generates sequential filenames without extensions", () => {
    expect(generateClipboardFilename('{"key": "value"}')).toBe("pasted-1");
    expect(generateClipboardFilename("plain text")).toBe("pasted-2");
    expect(generateClipboardFilename("SELECT * FROM users")).toBe("pasted-3");
  });
});

describe("clipboard text labels", () => {
  it("counts text lines", () => {
    expect(countTextLines("one line")).toBe(1);
    expect(countTextLines("one\ntwo\nthree")).toBe(3);
  });

  it("formats clipboard text labels from line counts", () => {
    expect(getClipboardTextDisplayLabel("hello")).toBe("Paste text 1 line");
    expect(getClipboardTextDisplayLabel("a\nb\nc")).toBe("Paste text 3 lines");
  });

  it("uses clipboard text labels for clipboard attachments", () => {
    expect(getAttachmentDisplayLabel({
      filename: "pasted-1",
      source: "clipboard_text",
      content: "a\nb",
    })).toBe("Paste text 2 lines");

    expect(getAttachmentDisplayLabel({
      filename: "notes.md",
      source: "file_picker",
      content: "hello",
    })).toBe("notes.md");
  });
});
