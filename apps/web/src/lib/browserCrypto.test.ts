import type { ChatMessage } from "@codesymphony/shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function restoreCrypto() {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
    return;
  }

  Reflect.deleteProperty(globalThis, "crypto");
}

function stubCrypto(value: unknown) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value,
  });
}

function fillDeterministicRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!array) {
    return array;
  }

  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 17 + 29) % 256;
  }

  return array;
}

function makeMessage(): ChatMessage {
  return {
    id: "message-1",
    threadId: "thread-1",
    seq: 1,
    role: "assistant",
    content: "hello",
    attachments: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("browserCrypto", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    restoreCrypto();
    vi.restoreAllMocks();
  });

  it("adds randomUUID when the browser only exposes getRandomValues", async () => {
    const getRandomValues = vi.fn(fillDeterministicRandomValues);
    stubCrypto({ getRandomValues });

    const { ensureBrowserCryptoRandomUUID, isUuidV4 } = await import("./browserCrypto");
    ensureBrowserCryptoRandomUUID();

    const cryptoObject = globalThis.crypto as Crypto;
    expect(typeof cryptoObject.randomUUID).toBe("function");

    const value = cryptoObject.randomUUID();
    expect(isUuidV4(value)).toBe(true);
    expect(getRandomValues).toHaveBeenCalled();
  });

  it("installs a fallback crypto object when crypto is missing entirely", async () => {
    Reflect.deleteProperty(globalThis, "crypto");

    const { ensureBrowserCryptoRandomUUID, isUuidV4 } = await import("./browserCrypto");
    ensureBrowserCryptoRandomUUID();

    const cryptoObject = globalThis.crypto as Crypto;
    expect(typeof cryptoObject.randomUUID).toBe("function");
    expect(isUuidV4(cryptoObject.randomUUID())).toBe(true);
  });

  it("keeps thread message collection mutations working without native randomUUID", async () => {
    stubCrypto({ getRandomValues: fillDeterministicRandomValues });

    const { ensureBrowserCryptoRandomUUID } = await import("./browserCrypto");
    ensureBrowserCryptoRandomUUID();

    const { createThreadMessagesCollection } = await import("../collections/threadMessages");
    const collection = createThreadMessagesCollection("thread-1");

    expect(() => {
      collection.insert(makeMessage());
    }).not.toThrow();
    expect((collection.toArray as ChatMessage[]).map((message) => message.id)).toEqual(["message-1"]);

    void collection.cleanup();
  });
});
