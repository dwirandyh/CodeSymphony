import { buildAndroidSetClipboardMessage } from "./androidScrcpy";

const WEBSOCKET_OPEN_STATE = 1;

type AndroidClipboardApi = {
  readAndroidClipboard: (sessionId: string) => Promise<string>;
  writeAndroidClipboard: (
    sessionId: string,
    input: {
      paste?: boolean;
      text: string;
    },
  ) => Promise<void>;
};

type AndroidClipboardSocket = {
  readyState: number;
  send: (data: Uint8Array) => void;
} | null | undefined;

export type AndroidClipboardTransport = "runtime" | "viewer";

function hasOpenClipboardSocket(socket: AndroidClipboardSocket): socket is NonNullable<AndroidClipboardSocket> {
  return Boolean(socket && socket.readyState === WEBSOCKET_OPEN_STATE && typeof socket.send === "function");
}

export async function readAndroidClipboardWithFallback(input: {
  api: AndroidClipboardApi;
  requestFromViewer: () => Promise<string>;
  sessionId: string;
}): Promise<{
  text: string;
  transport: AndroidClipboardTransport;
}> {
  try {
    return {
      text: await input.requestFromViewer(),
      transport: "viewer",
    };
  } catch {
    return {
      text: await input.api.readAndroidClipboard(input.sessionId),
      transport: "runtime",
    };
  }
}

export async function writeAndroidClipboardWithFallback(input: {
  api: AndroidClipboardApi;
  paste?: boolean;
  sessionId: string;
  socket: AndroidClipboardSocket;
  text: string;
}): Promise<AndroidClipboardTransport> {
  try {
    // Prefer the runtime helper on real devices. It uses the clipboard helper + KEYCODE_PASTE path,
    // which is more reliable than ws-scrcpy's older clipboard control transport.
    await input.api.writeAndroidClipboard(input.sessionId, {
      paste: input.paste,
      text: input.text,
    });
    return "runtime";
  } catch (runtimeError) {
    if (hasOpenClipboardSocket(input.socket)) {
      try {
        input.socket.send(buildAndroidSetClipboardMessage(input.text, input.paste));
        return "viewer";
      } catch {
        // Fall through to the original runtime error when the viewer socket also rejects the message.
      }
    }

    throw runtimeError;
  }
}
