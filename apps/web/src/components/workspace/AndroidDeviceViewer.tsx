import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Clipboard, Copy, House, Keyboard, LayoutGrid, LoaderCircle, Maximize2, Minimize2, Power, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { debugLog } from "../../lib/debugLog";
import { createDeviceStreamMetrics } from "../../lib/deviceStreamMetrics";
import { cn } from "../../lib/utils";
import { getMobileDeviceViewerControlsFlag, supportsAndroidNativeViewer } from "./deviceViewerEnvironment";
import {
  readAndroidClipboardWithFallback,
  writeAndroidClipboardWithFallback,
} from "./android/androidClipboardTransport";
import { getAndroidClipboardShortcutAction } from "./android/androidKeyboardShortcuts";
import {
  ANDROID_KEYCODE_APP_SWITCH,
  ANDROID_KEYCODE_BACK,
  ANDROID_KEYCODE_DPAD_DOWN,
  ANDROID_KEYCODE_DPAD_LEFT,
  ANDROID_KEYCODE_DPAD_RIGHT,
  ANDROID_KEYCODE_DPAD_UP,
  ANDROID_KEYCODE_ENTER,
  ANDROID_KEYCODE_ESCAPE,
  ANDROID_KEYCODE_HOME,
  ANDROID_KEYCODE_POWER,
  ANDROID_KEYCODE_TAB,
  buildAndroidGetClipboardMessage,
  buildAndroidScrollMessage,
  buildAndroidVideoSettingsMessage,
  buildAndroidViewerWebSocketUrl,
  createDefaultAndroidVideoSettings,
  getAndroidEncodedVideoChunkType,
  getAndroidVideoPacketType,
  isAndroidDeviceMessagePacket,
  isAndroidInitialPacket,
  isAndroidVideoKeyPacket,
  parseAndroidDeviceMessage,
  parseAndroidInitialPacket,
  parseAndroidVideoPacketConfig,
  type AndroidDisplayInfo,
  type AndroidVideoSettings,
} from "./android/androidScrcpy";

type AndroidDeviceViewerProps = {
  deviceName: string;
  serial: string;
  sessionId: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error" | "unsupported";

type PendingClipboardRequest = {
  reject: (error: Error) => void;
  resolve: (text: string) => void;
  timeoutId: number;
};

type CanvasPoint = {
  deviceHeight: number;
  deviceWidth: number;
  x: number;
  y: number;
};

type PendingAndroidGesture = {
  longPressSent: boolean;
  longPressTimerId: number | null;
  moved: boolean;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startDeviceX: number;
  startDeviceY: number;
  startedAtMs: number;
};

const MIN_STREAM_BOUNDS = 160;
const ANDROID_CLIPBOARD_REQUEST_TIMEOUT_MS = 2_500;
// ws-scrcpy 1.19 does not push clipboard changes like modern scrcpy, so keep the
// fallback poll tight enough to feel responsive on real devices.
const ANDROID_DEVICE_CLIPBOARD_POLL_INTERVAL_MS = 250;
const ANDROID_FEEDBACK_TIMEOUT_MS = 2_200;
const ANDROID_GESTURE_LONG_PRESS_COMMAND_DURATION_MS = 560;
const ANDROID_GESTURE_LONG_PRESS_DELAY_MS = 420;
const ANDROID_GESTURE_MAX_SWIPE_DURATION_MS = 1_500;
const ANDROID_GESTURE_MIN_SWIPE_DURATION_MS = 80;
const ANDROID_GESTURE_TAP_SLOP_CSS_PX = 8;
const ANDROID_STREAM_CONNECT_TIMEOUT_MS = 3_000;
const ANDROID_STREAM_DECODER_STALL_TIMEOUT_MS = 3_500;
const ANDROID_STREAM_MAX_AUTO_RESTARTS = 8;
const ANDROID_STREAM_RESTART_BASE_DELAY_MS = 800;
const ANDROID_STREAM_RESTART_COOLDOWN_MS = 750;
const ANDROID_STREAM_RESTART_MAX_DELAY_MS = 5_000;
const ANDROID_STREAM_STALL_CHECK_INTERVAL_MS = 1_000;
const ANDROID_VIDEO_CHUNK_INTERVAL_US = 16_667;
const ANDROID_SPECIAL_KEY_MAP: Record<string, number> = {
  ArrowDown: ANDROID_KEYCODE_DPAD_DOWN,
  ArrowLeft: ANDROID_KEYCODE_DPAD_LEFT,
  ArrowRight: ANDROID_KEYCODE_DPAD_RIGHT,
  ArrowUp: ANDROID_KEYCODE_DPAD_UP,
  Backspace: 67,
  Enter: ANDROID_KEYCODE_ENTER,
  Escape: ANDROID_KEYCODE_ESCAPE,
  Tab: ANDROID_KEYCODE_TAB,
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getTargetBounds(element: HTMLElement | null): { height: number; width: number } {
  if (!element) {
    return { height: 480, width: 480 };
  }

  return {
    height: Math.max(MIN_STREAM_BOUNDS, element.clientHeight & ~15),
    width: Math.max(MIN_STREAM_BOUNDS, element.clientWidth & ~15),
  };
}

function getViewerNowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function AndroidDeviceViewer({ deviceName, serial, sessionId }: AndroidDeviceViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keyboardInputRef = useRef<HTMLTextAreaElement | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const bufferedPacketRef = useRef<Uint8Array | null>(null);
  const hasIdrRef = useRef(false);
  const hasPpsRef = useRef(false);
  const hasSpsRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const activeDisplayRef = useRef<AndroidDisplayInfo | null>(null);
  const activeVideoSettingsRef = useRef<AndroidVideoSettings | null>(null);
  const autoSyncedDeviceClipboardTextRef = useRef<string | null>(null);
  const hasObservedDeviceClipboardRef = useRef(false);
  const clipboardPollInFlightRef = useRef(false);
  const lastClipboardPollErrorRef = useRef<string | null>(null);
  const requestedBoundsRef = useRef<{ height: number; width: number } | null>(null);
  const pointerActiveRef = useRef(false);
  const pendingGestureRef = useRef<PendingAndroidGesture | null>(null);
  const deviceSizeRef = useRef({ height: 0, width: 0 });
  const keyboardActiveRef = useRef(false);
  const packetTimestampUsRef = useRef(0);
  const lastDecodedFrameAtRef = useRef<number | null>(null);
  const lastPacketAtRef = useRef<number | null>(null);
  const lastRestartAtRef = useRef(0);
  const restartRequestedRef = useRef(false);
  const autoRestartCountRef = useRef(0);
  const decoderCodecRef = useRef<string | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const pendingClipboardRequestRef = useRef<PendingClipboardRequest | null>(null);
  const controlQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastShortcutPasteAtRef = useRef(0);
  const restartTimerRef = useRef<number | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    supportsAndroidNativeViewer() ? "connecting" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState(deviceName);
  const [hasFrame, setHasFrame] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [interactionMessage, setInteractionMessage] = useState<string | null>(null);
  const [keyboardBridgeFocused, setKeyboardBridgeFocused] = useState(false);
  const showMobileViewerControls = useMemo(() => getMobileDeviceViewerControlsFlag(), []);
  const metrics = useMemo(
    () => createDeviceStreamMetrics({
      platform: "android",
      sessionId,
      streamProtocol: "webcodecs-h264",
    }),
    [sessionId],
  );

  const viewerWebSocketUrl = useMemo(
    () => buildAndroidViewerWebSocketUrl(api.runtimeBaseUrl, sessionId, serial),
    [serial, sessionId],
  );

  const clearPendingClipboardRequest = (errorMessage: string | null = null) => {
    const pendingRequest = pendingClipboardRequestRef.current;
    if (!pendingRequest) {
      return;
    }

    window.clearTimeout(pendingRequest.timeoutId);
    pendingClipboardRequestRef.current = null;
    if (errorMessage) {
      pendingRequest.reject(new Error(errorMessage));
    }
  };

  const requestStreamRestart = (reason: string, message: string) => {
    const now = getViewerNowMs();
    if (restartRequestedRef.current || now - lastRestartAtRef.current < ANDROID_STREAM_RESTART_COOLDOWN_MS) {
      return;
    }

    if (autoRestartCountRef.current >= ANDROID_STREAM_MAX_AUTO_RESTARTS) {
      metrics.flush("restart_aborted", {
        hadFrame: lastDecodedFrameAtRef.current != null,
        reason,
      });
      setConnectionState("error");
      setError(message);
      return;
    }

    restartRequestedRef.current = true;
    autoRestartCountRef.current += 1;
    lastRestartAtRef.current = now;
    clearPendingClipboardRequest("Android stream reconnecting.");
    if (restartTimerRef.current != null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    const retryDelayMs = Math.min(
      ANDROID_STREAM_RESTART_BASE_DELAY_MS * 2 ** Math.max(0, autoRestartCountRef.current - 1),
      ANDROID_STREAM_RESTART_MAX_DELAY_MS,
    );
    debugLog("android.viewer", "restart.requested", {
      autoRestartCount: autoRestartCountRef.current,
      hadFrame: lastDecodedFrameAtRef.current != null,
      reason,
      retryDelayMs,
      sessionId,
      serial,
    });
    metrics.flush("restart", {
      hadFrame: lastDecodedFrameAtRef.current != null,
      reason,
    });
    setConnectionState("connecting");
    setError(message);
    setHasFrame(false);
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      restartRequestedRef.current = false;
      setStreamAttempt((current) => current + 1);
    }, retryDelayMs);
  };

  const showInteractionFeedback = (message: string) => {
    setInteractionMessage(message);
    if (feedbackTimerRef.current != null) {
      window.clearTimeout(feedbackTimerRef.current);
    }

    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setInteractionMessage(null);
    }, ANDROID_FEEDBACK_TIMEOUT_MS);
  };

  const focusKeyboardBridge = () => {
    keyboardActiveRef.current = true;
    debugLog("android.viewer", "keyboard.focus.requested", {
      sessionId,
    });
    keyboardInputRef.current?.focus({
      preventScroll: true,
    });
  };

  const blurKeyboardBridge = () => {
    keyboardActiveRef.current = false;
    debugLog("android.viewer", "keyboard.blur.requested", {
      sessionId,
    });
    keyboardInputRef.current?.blur();
  };

  const clearKeyboardBridge = () => {
    const input = keyboardInputRef.current;
    if (!input) {
      return;
    }

    input.value = "";
    input.setSelectionRange(0, 0);
  };

  const clearPendingGesture = () => {
    const gesture = pendingGestureRef.current;
    if (gesture?.longPressTimerId != null) {
      window.clearTimeout(gesture.longPressTimerId);
    }
    pendingGestureRef.current = null;
    pointerActiveRef.current = false;
  };

  const getCanvasRelativePoint = (clientX: number, clientY: number): { xRatio: number; yRatio: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      xRatio: clamp((clientX - rect.left) / rect.width, 0, 1),
      yRatio: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const getCanvasStreamPoint = (clientX: number, clientY: number): CanvasPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const ratios = getCanvasRelativePoint(clientX, clientY);
    if (!ratios) {
      return null;
    }

    const deviceWidth = deviceSizeRef.current.width || canvas.width;
    const deviceHeight = deviceSizeRef.current.height || canvas.height;
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return null;
    }

    return {
      deviceHeight,
      deviceWidth,
      x: clamp(Math.round(ratios.xRatio * deviceWidth), 0, deviceWidth),
      y: clamp(Math.round(ratios.yRatio * deviceHeight), 0, deviceHeight),
    };
  };

  const getCanvasRuntimePoint = (clientX: number, clientY: number): CanvasPoint | null => {
    const activeDisplay = activeDisplayRef.current;
    if (!activeDisplay) {
      return getCanvasStreamPoint(clientX, clientY);
    }

    const ratios = getCanvasRelativePoint(clientX, clientY);
    if (!ratios) {
      return null;
    }

    const contentRect = activeDisplay.screenInfo?.contentRect;
    const left = contentRect?.left ?? 0;
    const top = contentRect?.top ?? 0;
    const right = contentRect?.right ?? activeDisplay.width;
    const bottom = contentRect?.bottom ?? activeDisplay.height;
    const deviceWidth = Math.max(1, right - left);
    const deviceHeight = Math.max(1, bottom - top);
    const maxX = Math.max(left, right - 1);
    const maxY = Math.max(top, bottom - 1);

    return {
      deviceHeight,
      deviceWidth,
      x: clamp(left + Math.round(ratios.xRatio * deviceWidth), left, maxX),
      y: clamp(top + Math.round(ratios.yRatio * deviceHeight), top, maxY),
    };
  };

  const enqueueRuntimeControl = (control: () => Promise<void>): Promise<void> => {
    const queuedControl = controlQueueRef.current
      .catch(() => {})
      .then(control);

    controlQueueRef.current = queuedControl.catch(() => {});
    return queuedControl;
  };

  const sendTapGesture = (x: number, y: number) => {
    metrics.markControl("gesture:runtime:tap");
    debugLog("android.viewer", "gesture.runtime.tap", {
      sessionId,
      x,
      y,
    });
    void enqueueRuntimeControl(() => api.sendDeviceControl(sessionId, {
      action: "tap",
      payload: {
        x,
        y,
      },
    })).catch((error) => {
      showInteractionFeedback(error instanceof Error ? error.message : "Failed to send Android tap input.");
    });
  };

  const sendSwipeGesture = (x1: number, y1: number, x2: number, y2: number, duration: number, reason: string) => {
    metrics.markControl(`gesture:runtime:${reason}`);
    debugLog("android.viewer", `gesture.runtime.${reason}`, {
      duration,
      sessionId,
      x1,
      x2,
      y1,
      y2,
    });
    void enqueueRuntimeControl(() => api.sendDeviceControl(sessionId, {
      action: "swipe",
      payload: {
        duration,
        x1,
        x2,
        y1,
        y2,
      },
    })).catch((error) => {
      showInteractionFeedback(error instanceof Error ? error.message : "Failed to send Android swipe input.");
    });
  };

  const sendTextInput = async (text: string): Promise<boolean> => {
    const normalizedText = text.replace(/\r\n/g, "\n");
    if (normalizedText.length === 0) {
      return false;
    }

    metrics.markControl("text:runtime");
    debugLog("android.viewer", "control.text.start", {
      charCount: normalizedText.length,
      preview: normalizedText.slice(0, 64),
      sessionId,
    });
    await enqueueRuntimeControl(() => api.sendDeviceControl(sessionId, {
      action: "text",
      payload: {
        text: normalizedText,
      },
    }));
    debugLog("android.viewer", "control.text.success", {
      charCount: normalizedText.length,
      sessionId,
    });
    return true;
  };

  const writeDeviceClipboard = async (text: string, paste = false): Promise<boolean> => {
    if (text.length === 0) {
      return false;
    }

    metrics.markControl(paste ? "clipboard:set_and_paste" : "clipboard:set");
    debugLog("android.viewer", "control.clipboard_set.start", {
      charCount: text.length,
      paste,
      preview: text.slice(0, 64),
      sessionId,
    });
    const transport = await writeAndroidClipboardWithFallback({
      api,
      paste,
      sessionId,
      socket: websocketRef.current,
      text,
    });
    debugLog("android.viewer", "control.clipboard_set.success", {
      charCount: text.length,
      paste,
      sessionId,
      transport,
    });
    autoSyncedDeviceClipboardTextRef.current = text;
    hasObservedDeviceClipboardRef.current = true;
    lastClipboardPollErrorRef.current = null;
    return true;
  };

  const requestDeviceClipboard = (): Promise<string> => {
    const ws = websocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Android control channel is unavailable."));
    }

    clearPendingClipboardRequest("Superseded by a newer Android clipboard request.");

    return new Promise<string>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (pendingClipboardRequestRef.current?.timeoutId !== timeoutId) {
          return;
        }

        pendingClipboardRequestRef.current = null;
        reject(new Error("Timed out waiting for the Android clipboard."));
      }, ANDROID_CLIPBOARD_REQUEST_TIMEOUT_MS);

      pendingClipboardRequestRef.current = {
        reject,
        resolve,
        timeoutId,
      };

      metrics.markControl("clipboard:get");
      ws.send(buildAndroidGetClipboardMessage());
    });
  };

  const readHostClipboardText = async (): Promise<string> => {
    try {
      return await api.readHostClipboard();
    } catch (runtimeError) {
      if (typeof navigator === "undefined" || typeof navigator.clipboard?.readText !== "function") {
        throw runtimeError instanceof Error ? runtimeError : new Error("Host clipboard read is unavailable.");
      }

      try {
        return await navigator.clipboard.readText();
      } catch (browserError) {
        if (runtimeError instanceof Error) {
          throw runtimeError;
        }
        throw browserError;
      }
    }
  };

  const writeHostClipboardText = async (text: string): Promise<void> => {
    try {
      await api.writeHostClipboard(text);
      return;
    } catch (runtimeError) {
      if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
        throw runtimeError instanceof Error ? runtimeError : new Error("Host clipboard write is unavailable.");
      }

      try {
        await navigator.clipboard.writeText(text);
      } catch (browserError) {
        if (runtimeError instanceof Error) {
          throw runtimeError;
        }
        throw browserError;
      }
    }
  };

  const autoSyncDeviceClipboardToHost = async (text: string) => {
    if (autoSyncedDeviceClipboardTextRef.current === text) {
      return;
    }

    await writeHostClipboardText(text);
    autoSyncedDeviceClipboardTextRef.current = text;
    hasObservedDeviceClipboardRef.current = true;
    debugLog("android.viewer", "clipboard.autosync_from_device.success", {
      charCount: text.length,
      sessionId,
    });
  };

  const pollDeviceClipboardForAutosync = async () => {
    if (clipboardPollInFlightRef.current) {
      return;
    }

    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    clipboardPollInFlightRef.current = true;
    try {
      const text = await api.readAndroidClipboard(sessionId);
      lastClipboardPollErrorRef.current = null;

      if (!hasObservedDeviceClipboardRef.current) {
        autoSyncedDeviceClipboardTextRef.current = text;
        hasObservedDeviceClipboardRef.current = true;
        return;
      }

      if (autoSyncedDeviceClipboardTextRef.current === text) {
        return;
      }

      await autoSyncDeviceClipboardToHost(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (lastClipboardPollErrorRef.current !== message) {
        lastClipboardPollErrorRef.current = message;
        debugLog("android.viewer", "clipboard.autosync_poll.error", {
          message,
          sessionId,
        });
      }
    } finally {
      clipboardPollInFlightRef.current = false;
    }
  };

  const handleCopyFromDeviceClipboard = async () => {
    debugLog("android.viewer", "clipboard.copy_from_device.start", {
      sessionId,
    });
    try {
      const { text, transport } = await readAndroidClipboardWithFallback({
        api,
        requestFromViewer: requestDeviceClipboard,
        sessionId,
      });
      await writeHostClipboardText(text);
      focusKeyboardBridge();
      debugLog("android.viewer", "clipboard.copy_from_device.success", {
        charCount: text.length,
        sessionId,
        transport,
      });
      showInteractionFeedback(text.length > 0 ? "Copied Android clipboard." : "Android clipboard is empty.");
    } catch (copyError) {
      debugLog("android.viewer", "clipboard.copy_from_device.error", {
        message: copyError instanceof Error ? copyError.message : String(copyError),
        sessionId,
      });
      showInteractionFeedback(copyError instanceof Error ? copyError.message : "Failed to copy Android clipboard.");
    }
  };

  const handlePasteFromHostClipboard = async () => {
    debugLog("android.viewer", "clipboard.paste_from_host.start", {
      sessionId,
    });
    try {
      const text = await readHostClipboardText();
      if (text.length === 0) {
        showInteractionFeedback("Host clipboard is empty.");
        return;
      }

      await writeDeviceClipboard(text, true);
      focusKeyboardBridge();
      debugLog("android.viewer", "clipboard.paste_from_host.success", {
        charCount: text.length,
        pasteMode: "runtime_clipboard_keycode_paste",
        sessionId,
      });
      showInteractionFeedback("Pasted host clipboard into Android.");
    } catch (pasteError) {
      debugLog("android.viewer", "clipboard.paste_from_host.error", {
        message: pasteError instanceof Error ? pasteError.message : String(pasteError),
        sessionId,
      });
      showInteractionFeedback(pasteError instanceof Error ? pasteError.message : "Failed to read the host clipboard.");
    }
  };

  const wasShortcutPasteHandledRecently = (): boolean => Date.now() - lastShortcutPasteAtRef.current < 300;

  const pastePlainTextToDevice = (text: string) => {
    if (text.length === 0) {
      return;
    }

    void writeDeviceClipboard(text, true).then(() => {
      showInteractionFeedback("Pasted host clipboard into Android.");
    }).catch((error) => {
      showInteractionFeedback(error instanceof Error ? error.message : "Failed to paste the host clipboard into Android.");
    });
  };

  useEffect(() => () => {
    keyboardActiveRef.current = false;
    clipboardPollInFlightRef.current = false;
    hasObservedDeviceClipboardRef.current = false;
    lastClipboardPollErrorRef.current = null;
    if (feedbackTimerRef.current != null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    if (restartTimerRef.current != null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }

    clearPendingGesture();
    clearPendingClipboardRequest("Android clipboard request cancelled.");
  }, []);

  useEffect(() => {
    if (!supportsAndroidNativeViewer() || typeof window === "undefined") {
      return;
    }

    autoSyncedDeviceClipboardTextRef.current = null;
    hasObservedDeviceClipboardRef.current = false;
    lastClipboardPollErrorRef.current = null;

    const poll = () => {
      void pollDeviceClipboardForAutosync();
    };

    poll();

    const intervalId = window.setInterval(poll, ANDROID_DEVICE_CLIPBOARD_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        poll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [connectionState, sessionId]);

  useEffect(() => {
    if (!viewerExpanded || typeof document === "undefined") {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [viewerExpanded]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node | null)) {
        return;
      }

      blurKeyboardBridge();
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, []);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      if (rootRef.current?.contains(target)) {
        return false;
      }

      const tagName = target.tagName.toLowerCase();
      return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!keyboardActiveRef.current || isEditableTarget(event.target) || event.isComposing) {
        return;
      }

      const clipboardShortcutAction = getAndroidClipboardShortcutAction({
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        key: event.key,
        metaKey: event.metaKey,
      });
      if (clipboardShortcutAction === "copy_from_device") {
        event.preventDefault();
        void handleCopyFromDeviceClipboard();
        return;
      }

      if (clipboardShortcutAction === "paste_to_device") {
        lastShortcutPasteAtRef.current = Date.now();
        event.preventDefault();
        void handlePasteFromHostClipboard();
        return;
      }

      if (event.altKey) {
        return;
      }

      const specialKeyCode = ANDROID_SPECIAL_KEY_MAP[event.key];
      if (specialKeyCode != null) {
        event.preventDefault();
        clearKeyboardBridge();
        sendKeyPress(specialKeyCode);
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      event.preventDefault();
      void sendTextInput(event.key).catch((error) => {
        showInteractionFeedback(error instanceof Error ? error.message : "Failed to send Android text input.");
      });
      clearKeyboardBridge();
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (!keyboardActiveRef.current || isEditableTarget(event.target)) {
        return;
      }

      if (wasShortcutPasteHandledRecently()) {
        event.preventDefault();
        clearKeyboardBridge();
        return;
      }

      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      pastePlainTextToDevice(pastedText);
      clearKeyboardBridge();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("paste", handlePaste, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("paste", handlePaste, true);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!supportsAndroidNativeViewer()) {
      return;
    }

    restartRequestedRef.current = false;
    lastRestartAtRef.current = 0;
    packetTimestampUsRef.current = 0;
    lastDecodedFrameAtRef.current = null;
    lastPacketAtRef.current = null;
    decoderCodecRef.current = null;
    metrics.markConnectStart({
      serial,
      streamAttempt,
      viewerWebSocketUrl,
    });
    debugLog("android.viewer", "connect.start", {
      serial,
      sessionId,
      streamAttempt,
      viewerWebSocketUrl,
    });
    debugLog("android.viewer", "lifecycle.mount", {
      serial,
      sessionId,
      streamAttempt,
    });

    let disposed = false;
    let loggedFirstFrame = false;
    let loggedFirstPacket = false;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      setConnectionState("error");
      setError("Unable to initialize Android viewer canvas.");
      return;
    }

    const createDecoder = () => new VideoDecoder({
      output: (frame) => {
        if (disposed) {
          frame.close();
          return;
        }

        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        lastDecodedFrameAtRef.current = getViewerNowMs();
        if (restartTimerRef.current != null) {
          window.clearTimeout(restartTimerRef.current);
          restartTimerRef.current = null;
          restartRequestedRef.current = false;
        }
        autoRestartCountRef.current = 0;
        deviceSizeRef.current = { height: canvas.height, width: canvas.width };
        metrics.markFrame({
          height: canvas.height,
          width: canvas.width,
        });
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          debugLog("android.viewer", "decoder.output.first_frame", {
            displayHeight: canvas.height,
            displayWidth: canvas.width,
            sessionId,
          });
        }
        setConnectionState("connected");
        setHasFrame(true);
        setError(null);
      },
      error: (decodeError) => {
        if (disposed) {
          return;
        }

        debugLog("android.viewer", "decoder.output.error", {
          message: decodeError.message,
          sessionId,
        });
        requestStreamRestart("decoder_output_error", decodeError.message || "Failed to decode Android stream.");
      },
    });

    let decoder: VideoDecoder;
    try {
      decoder = createDecoder();
    } catch (decodeError) {
      setConnectionState("error");
      setError(
        decodeError instanceof Error
          ? decodeError.message
          : "Failed to initialize Android stream decoder.",
      );
      return;
    }

    decoderRef.current = decoder;
    setConnectionState("connecting");
    setHasFrame(false);
    setError(null);
    hasIdrRef.current = false;
    hasPpsRef.current = false;
    hasSpsRef.current = false;
    bufferedPacketRef.current = null;
    activeDisplayRef.current = null;
    activeVideoSettingsRef.current = null;
    requestedBoundsRef.current = null;

    const configureDecoder = (decoderConfig: { codec: string; height: number; width: number }) => {
      const config = {
        codec: decoderConfig.codec,
        hardwareAcceleration: "prefer-hardware" as const,
        optimizeForLatency: true as const,
      };
      const activeDecoder = decoderRef.current;
      if (!activeDecoder) {
        return null;
      }

      if (activeDecoder.state === "configured" && decoderCodecRef.current === decoderConfig.codec) {
        return activeDecoder;
      }

      try {
        if (activeDecoder.state === "closed") {
          throw new Error("Android decoder is closed.");
        }

        debugLog("android.viewer", "decoder.configure.start", {
          codec: decoderConfig.codec,
          replaced: false,
          sessionId,
        });
        activeDecoder.configure(config);
        decoderCodecRef.current = decoderConfig.codec;
        debugLog("android.viewer", "decoder.configure.success", {
          codec: decoderConfig.codec,
          decoderState: activeDecoder.state,
          replaced: false,
          sessionId,
        });
        return activeDecoder;
      } catch {
        try {
          activeDecoder.close();
        } catch {
          // Ignore close failures while replacing the decoder instance.
        }

        try {
          const replacement = createDecoder();
          debugLog("android.viewer", "decoder.configure.start", {
            codec: decoderConfig.codec,
            replaced: true,
            sessionId,
          });
          replacement.configure(config);
          decoderRef.current = replacement;
          decoderCodecRef.current = decoderConfig.codec;
          debugLog("android.viewer", "decoder.configure.success", {
            codec: decoderConfig.codec,
            decoderState: replacement.state,
            replaced: true,
            sessionId,
          });
          return replacement;
        } catch (decodeError) {
          debugLog("android.viewer", "decoder.configure.error", {
            codec: decoderConfig.codec,
            message: decodeError instanceof Error ? decodeError.message : String(decodeError),
            sessionId,
          });
          setConnectionState("error");
          setError(
            decodeError instanceof Error
              ? decodeError.message
              : "Failed to reinitialize Android stream decoder.",
          );
          return null;
        }
      }
    };

    const sendVideoSettings = () => {
      const ws = websocketRef.current;
      const activeDisplay = activeDisplayRef.current;
      const currentSettings = activeVideoSettingsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !activeDisplay || !currentSettings) {
        return;
      }

      const bounds = getTargetBounds(containerRef.current);
      const previous = requestedBoundsRef.current;
      if (previous && previous.width === bounds.width && previous.height === bounds.height) {
        return;
      }

      requestedBoundsRef.current = bounds;
      const nextSettings: AndroidVideoSettings = {
        ...currentSettings,
        displayId: activeDisplay.displayId,
        height: bounds.height,
        width: bounds.width,
      };
      activeVideoSettingsRef.current = nextSettings;
      debugLog("android.viewer", "video_settings.sent", {
        bounds,
        displayId: activeDisplay.displayId,
        sessionId,
      });
      ws.send(buildAndroidVideoSettingsMessage(nextSettings));
    };

    const websocket = new WebSocket(viewerWebSocketUrl);
    websocket.binaryType = "arraybuffer";
    websocketRef.current = websocket;

    websocket.onopen = () => {
      if (disposed) {
        return;
      }

      debugLog("android.viewer", "socket.open", {
        sessionId,
        serial,
      });
      setConnectionState("connecting");
      setError(null);
    };

    websocket.onmessage = (event) => {
      if (disposed) {
        return;
      }

      const handleBinaryPacket = (buffer: ArrayBuffer) => {
        if (disposed) {
          return;
        }

        if (isAndroidInitialPacket(buffer)) {
          const initialPacket = parseAndroidInitialPacket(buffer);
          setDeviceLabel(initialPacket.deviceName || deviceName);

          const activeDisplay = initialPacket.displays[0] ?? null;
          if (!activeDisplay) {
            setConnectionState("error");
            setError("scrcpy stream started without display metadata.");
            return;
          }

          activeDisplayRef.current = activeDisplay;
          deviceSizeRef.current = {
            height: activeDisplay.screenInfo?.videoHeight ?? activeDisplay.height,
            width: activeDisplay.screenInfo?.videoWidth ?? activeDisplay.width,
          };
          activeVideoSettingsRef.current = activeDisplay.videoSettings ?? createDefaultAndroidVideoSettings(
            activeDisplay.displayId,
            activeDisplay.width,
            activeDisplay.height,
          );
          debugLog("android.viewer", "initial_packet.received", {
            displayHeight: activeDisplay.height,
            displayWidth: activeDisplay.width,
            deviceName: initialPacket.deviceName || deviceName,
            screenHeight: activeDisplay.screenInfo?.videoHeight ?? null,
            screenWidth: activeDisplay.screenInfo?.videoWidth ?? null,
            sessionId,
          });
          sendVideoSettings();
          return;
        }

        if (isAndroidDeviceMessagePacket(buffer)) {
          const deviceMessage = parseAndroidDeviceMessage(buffer);
          if (deviceMessage?.type === "clipboard") {
            const pendingRequest = pendingClipboardRequestRef.current;
            if (pendingRequest) {
              window.clearTimeout(pendingRequest.timeoutId);
              pendingClipboardRequestRef.current = null;
              pendingRequest.resolve(deviceMessage.text);
            } else {
              void autoSyncDeviceClipboardToHost(deviceMessage.text).catch((error) => {
                debugLog("android.viewer", "clipboard.autosync_from_device.error", {
                  message: error instanceof Error ? error.message : String(error),
                  sessionId,
                });
              });
            }
          }
          return;
        }

        const packet = new Uint8Array(buffer);
        const packetType = getAndroidVideoPacketType(packet);
        if (packetType == null) {
          return;
        }

        lastPacketAtRef.current = getViewerNowMs();
        if (!loggedFirstPacket) {
          loggedFirstPacket = true;
          debugLog("android.viewer", "decoder.packet.first", {
            packetType,
            sessionId,
          });
        }

        const decoderConfig = parseAndroidVideoPacketConfig(packet);
        if (decoderConfig) {
          if (canvas.width !== decoderConfig.width || canvas.height !== decoderConfig.height) {
            canvas.width = decoderConfig.width;
            canvas.height = decoderConfig.height;
          }

          if (!configureDecoder(decoderConfig)) {
            return;
          }

          hasIdrRef.current = false;
          hasSpsRef.current = true;
          hasPpsRef.current = false;
          bufferedPacketRef.current = packet;
          return;
        }

        if (packetType === 8) {
          bufferedPacketRef.current = bufferedPacketRef.current
            ? (() => {
              const merged = new Uint8Array(bufferedPacketRef.current.length + packet.length);
              merged.set(bufferedPacketRef.current);
              merged.set(packet, bufferedPacketRef.current.length);
              return merged;
            })()
            : packet;
          hasPpsRef.current = true;
          return;
        }

        if (packetType === 6 && (!hasSpsRef.current || !hasPpsRef.current)) {
          return;
        }

        const bufferedPacket = bufferedPacketRef.current
          ? (() => {
            const merged = new Uint8Array(bufferedPacketRef.current.length + packet.length);
            merged.set(bufferedPacketRef.current);
            merged.set(packet, bufferedPacketRef.current.length);
            return merged;
          })()
          : packet;

        bufferedPacketRef.current = bufferedPacket;
        hasIdrRef.current = hasIdrRef.current || isAndroidVideoKeyPacket(packetType);
        const activeDecoder = decoderRef.current;
        const chunkType = getAndroidEncodedVideoChunkType(packetType);
        if (!chunkType || !activeDecoder || activeDecoder.state !== "configured" || !hasIdrRef.current) {
          return;
        }

        if (chunkType === "delta" && activeDecoder.decodeQueueSize > 0) {
          bufferedPacketRef.current = null;
          hasSpsRef.current = false;
          hasPpsRef.current = false;
          return;
        }

        bufferedPacketRef.current = null;
        hasSpsRef.current = false;
        hasPpsRef.current = false;
        packetTimestampUsRef.current = Math.max(
          packetTimestampUsRef.current + ANDROID_VIDEO_CHUNK_INTERVAL_US,
          Math.round(getViewerNowMs() * 1_000),
        );

        try {
          activeDecoder.decode(new EncodedVideoChunk({
            data: bufferedPacket,
            timestamp: packetTimestampUsRef.current,
            type: chunkType,
          }));
        } catch (decodeError) {
          debugLog("android.viewer", "decoder.packet.error", {
            chunkType,
            decodeQueueSize: activeDecoder.decodeQueueSize,
            message: decodeError instanceof Error ? decodeError.message : String(decodeError),
            packetType,
            sessionId,
          });
          requestStreamRestart(
            "decoder_decode_error",
            decodeError instanceof Error ? decodeError.message : "Failed to decode Android stream.",
          );
        }
      };

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(handleBinaryPacket).catch(() => {
          if (disposed) {
            return;
          }

          requestStreamRestart("blob_read_error", "Android websocket stream failed.");
        });
        return;
      }

      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }

      handleBinaryPacket(event.data);
    };

    websocket.onerror = () => {
      if (disposed) {
        return;
      }

      debugLog("android.viewer", "socket.error", {
        sessionId,
        serial,
      });
      requestStreamRestart("socket_error", "Android websocket stream failed.");
    };

    websocket.onclose = (closeEvent) => {
      if (disposed) {
        return;
      }

      if (restartRequestedRef.current) {
        return;
      }

      debugLog("android.viewer", "socket.close", {
        code: closeEvent.code,
        reason: closeEvent.reason,
        sessionId,
        wasClean: closeEvent.wasClean,
      });
      clearPendingClipboardRequest("Android control channel closed.");
      requestStreamRestart(
        "socket_close",
        closeEvent.reason || "Android websocket stream closed unexpectedly.",
      );
    };

    const startupTimer = window.setTimeout(() => {
      if (disposed || lastDecodedFrameAtRef.current != null) {
        return;
      }

      debugLog("android.viewer", "decoder.startup.timeout", {
        sessionId,
        serial,
      });
      requestStreamRestart("startup_timeout", "Android stream is taking too long to start. Reconnecting...");
    }, ANDROID_STREAM_CONNECT_TIMEOUT_MS);

    const stallTimer = window.setInterval(() => {
      if (disposed) {
        return;
      }

      const ws = websocketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const now = getViewerNowMs();
      const lastFrameAt = lastDecodedFrameAtRef.current;
      const lastPacketAt = lastPacketAtRef.current;

      if (
        lastFrameAt != null
        && lastPacketAt != null
        && lastPacketAt > lastFrameAt
        && now - lastFrameAt >= ANDROID_STREAM_DECODER_STALL_TIMEOUT_MS
      ) {
        debugLog("android.viewer", "decoder.stall", {
          lastFrameAgoMs: Math.round(now - lastFrameAt),
          lastPacketAgoMs: Math.round(now - lastPacketAt),
          sessionId,
        });
        requestStreamRestart("decoder_stall", "Android stream stalled. Reconnecting...");
      }
    }, ANDROID_STREAM_STALL_CHECK_INTERVAL_MS);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimerRef.current != null) {
          window.clearTimeout(resizeTimerRef.current);
        }
        resizeTimerRef.current = window.setTimeout(() => {
          resizeTimerRef.current = null;
          sendVideoSettings();
        }, 120);
      });

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
    }

    return () => {
      disposed = true;
      debugLog("android.viewer", "lifecycle.cleanup", {
        hadFrame: deviceSizeRef.current.width > 0 && deviceSizeRef.current.height > 0,
        sessionId,
        streamAttempt,
      });
      metrics.flush("cleanup", {
        hadFrame: deviceSizeRef.current.width > 0 && deviceSizeRef.current.height > 0,
      });
      window.clearTimeout(startupTimer);
      window.clearInterval(stallTimer);
      resizeObserver?.disconnect();
      if (resizeTimerRef.current != null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      clearPendingGesture();
      clearPendingClipboardRequest("Android control channel closed.");
      websocket.close();
      websocketRef.current = null;
      const activeDecoder = decoderRef.current ?? decoder;
      if (activeDecoder.state !== "closed") {
        activeDecoder.close();
      }
      decoderRef.current = null;
      decoderCodecRef.current = null;
    };
  }, [deviceName, metrics, serial, streamAttempt, viewerWebSocketUrl]);

  const sendKeyPress = (keycode: number) => {
    metrics.markControl(`keycode:runtime:${keycode}`);
    debugLog("android.viewer", "control.key.start", {
      keycode,
      sessionId,
    });
    void enqueueRuntimeControl(() => api.sendDeviceControl(sessionId, {
      action: "key",
      payload: {
        keycode,
      },
    })).catch((error) => {
      showInteractionFeedback(error instanceof Error ? error.message : "Failed to send Android key input.");
    });
  };

  const sendScrollEvent = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const ws = websocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const point = getCanvasStreamPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    ws.send(buildAndroidScrollMessage({
      hScroll: event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0,
      screenHeight: point.deviceHeight,
      screenWidth: point.deviceWidth,
      vScroll: event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0,
      x: point.x,
      y: point.y,
    }));
    event.preventDefault();
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType !== "touch") {
      return;
    }

    const point = getCanvasRuntimePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    clearPendingGesture();
    pointerActiveRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);

    const gesture: PendingAndroidGesture = {
      longPressSent: false,
      longPressTimerId: null,
      moved: false,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startDeviceX: point.x,
      startDeviceY: point.y,
      startedAtMs: getViewerNowMs(),
    };

    gesture.longPressTimerId = window.setTimeout(() => {
      const activeGesture = pendingGestureRef.current;
      if (!activeGesture || activeGesture.pointerId !== gesture.pointerId || activeGesture.moved || activeGesture.longPressSent) {
        return;
      }

      activeGesture.longPressSent = true;
      activeGesture.longPressTimerId = null;
      sendSwipeGesture(
        activeGesture.startDeviceX,
        activeGesture.startDeviceY,
        activeGesture.startDeviceX,
        activeGesture.startDeviceY,
        ANDROID_GESTURE_LONG_PRESS_COMMAND_DURATION_MS,
        "long_press",
      );
    }, ANDROID_GESTURE_LONG_PRESS_DELAY_MS);

    pendingGestureRef.current = gesture;
    event.preventDefault();

    if (!showMobileViewerControls && event.button === 0) {
      focusKeyboardBridge();
    }
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pendingGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.longPressSent) {
      return;
    }

    const distance = Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY);
    if (distance <= ANDROID_GESTURE_TAP_SLOP_CSS_PX) {
      return;
    }

    gesture.moved = true;
    if (gesture.longPressTimerId != null) {
      window.clearTimeout(gesture.longPressTimerId);
      gesture.longPressTimerId = null;
    }
    event.preventDefault();
  };

  const finishCanvasGesture = (
    event: React.PointerEvent<HTMLCanvasElement>,
    cancelled: boolean,
  ) => {
    const gesture = pendingGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    pendingGestureRef.current = null;
    pointerActiveRef.current = false;

    if (gesture.longPressTimerId != null) {
      window.clearTimeout(gesture.longPressTimerId);
    }

    if (cancelled || gesture.longPressSent) {
      event.preventDefault();
      return;
    }

    const point = getCanvasRuntimePoint(event.clientX, event.clientY) ?? {
      deviceHeight: 0,
      deviceWidth: 0,
      x: gesture.startDeviceX,
      y: gesture.startDeviceY,
    };
    const distance = Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY);
    if (distance <= ANDROID_GESTURE_TAP_SLOP_CSS_PX) {
      sendTapGesture(gesture.startDeviceX, gesture.startDeviceY);
      event.preventDefault();
      return;
    }

    const duration = clamp(
      Math.round(getViewerNowMs() - gesture.startedAtMs),
      ANDROID_GESTURE_MIN_SWIPE_DURATION_MS,
      ANDROID_GESTURE_MAX_SWIPE_DURATION_MS,
    );
    sendSwipeGesture(
      gesture.startDeviceX,
      gesture.startDeviceY,
      point.x,
      point.y,
      duration,
      "swipe",
    );
    event.preventDefault();
  };

  const handleCanvasPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    finishCanvasGesture(event, false);
  };

  const handleCanvasPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    finishCanvasGesture(event, true);
  };

  const handleKeyboardInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const text = event.currentTarget.value;
    if (text.length === 0) {
      return;
    }

    debugLog("android.viewer", "keyboard.input", {
      charCount: text.length,
      preview: text.slice(0, 64),
      sessionId,
    });
    void sendTextInput(text).catch((error) => {
      showInteractionFeedback(error instanceof Error ? error.message : "Failed to send Android text input.");
    });
    clearKeyboardBridge();
  };

  const handleKeyboardPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (wasShortcutPasteHandledRecently()) {
      event.preventDefault();
      clearKeyboardBridge();
      return;
    }

    const pastedText = event.clipboardData.getData("text/plain");
    event.preventDefault();
    pastePlainTextToDevice(pastedText);
    clearKeyboardBridge();
  };

  const statusLabel = connectionState === "connected"
    ? "Live"
    : connectionState === "connecting"
      ? "Connecting"
      : connectionState === "unsupported"
        ? "Unsupported"
        : connectionState === "disconnected"
          ? "Disconnected"
          : "Error";

  return (
    <div
      ref={rootRef}
      data-device-viewer="android-native"
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(96,165,250,0.16),_transparent_48%),linear-gradient(180deg,_rgba(9,9,11,0.96),_rgba(2,6,23,0.98))]",
        viewerExpanded && "fixed inset-0 z-[90]",
      )}
    >
      <textarea
        ref={keyboardInputRef}
        aria-label="Android keyboard bridge"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
        enterKeyHint="done"
        inputMode="text"
        spellCheck={false}
        tabIndex={-1}
        onBlur={() => {
          clearKeyboardBridge();
          setKeyboardBridgeFocused(false);
        }}
        onFocus={() => {
          keyboardActiveRef.current = true;
          setKeyboardBridgeFocused(true);
        }}
        onInput={handleKeyboardInput}
        onPaste={handleKeyboardPaste}
      />

      <div className="absolute left-4 top-4 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

      {interactionMessage ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
          <div className="rounded-full border border-white/10 bg-black/55 px-3 py-1 text-[11px] font-medium text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] backdrop-blur-md">
            {interactionMessage}
          </div>
        </div>
      ) : null}

      <div className="absolute right-4 top-4 z-20 flex items-center gap-1">
        {showMobileViewerControls ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white"
            aria-label={viewerExpanded ? "Exit Android fullscreen" : "Android fullscreen"}
            title={viewerExpanded ? "Exit Android fullscreen" : "Android fullscreen"}
            onClick={() => setViewerExpanded((current) => !current)}
          >
            {viewerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white"
          aria-label="Android Power"
          title="Android Power"
          onClick={() => sendKeyPress(ANDROID_KEYCODE_POWER)}
        >
          <Power className="h-4 w-4" />
        </Button>
      </div>

      <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <canvas
          ref={canvasRef}
          className="block max-h-full max-w-full touch-none rounded-[22px] bg-black shadow-[0_24px_90px_rgba(0,0,0,0.55)] outline-none"
          tabIndex={-1}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={handleCanvasPointerCancel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onWheel={sendScrollEvent}
        />

        {!hasFrame ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/18 px-6 text-center">
            {connectionState === "unsupported" ? (
              <Smartphone className="h-8 w-8 text-white/70" />
            ) : (
              <LoaderCircle className="h-8 w-8 animate-spin text-white/80" />
            )}
            <div>
              <p className="text-sm font-semibold text-white">{deviceLabel}</p>
              <p className="mt-1 text-xs leading-5 text-white/65">
                {error ?? (connectionState === "unsupported"
                  ? "Browser ini belum mendukung Android stream native via WebCodecs."
                  : "Menyambungkan stream Android langsung ke panel ini.")}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 px-3 pb-3 pt-1">
        <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Android Back"
            onClick={() => sendKeyPress(ANDROID_KEYCODE_BACK)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Android Home"
            onClick={() => sendKeyPress(ANDROID_KEYCODE_HOME)}
          >
            <House className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Android Overview"
            onClick={() => sendKeyPress(ANDROID_KEYCODE_APP_SWITCH)}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white",
              keyboardBridgeFocused && "bg-white/12 text-white",
            )}
            aria-label={keyboardBridgeFocused ? "Hide Android keyboard bridge" : "Show Android keyboard bridge"}
            onClick={() => {
              if (keyboardBridgeFocused) {
                blurKeyboardBridge();
                return;
              }

              focusKeyboardBridge();
            }}
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Copy Android clipboard"
            title="Copy Android clipboard"
            onClick={() => void handleCopyFromDeviceClipboard()}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Paste host clipboard into Android"
            title="Paste host clipboard into Android"
            onClick={() => void handlePasteFromHostClipboard()}
          >
            <Clipboard className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
