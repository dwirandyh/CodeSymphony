import { describe, expect, it } from "vitest";
import type { ChatAttachment, ChatMessage } from "@codesymphony/shared-types";
import { areMessageArraysEqual, mergeThreadMessages } from "./messageMerge";

function createAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "att-1",
    messageId: "msg-1",
    filename: "file.txt",
    mimeType: "text/plain",
    sizeBytes: 11,
    content: "hello world",
    storagePath: null,
    source: "file_picker",
    createdAt: "2026-02-24T00:00:00.000Z",
    ...overrides,
  };
}

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    threadId: "thread-1",
    seq: 1,
    role: "user",
    content: "Please review this",
    attachments: [],
    createdAt: "2026-02-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("messageMerge", () => {
  it("keeps queried attachment data for file picker attachments when local message has none", () => {
    const local = [createMessage()];
    const queried = [
      createMessage({
        attachments: [createAttachment({ source: "file_picker", filename: "notes.md", content: "# notes" })],
      }),
    ];

    const merged = mergeThreadMessages(queried, local);

    expect(merged[0].attachments).toHaveLength(1);
    expect(merged[0].attachments[0].filename).toBe("notes.md");
    expect(areMessageArraysEqual(merged, local)).toBe(false);
  });

  it("keeps queried attachment data for clipboard text attachments", () => {
    const local = [createMessage({ content: "Here is pasted text" })];
    const queried = [
      createMessage({
        content: "Here is pasted text",
        attachments: [
          createAttachment({
            id: "att-clipboard",
            source: "clipboard_text",
            filename: "pasted-1.txt",
            content: "some clipboard content",
            sizeBytes: 22,
          }),
        ],
      }),
    ];

    const merged = mergeThreadMessages(queried, local);

    expect(merged[0].attachments).toHaveLength(1);
    expect(merged[0].attachments[0].source).toBe("clipboard_text");
    expect(merged[0].attachments[0].filename).toBe("pasted-1.txt");
  });

  it("prefers local streaming assistant content when longer than queried content", () => {
    const local = [
      createMessage({
        role: "assistant",
        content: "This is the longer streaming response",
        attachments: [],
      }),
    ];
    const queried = [
      createMessage({
        role: "assistant",
        content: "This is shorter",
        attachments: [],
      }),
    ];

    const merged = mergeThreadMessages(queried, local);

    expect(merged[0].content).toBe("This is the longer streaming response");
  });

  it("treats attachment changes as message-array changes even when text is unchanged", () => {
    const local = [createMessage({ content: "same text", attachments: [] })];
    const queried = [
      createMessage({
        content: "same text",
        attachments: [createAttachment({ id: "att-2", filename: "same-length.txt", content: "abc" })],
      }),
    ];

    const merged = mergeThreadMessages(queried, local);

    expect(areMessageArraysEqual(local, merged)).toBe(false);
  });
});
