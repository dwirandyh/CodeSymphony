import { describe, expect, it } from "vitest";
import {
  buildAndroidGetClipboardMessage,
  buildAndroidSetClipboardMessage,
  buildAndroidTextMessage,
  getAndroidEncodedVideoChunkType,
  parseAndroidDeviceMessage,
  parseAndroidInitialPacket,
} from "./androidScrcpy";

const encoder = new TextEncoder();

function writeAscii(target: Uint8Array, offset: number, value: string) {
  target.set(encoder.encode(value), offset);
}

function writeInt8(view: DataView, offset: number, value: number): number {
  view.setInt8(offset, value);
  return offset + 1;
}

function writeInt16(view: DataView, offset: number, value: number): number {
  view.setInt16(offset, value);
  return offset + 2;
}

function writeInt32(view: DataView, offset: number, value: number): number {
  view.setInt32(offset, value);
  return offset + 4;
}

function createInitialPacket(): ArrayBuffer {
  const magic = encoder.encode("scrcpy_initial");
  const deviceName = "Pixel 9 Pro";
  const codecOptions = "profile=high";
  const encoderName = "c2.android.avc.encoder";
  const screenInfoBytesLength = 25;
  const videoSettingsBytesLength = 35 + codecOptions.length + encoderName.length;
  const totalLength = magic.length + 64 + 4 + 24 + 4 + 4 + screenInfoBytesLength + 4 + videoSettingsBytesLength + 4 + 4;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  bytes.set(magic, offset);
  offset += magic.length;
  writeAscii(bytes, offset, deviceName);
  offset += 64;
  offset = writeInt32(view, offset, 1);

  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, 1280);
  offset = writeInt32(view, offset, 2856);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, 16515);
  offset = writeInt32(view, offset, 1);

  offset = writeInt32(view, offset, screenInfoBytesLength);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, 1280);
  offset = writeInt32(view, offset, 2856);
  offset = writeInt32(view, offset, 272);
  offset = writeInt32(view, offset, 640);
  offset = writeInt8(view, offset, 0);

  offset = writeInt32(view, offset, videoSettingsBytesLength);
  offset = writeInt32(view, offset, 524_288);
  offset = writeInt32(view, offset, 24);
  offset = writeInt8(view, offset, 5);
  offset = writeInt16(view, offset, 288);
  offset = writeInt16(view, offset, 640);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeInt8(view, offset, 1);
  offset = writeInt8(view, offset, -1);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, codecOptions.length);
  writeAscii(bytes, offset, codecOptions);
  offset += codecOptions.length;
  offset = writeInt32(view, offset, encoderName.length);
  writeAscii(bytes, offset, encoderName);
  offset += encoderName.length;

  offset = writeInt32(view, offset, 0);
  writeInt32(view, offset, 7);

  return bytes.buffer;
}

function createClipboardDeviceMessage(text: string): ArrayBuffer {
  const magic = encoder.encode("scrcpy_message");
  const encodedText = encoder.encode(text);
  const bytes = new Uint8Array(magic.length + 1 + 4 + encodedText.length);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  bytes.set(magic, offset);
  offset += magic.length;
  offset = writeInt8(view, offset, 0);
  offset = writeInt32(view, offset, encodedText.length);
  bytes.set(encodedText, offset);

  return bytes.buffer;
}

describe("parseAndroidInitialPacket", () => {
  it("parses video settings fields with the correct offsets", () => {
    const packet = parseAndroidInitialPacket(createInitialPacket());
    const display = packet.displays[0];

    expect(display?.displayId).toBe(0);
    expect(display?.screenInfo?.videoWidth).toBe(272);
    expect(display?.screenInfo?.videoHeight).toBe(640);
    expect(display?.videoSettings).toEqual({
      bitrate: 524_288,
      codecOptions: "profile=high",
      displayId: 0,
      encoderName: "c2.android.avc.encoder",
      height: 640,
      iFrameInterval: 5,
      lockedVideoOrientation: -1,
      maxFps: 24,
      sendFrameMeta: true,
      width: 288,
    });
  });
});

describe("Android control messages", () => {
  it("encodes text input using the UTF-8 payload length", () => {
    const text = "Halo 👋";
    const message = buildAndroidTextMessage(text);
    const encodedText = encoder.encode(text);
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);

    expect(view.getUint8(0)).toBe(1);
    expect(view.getInt32(1)).toBe(encodedText.length);
    expect(Array.from(message.slice(5))).toEqual(Array.from(encodedText));
  });

  it("encodes set clipboard commands with the paste flag and UTF-8 payload", () => {
    const text = "Salin ✂️";
    const message = buildAndroidSetClipboardMessage(text, true);
    const encodedText = encoder.encode(text);
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);

    expect(view.getUint8(0)).toBe(9);
    expect(view.getUint8(1)).toBe(1);
    expect(view.getInt32(2)).toBe(encodedText.length);
    expect(Array.from(message.slice(6))).toEqual(Array.from(encodedText));
  });

  it("encodes get clipboard as a single-byte command", () => {
    expect(Array.from(buildAndroidGetClipboardMessage())).toEqual([8]);
  });
});

describe("parseAndroidDeviceMessage", () => {
  it("parses clipboard messages from ws-scrcpy packets", () => {
    expect(parseAndroidDeviceMessage(createClipboardDeviceMessage("Disalin dari device"))).toEqual({
      text: "Disalin dari device",
      type: "clipboard",
    });
  });
});

describe("Android video packet classification", () => {
  it("maps H264 slice packets to the correct WebCodecs chunk type", () => {
    expect(getAndroidEncodedVideoChunkType(1)).toBe("delta");
    expect(getAndroidEncodedVideoChunkType(2)).toBe("delta");
    expect(getAndroidEncodedVideoChunkType(3)).toBe("delta");
    expect(getAndroidEncodedVideoChunkType(4)).toBe("delta");
    expect(getAndroidEncodedVideoChunkType(5)).toBe("key");
    expect(getAndroidEncodedVideoChunkType(6)).toBeNull();
    expect(getAndroidEncodedVideoChunkType(7)).toBeNull();
    expect(getAndroidEncodedVideoChunkType(8)).toBeNull();
  });
});
