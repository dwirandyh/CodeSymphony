import { describe, expect, it } from "vitest";
import { getAndroidClipboardShortcutAction } from "./androidKeyboardShortcuts";

describe("getAndroidClipboardShortcutAction", () => {
  it("maps Cmd or Ctrl+C to copy from the device", () => {
    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: false,
      key: "c",
      metaKey: true,
    })).toBe("copy_from_device");

    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: true,
      key: "C",
      metaKey: false,
    })).toBe("copy_from_device");
  });

  it("maps Cmd or Ctrl+V to paste into the device", () => {
    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: false,
      key: "v",
      metaKey: true,
    })).toBe("paste_to_device");

    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: true,
      key: "V",
      metaKey: false,
    })).toBe("paste_to_device");
  });

  it("ignores unrelated or modified shortcuts", () => {
    expect(getAndroidClipboardShortcutAction({
      altKey: true,
      ctrlKey: false,
      key: "v",
      metaKey: true,
    })).toBeNull();

    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: false,
      key: "x",
      metaKey: true,
    })).toBeNull();

    expect(getAndroidClipboardShortcutAction({
      altKey: false,
      ctrlKey: false,
      key: "v",
      metaKey: false,
    })).toBeNull();
  });
});
