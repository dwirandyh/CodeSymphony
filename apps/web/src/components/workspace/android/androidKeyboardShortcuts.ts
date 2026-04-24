export type AndroidClipboardShortcutAction = "copy_from_device" | "paste_to_device" | null;

export function getAndroidClipboardShortcutAction(input: {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}): AndroidClipboardShortcutAction {
  if (input.altKey || (!input.metaKey && !input.ctrlKey)) {
    return null;
  }

  const normalizedKey = input.key.toLowerCase();
  if (normalizedKey === "c") {
    return "copy_from_device";
  }

  if (normalizedKey === "v") {
    return "paste_to_device";
  }

  return null;
}
