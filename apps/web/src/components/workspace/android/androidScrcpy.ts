const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const SCRCPY_INITIAL_MAGIC = textEncoder.encode("scrcpy_initial");
const SCRCPY_MESSAGE_MAGIC = textEncoder.encode("scrcpy_message");
const DEFAULT_REMOTE = "tcp:8886";

const CONTROL_TYPE_TEXT = 1;
const NAL_TYPE_NON_IDR = 1;
const NAL_TYPE_IDR = 5;
const NAL_TYPE_SEI = 6;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

const CONTROL_TYPE_KEYCODE = 0;
const CONTROL_TYPE_TOUCH = 2;
const CONTROL_TYPE_SCROLL = 3;
const CONTROL_TYPE_GET_CLIPBOARD = 8;
const CONTROL_TYPE_SET_CLIPBOARD = 9;
const CONTROL_TYPE_CHANGE_STREAM_PARAMETERS = 101;
const DEVICE_MESSAGE_TYPE_CLIPBOARD = 0;

export const ANDROID_KEY_ACTION_DOWN = 0;
export const ANDROID_KEY_ACTION_UP = 1;

export const ANDROID_KEYCODE_HOME = 3;
export const ANDROID_KEYCODE_BACK = 4;
export const ANDROID_KEYCODE_DPAD_UP = 19;
export const ANDROID_KEYCODE_DPAD_DOWN = 20;
export const ANDROID_KEYCODE_DPAD_LEFT = 21;
export const ANDROID_KEYCODE_DPAD_RIGHT = 22;
export const ANDROID_KEYCODE_APP_SWITCH = 187;
export const ANDROID_KEYCODE_POWER = 26;
export const ANDROID_KEYCODE_TAB = 61;
export const ANDROID_KEYCODE_ENTER = 66;
export const ANDROID_KEYCODE_DEL = 67;
export const ANDROID_KEYCODE_ESCAPE = 111;
export const ANDROID_KEYCODE_V = 50;
export const ANDROID_KEYCODE_CTRL_LEFT = 113;
export const ANDROID_META_CTRL_ON = 0x1000;
export const ANDROID_META_CTRL_LEFT_ON = 0x2000;

export type AndroidDisplayInfo = {
  connectionCount: number;
  displayId: number;
  flags: number;
  height: number;
  layerStack: number;
  rotation: number;
  screenInfo: AndroidScreenInfo | null;
  videoSettings: AndroidVideoSettings | null;
  width: number;
};

export type AndroidScreenInfo = {
  contentRect: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  deviceRotation: number;
  videoHeight: number;
  videoWidth: number;
};

export type AndroidVideoSettings = {
  bitrate: number;
  codecOptions: string | null;
  displayId: number;
  encoderName: string | null;
  height: number;
  iFrameInterval: number;
  lockedVideoOrientation: number;
  maxFps: number;
  sendFrameMeta: boolean;
  width: number;
};

export type AndroidInitialPacket = {
  clientId: number;
  deviceName: string;
  displays: AndroidDisplayInfo[];
};

export type AndroidDecodedVideoConfig = {
  codec: string;
  height: number;
  width: number;
};

export type AndroidDeviceMessage =
  | {
    text: string;
    type: "clipboard";
  }
  | {
    rawType: number;
    type: "unknown";
  };

type H264SpsParameters = {
  codec: string;
  frameCropBottomOffset: number;
  frameCropLeftOffset: number;
  frameCropRightOffset: number;
  frameCropTopOffset: number;
  frameMbsOnlyFlag: number;
  picHeightInMapUnitsMinus1: number;
  picWidthInMbsMinus1: number;
  sar: [number, number];
};

class BitReader {
  private index = 0;
  private readonly bitLength: number;

  constructor(private readonly data: Uint8Array) {
    this.bitLength = data.byteLength * 8;
  }

  get bitsAvailable(): number {
    return this.bitLength - this.index;
  }

  readBits(size: number): number {
    return this.getBits(size, this.index);
  }

  readBoolean(): boolean {
    return this.readBits(1) === 1;
  }

  readUByte(): number {
    return this.readBits(8);
  }

  readUInt(): number {
    return this.readBits(32);
  }

  readUEG(): number {
    const prefix = this.skipLeadingZeroes();
    return this.readBits(prefix + 1) - 1;
  }

  readEG(): number {
    const value = this.readUEG();
    return (value & 1) === 1 ? (1 + value) >>> 1 : -1 * (value >>> 1);
  }

  skipBits(size: number): void {
    if (this.bitsAvailable < size) {
      throw new Error("No bits available");
    }
    this.index += size;
  }

  skipUEG(): void {
    this.skipBits(1 + this.skipLeadingZeroes());
  }

  skipEG(): void {
    this.skipBits(1 + this.skipLeadingZeroes());
  }

  private getBits(size: number, offsetBits: number, moveIndex = true): number {
    if (this.bitsAvailable < size) {
      throw new Error("No bits available");
    }

    const offset = offsetBits % 8;
    const byte = this.data[(offsetBits / 8) | 0] & (0xff >>> offset);
    const bits = 8 - offset;

    if (bits >= size) {
      if (moveIndex) {
        this.index += size;
      }
      return byte >> (bits - size);
    }

    if (moveIndex) {
      this.index += bits;
    }

    const nextSize = size - bits;
    return (byte << nextSize) | this.getBits(nextSize, offsetBits + bits, moveIndex);
  }

  private skipLeadingZeroes(): number {
    let leadingZeroCount = 0;

    while (leadingZeroCount < this.bitLength - this.index) {
      if (this.getBits(1, this.index + leadingZeroCount, false) !== 0) {
        this.index += leadingZeroCount;
        return leadingZeroCount;
      }
      leadingZeroCount += 1;
    }

    return leadingZeroCount;
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

function readUint8(view: DataView, offset: number): number {
  return view.getUint8(offset);
}

function readInt8(view: DataView, offset: number): number {
  return view.getInt8(offset);
}

function readInt16(view: DataView, offset: number): number {
  return view.getInt16(offset);
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset);
}

function readInt32(view: DataView, offset: number): number {
  return view.getInt32(offset);
}

function writeInt16(view: DataView, offset: number, value: number): number {
  view.setInt16(offset, value);
  return offset + 2;
}

function writeInt32(view: DataView, offset: number, value: number): number {
  view.setInt32(offset, value);
  return offset + 4;
}

function writeUint8(view: DataView, offset: number, value: number): number {
  view.setUint8(offset, value);
  return offset + 1;
}

function encodeString(target: Uint8Array, offset: number, value: string): number {
  const encoded = textEncoder.encode(value);
  target.set(encoded, offset);
  return offset + encoded.length;
}

function decodeString(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  return textDecoder.decode(bytes.subarray(0, end));
}

function skipScalingList(reader: BitReader, count: number): void {
  let lastScale = 8;
  let nextScale = 8;

  for (let index = 0; index < count; index += 1) {
    if (nextScale !== 0) {
      const deltaScale = reader.readEG();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function parseSpsParameters(data: Uint8Array): H264SpsParameters {
  const reader = new BitReader(data);
  let frameCropLeftOffset = 0;
  let frameCropRightOffset = 0;
  let frameCropTopOffset = 0;
  let frameCropBottomOffset = 0;

  reader.readUByte();
  const profileIdc = reader.readUByte();
  const constraintSetFlags = reader.readUByte();
  const levelIdc = reader.readBits(8);

  reader.readUEG();

  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    const chromaFormatIdc = reader.readUEG();
    if (chromaFormatIdc === 3) {
      reader.skipBits(1);
    }
    reader.skipUEG();
    reader.skipUEG();
    reader.skipBits(1);
    if (reader.readBoolean()) {
      const scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
      for (let index = 0; index < scalingListCount; index += 1) {
        if (reader.readBoolean()) {
          skipScalingList(reader, index < 6 ? 16 : 64);
        }
      }
    }
  }

  reader.skipUEG();
  const picOrderCntType = reader.readUEG();
  if (picOrderCntType === 0) {
    reader.readUEG();
  } else if (picOrderCntType === 1) {
    reader.skipBits(1);
    reader.skipEG();
    reader.skipEG();
    const numRefFramesInPicOrderCntCycle = reader.readUEG();
    for (let index = 0; index < numRefFramesInPicOrderCntCycle; index += 1) {
      reader.skipEG();
    }
  }

  reader.skipUEG();
  reader.skipBits(1);

  const picWidthInMbsMinus1 = reader.readUEG();
  const picHeightInMapUnitsMinus1 = reader.readUEG();
  const frameMbsOnlyFlag = reader.readBits(1);

  if (frameMbsOnlyFlag === 0) {
    reader.skipBits(1);
  }

  reader.skipBits(1);

  if (reader.readBoolean()) {
    frameCropLeftOffset = reader.readUEG();
    frameCropRightOffset = reader.readUEG();
    frameCropTopOffset = reader.readUEG();
    frameCropBottomOffset = reader.readUEG();
  }

  let sar: [number, number] = [1, 1];

  if (reader.readBoolean() && reader.readBoolean()) {
    const aspectRatioIdc = reader.readUByte();
    switch (aspectRatioIdc) {
      case 1:
        sar = [1, 1];
        break;
      case 2:
        sar = [12, 11];
        break;
      case 3:
        sar = [10, 11];
        break;
      case 4:
        sar = [16, 11];
        break;
      case 5:
        sar = [40, 33];
        break;
      case 6:
        sar = [24, 11];
        break;
      case 7:
        sar = [20, 11];
        break;
      case 8:
        sar = [32, 11];
        break;
      case 9:
        sar = [80, 33];
        break;
      case 10:
        sar = [18, 11];
        break;
      case 11:
        sar = [15, 11];
        break;
      case 12:
        sar = [64, 33];
        break;
      case 13:
        sar = [160, 99];
        break;
      case 14:
        sar = [4, 3];
        break;
      case 15:
        sar = [3, 2];
        break;
      case 16:
        sar = [2, 1];
        break;
      case 255:
        sar = [
          (reader.readUByte() << 8) | reader.readUByte(),
          (reader.readUByte() << 8) | reader.readUByte(),
        ];
        break;
      default:
        sar = [1, 1];
        break;
    }
  }

  const codec = `avc1.${[profileIdc, constraintSetFlags, levelIdc].map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join("")}`;

  return {
    codec,
    frameCropBottomOffset,
    frameCropLeftOffset,
    frameCropRightOffset,
    frameCropTopOffset,
    frameMbsOnlyFlag,
    picHeightInMapUnitsMinus1,
    picWidthInMbsMinus1,
    sar,
  };
}

function createDefaultVideoSettings(displayId: number, width: number, height: number): AndroidVideoSettings {
  return {
    bitrate: 524_288,
    codecOptions: null,
    displayId,
    encoderName: null,
    height,
    iFrameInterval: 5,
    lockedVideoOrientation: -1,
    maxFps: 24,
    sendFrameMeta: false,
    width,
  };
}

export function buildAndroidViewerWebSocketUrl(runtimeBaseUrl: string, sessionId: string, udid: string): string {
  const wsBase = new URL(runtimeBaseUrl);
  wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
  const viewerWsUrl = new URL(`/api/device-streams/${encodeURIComponent(sessionId)}/viewer/ws`, wsBase);
  viewerWsUrl.searchParams.set("action", "proxy-adb");
  viewerWsUrl.searchParams.set("remote", DEFAULT_REMOTE);
  viewerWsUrl.searchParams.set("udid", udid);
  return viewerWsUrl.toString();
}

export function isAndroidInitialPacket(data: ArrayBuffer): boolean {
  if (data.byteLength < SCRCPY_INITIAL_MAGIC.length) {
    return false;
  }
  return arraysEqual(new Uint8Array(data, 0, SCRCPY_INITIAL_MAGIC.length), SCRCPY_INITIAL_MAGIC);
}

export function isAndroidDeviceMessagePacket(data: ArrayBuffer): boolean {
  if (data.byteLength < SCRCPY_MESSAGE_MAGIC.length) {
    return false;
  }
  return arraysEqual(new Uint8Array(data, 0, SCRCPY_MESSAGE_MAGIC.length), SCRCPY_MESSAGE_MAGIC);
}

export function parseAndroidDeviceMessage(data: ArrayBuffer): AndroidDeviceMessage | null {
  if (!isAndroidDeviceMessagePacket(data)) {
    return null;
  }

  const payloadOffset = SCRCPY_MESSAGE_MAGIC.length;
  const payload = new Uint8Array(data, payloadOffset);
  if (payload.byteLength === 0) {
    return null;
  }

  const rawType = payload[0];
  if (rawType !== DEVICE_MESSAGE_TYPE_CLIPBOARD) {
    return {
      rawType,
      type: "unknown",
    };
  }

  if (payload.byteLength < 5) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const textLength = view.getInt32(1);
  if (textLength < 0 || payload.byteLength < 5 + textLength) {
    return null;
  }

  return {
    text: textDecoder.decode(payload.subarray(5, 5 + textLength)),
    type: "clipboard",
  };
}

export function parseAndroidInitialPacket(data: ArrayBuffer): AndroidInitialPacket {
  if (!isAndroidInitialPacket(data)) {
    throw new Error("Invalid scrcpy initial packet");
  }

  const view = new DataView(data);
  let offset = SCRCPY_INITIAL_MAGIC.length;

  const deviceName = decodeString(new Uint8Array(data, offset, 64));
  offset += 64;

  const displaysCount = readInt32(view, offset);
  offset += 4;

  const displays: AndroidDisplayInfo[] = [];
  for (let index = 0; index < displaysCount; index += 1) {
    const displayId = readInt32(view, offset);
    const width = readInt32(view, offset + 4);
    const height = readInt32(view, offset + 8);
    const rotation = readInt32(view, offset + 12);
    const layerStack = readInt32(view, offset + 16);
    const flags = readInt32(view, offset + 20);
    offset += 24;

    const connectionCount = readInt32(view, offset);
    offset += 4;

    const screenInfoBytesCount = readInt32(view, offset);
    offset += 4;

    let screenInfo: AndroidScreenInfo | null = null;
    if (screenInfoBytesCount > 0) {
      screenInfo = {
        contentRect: {
          bottom: readInt32(view, offset + 12),
          left: readInt32(view, offset),
          right: readInt32(view, offset + 8),
          top: readInt32(view, offset + 4),
        },
        deviceRotation: readUint8(view, offset + 24),
        videoHeight: readInt32(view, offset + 20),
        videoWidth: readInt32(view, offset + 16),
      };
      offset += screenInfoBytesCount;
    }

    const videoSettingsBytesCount = readInt32(view, offset);
    offset += 4;

    let videoSettings: AndroidVideoSettings | null = null;
    if (videoSettingsBytesCount > 0) {
      const widthSetting = readInt16(view, offset + 9);
      const heightSetting = readInt16(view, offset + 11);
      const codecOptionsLength = readInt32(view, offset + 27);
      const codecOptionsOffset = offset + 31;
      const encoderLengthOffset = codecOptionsOffset + codecOptionsLength;
      const encoderNameLength = readInt32(view, encoderLengthOffset);
      const encoderNameOffset = encoderLengthOffset + 4;

      videoSettings = {
        bitrate: readInt32(view, offset),
        codecOptions: codecOptionsLength > 0
          ? textDecoder.decode(new Uint8Array(data, codecOptionsOffset, codecOptionsLength))
          : null,
        displayId: readInt32(view, offset + 23),
        encoderName: encoderNameLength > 0
          ? textDecoder.decode(new Uint8Array(data, encoderNameOffset, encoderNameLength))
          : null,
        height: heightSetting,
        iFrameInterval: readInt8(view, offset + 8),
        lockedVideoOrientation: readInt8(view, offset + 22),
        maxFps: readInt32(view, offset + 4),
        sendFrameMeta: readInt8(view, offset + 21) === 1,
        width: widthSetting,
      };

      offset += videoSettingsBytesCount;
    }

    displays.push({
      connectionCount,
      displayId,
      flags,
      height,
      layerStack,
      rotation,
      screenInfo,
      videoSettings,
      width,
    });
  }

  const encodersCount = readInt32(view, offset);
  offset += 4;

  for (let index = 0; index < encodersCount; index += 1) {
    const nameLength = readInt32(view, offset);
    offset += 4 + nameLength;
  }

  const clientId = readInt32(view, offset);

  return {
    clientId,
    deviceName,
    displays,
  };
}

export function parseAndroidVideoPacketConfig(packet: Uint8Array): AndroidDecodedVideoConfig | null {
  if (packet.length < 5) {
    return null;
  }

  const type = packet[4] & 0x1f;
  if (type !== NAL_TYPE_SPS) {
    return null;
  }

  const parameters = parseSpsParameters(packet.subarray(4));
  const sarScale = parameters.sar[0] / parameters.sar[1];
  const width = Math.ceil(
    ((parameters.picWidthInMbsMinus1 + 1) * 16 - parameters.frameCropLeftOffset * 2 - parameters.frameCropRightOffset * 2) *
      sarScale,
  );
  const height =
    (2 - parameters.frameMbsOnlyFlag) * (parameters.picHeightInMapUnitsMinus1 + 1) * 16 -
    (parameters.frameMbsOnlyFlag ? 2 : 4) * (parameters.frameCropTopOffset + parameters.frameCropBottomOffset);

  return {
    codec: parameters.codec,
    height,
    width,
  };
}

export function getAndroidVideoPacketType(packet: Uint8Array): number | null {
  if (packet.length < 5) {
    return null;
  }
  return packet[4] & 0x1f;
}

export function getAndroidEncodedVideoChunkType(packetType: number): "delta" | "key" | null {
  if (packetType === NAL_TYPE_IDR) {
    return "key";
  }

  if (packetType >= NAL_TYPE_NON_IDR && packetType < NAL_TYPE_IDR) {
    return "delta";
  }

  return null;
}

export function shouldBufferAndroidVideoPacket(packetType: number): boolean {
  return packetType === NAL_TYPE_SPS || packetType === NAL_TYPE_PPS || packetType === NAL_TYPE_SEI;
}

export function isAndroidVideoKeyPacket(packetType: number): boolean {
  return packetType === NAL_TYPE_IDR;
}

export function createDefaultAndroidVideoSettings(displayId: number, width: number, height: number): AndroidVideoSettings {
  return createDefaultVideoSettings(displayId, width, height);
}

export function buildAndroidVideoSettingsMessage(settings: AndroidVideoSettings): Uint8Array {
  const codecOptionsBytes = settings.codecOptions ? textEncoder.encode(settings.codecOptions) : new Uint8Array();
  const encoderNameBytes = settings.encoderName ? textEncoder.encode(settings.encoderName) : new Uint8Array();
  const buffer = new Uint8Array(1 + 35 + codecOptionsBytes.length + encoderNameBytes.length);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_CHANGE_STREAM_PARAMETERS);
  offset = writeInt32(view, offset, settings.bitrate);
  offset = writeInt32(view, offset, settings.maxFps);
  offset = writeUint8(view, offset, settings.iFrameInterval);
  offset = writeInt16(view, offset, settings.width);
  offset = writeInt16(view, offset, settings.height);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeInt16(view, offset, 0);
  offset = writeUint8(view, offset, settings.sendFrameMeta ? 1 : 0);
  offset = writeUint8(view, offset, settings.lockedVideoOrientation);
  offset = writeInt32(view, offset, settings.displayId);
  offset = writeInt32(view, offset, codecOptionsBytes.length);
  offset = encodeString(buffer, offset, settings.codecOptions ?? "");
  offset = writeInt32(view, offset, encoderNameBytes.length);
  encodeString(buffer, offset, settings.encoderName ?? "");

  return buffer;
}

export function buildAndroidTextMessage(text: string): Uint8Array {
  const encodedText = textEncoder.encode(text);
  const buffer = new Uint8Array(1 + 4 + encodedText.length);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_TEXT);
  offset = writeInt32(view, offset, encodedText.length);
  buffer.set(encodedText, offset);

  return buffer;
}

export function buildAndroidKeyCodeMessage(action: number, keycode: number, repeat = 0, metaState = 0): Uint8Array {
  const buffer = new Uint8Array(14);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_KEYCODE);
  offset = writeUint8(view, offset, action);
  offset = writeInt32(view, offset, keycode);
  offset = writeInt32(view, offset, repeat);
  writeInt32(view, offset, metaState);

  return buffer;
}

export function buildAndroidTouchMessage(input: {
  action: number;
  buttons: number;
  pointerId: number;
  pressure: number;
  screenHeight: number;
  screenWidth: number;
  x: number;
  y: number;
}): Uint8Array {
  const buffer = new Uint8Array(29);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_TOUCH);
  offset = writeUint8(view, offset, input.action);
  offset = writeInt32(view, offset, 0);
  offset = writeInt32(view, offset, input.pointerId);
  offset = writeInt32(view, offset, input.x);
  offset = writeInt32(view, offset, input.y);
  offset = writeInt16(view, offset, input.screenWidth);
  offset = writeInt16(view, offset, input.screenHeight);
  offset = writeUint8(view, offset, 0);
  offset = writeUint8(view, offset, Math.round(Math.max(0, Math.min(1, input.pressure)) * 0xff));
  writeInt32(view, offset, input.buttons);

  return buffer;
}

export function buildAndroidScrollMessage(input: {
  hScroll: number;
  screenHeight: number;
  screenWidth: number;
  vScroll: number;
  x: number;
  y: number;
}): Uint8Array {
  const buffer = new Uint8Array(21);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_SCROLL);
  offset = writeInt32(view, offset, input.x);
  offset = writeInt32(view, offset, input.y);
  offset = writeInt16(view, offset, input.screenWidth);
  offset = writeInt16(view, offset, input.screenHeight);
  offset = writeInt32(view, offset, input.hScroll);
  writeInt32(view, offset, input.vScroll);

  return buffer;
}

export function buildAndroidGetClipboardMessage(): Uint8Array {
  const buffer = new Uint8Array(1);
  const view = new DataView(buffer.buffer);
  writeUint8(view, 0, CONTROL_TYPE_GET_CLIPBOARD);
  return buffer;
}

export function buildAndroidSetClipboardMessage(text: string, paste = false): Uint8Array {
  const encodedText = textEncoder.encode(text);
  const buffer = new Uint8Array(1 + 1 + 4 + encodedText.length);
  const view = new DataView(buffer.buffer);
  let offset = 0;

  offset = writeUint8(view, offset, CONTROL_TYPE_SET_CLIPBOARD);
  offset = writeUint8(view, offset, paste ? 1 : 0);
  offset = writeInt32(view, offset, encodedText.length);
  buffer.set(encodedText, offset);

  return buffer;
}
