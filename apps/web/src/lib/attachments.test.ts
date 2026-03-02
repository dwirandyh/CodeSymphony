import { describe, it, expect, beforeEach } from "vitest";
import {
  generateAttachmentId,
  resetClipboardCounter,
  isImageMimeType,
  validateAttachmentSize,
  fileToAttachment,
  detectClipboardTextLanguage,
  generateClipboardFilename,
} from "./attachments";

describe("generateAttachmentId", () => {
  it("returns a UUID-like string", () => {
    const id = generateAttachmentId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateAttachmentId()));
    expect(ids.size).toBe(10);
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

  it("generates sequential filenames with detected extension", () => {
    expect(generateClipboardFilename('{"key": "value"}')).toBe("pasted-1.json");
    expect(generateClipboardFilename("plain text")).toBe("pasted-2.txt");
    expect(generateClipboardFilename("SELECT * FROM users")).toBe("pasted-3.sql");
  });
});
