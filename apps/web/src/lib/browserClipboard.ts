export async function writeTextToBrowserClipboard(text: string): Promise<void> {
  let asyncClipboardError: unknown = null;

  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      asyncClipboardError = error;
    }
  }

  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    if (asyncClipboardError instanceof Error) {
      throw asyncClipboardError;
    }
    throw new Error("Browser clipboard write is unavailable.");
  }

  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (document.execCommand("copy")) {
      return;
    }
  } finally {
    textarea.remove();
    if (activeElement instanceof HTMLElement) {
      activeElement.focus({ preventScroll: true });
    }
  }

  if (asyncClipboardError instanceof Error) {
    throw asyncClipboardError;
  }
  throw new Error("Browser clipboard write is unavailable.");
}
