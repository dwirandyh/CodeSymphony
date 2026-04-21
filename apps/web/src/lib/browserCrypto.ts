type MutableCrypto = Crypto & {
  randomUUID?: () => string;
};

const UUID_BYTE_LENGTH = 16;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BYTE_TO_HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));
type UuidV4String = `${string}-${string}-${string}-${string}-${string}`;

function fallbackGetRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!array) {
    return array;
  }

  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  return array;
}

function fillRandomBytes(bytes: Uint8Array): Uint8Array {
  const cryptoObject = globalThis.crypto as MutableCrypto | undefined;
  if (cryptoObject && typeof cryptoObject.getRandomValues === "function") {
    return cryptoObject.getRandomValues(bytes);
  }

  return fallbackGetRandomValues(bytes);
}

export function createUuidV4(): UuidV4String {
  const bytes = fillRandomBytes(new Uint8Array(UUID_BYTE_LENGTH));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return [
    `${BYTE_TO_HEX[bytes[0]]}${BYTE_TO_HEX[bytes[1]]}${BYTE_TO_HEX[bytes[2]]}${BYTE_TO_HEX[bytes[3]]}`,
    `${BYTE_TO_HEX[bytes[4]]}${BYTE_TO_HEX[bytes[5]]}`,
    `${BYTE_TO_HEX[bytes[6]]}${BYTE_TO_HEX[bytes[7]]}`,
    `${BYTE_TO_HEX[bytes[8]]}${BYTE_TO_HEX[bytes[9]]}`,
    `${BYTE_TO_HEX[bytes[10]]}${BYTE_TO_HEX[bytes[11]]}${BYTE_TO_HEX[bytes[12]]}${BYTE_TO_HEX[bytes[13]]}${BYTE_TO_HEX[bytes[14]]}${BYTE_TO_HEX[bytes[15]]}`,
  ].join("-") as UuidV4String;
}

function installRandomUUID(cryptoObject: MutableCrypto): boolean {
  if (typeof cryptoObject.randomUUID === "function") {
    return true;
  }

  try {
    Object.defineProperty(cryptoObject, "randomUUID", {
      configurable: true,
      writable: true,
      value: createUuidV4,
    });
  } catch {
    try {
      cryptoObject.randomUUID = createUuidV4;
    } catch {
      return false;
    }
  }

  return typeof cryptoObject.randomUUID === "function";
}

export function ensureBrowserCryptoRandomUUID(): void {
  const cryptoObject = globalThis.crypto as MutableCrypto | undefined;
  if (cryptoObject && installRandomUUID(cryptoObject)) {
    return;
  }

  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      writable: true,
      value: {
        getRandomValues: fallbackGetRandomValues,
        randomUUID: createUuidV4,
      } satisfies Pick<Crypto, "getRandomValues" | "randomUUID">,
    });
  } catch {
    // Best effort. If the host disallows patching crypto entirely, the app will still
    // surface the original runtime error instead of silently degrading.
  }
}

export function isUuidV4(value: string): boolean {
  return UUID_REGEX.test(value);
}
