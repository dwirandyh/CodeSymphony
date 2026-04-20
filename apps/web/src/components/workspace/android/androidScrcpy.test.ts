import { describe, expect, it } from "vitest";
import { parseAndroidInitialPacket } from "./androidScrcpy";

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
