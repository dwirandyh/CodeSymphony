import { useEffect, useMemo, useRef, useState } from "react";
import { House, LoaderCircle, Lock, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";

type IosSimulatorViewerProps = {
  deviceName: string;
  nativeBaseUrl?: string | null;
  platformSessionId?: string | null;
  sessionId: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
type MediaMode = "live" | "fallback";

type DragState = {
  startAt: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
};

type IosStatusResponse = {
  session_info?: {
    device_height?: number;
    device_width?: number;
  };
};

type IosVideoFrame = {
  data: string;
  pixel_height?: number;
  pixel_width?: number;
  point_height?: number;
  point_width?: number;
  type?: string;
};

type IosControlPayload = Record<string, number | string>;

const FALLBACK_SCREENSHOT_POLL_INTERVAL_MS = 1_250;
const FALLBACK_REFRESH_AFTER_ACTION_MS = [120, 700];
const IOS_SPECIAL_KEY_MAP: Record<string, string> = {
  Backspace: "DELETE",
  Enter: "RETURN",
  Escape: "ESCAPE",
  Tab: "TAB",
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

function supportsIosLiveViewer(): boolean {
  return typeof window !== "undefined" && typeof WebSocket === "function";
}

function buildDirectIosWebSocketUrl(baseUrl: string, platformSessionId: string, channel: "control" | "video"): string {
  const websocketBase = new URL(baseUrl);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`/ws/${encodeURIComponent(platformSessionId)}/${channel}`, websocketBase).toString();
}

function buildIosViewerUrls(args: {
  nativeBaseUrl?: string | null;
  platformSessionId?: string | null;
  sessionId: string;
}) {
  const { nativeBaseUrl, platformSessionId, sessionId } = args;
  const httpBase = new URL(api.runtimeBaseUrl);
  const websocketBase = new URL(api.runtimeBaseUrl);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  const encodedSessionId = encodeURIComponent(sessionId);
  const hasDirectWebSocketTarget = typeof nativeBaseUrl === "string"
    && nativeBaseUrl.length > 0
    && typeof platformSessionId === "string"
    && platformSessionId.length > 0;

  return {
    control: hasDirectWebSocketTarget
      ? buildDirectIosWebSocketUrl(nativeBaseUrl, platformSessionId, "control")
      : new URL(`/api/device-streams/${encodedSessionId}/native/control`, websocketBase).toString(),
    screenshot: new URL(`/api/device-streams/${encodedSessionId}/native/screenshot`, httpBase).toString(),
    status: new URL(`/api/device-streams/${encodedSessionId}/native/status`, httpBase).toString(),
    video: hasDirectWebSocketTarget
      ? buildDirectIosWebSocketUrl(nativeBaseUrl, platformSessionId, "video")
      : new URL(`/api/device-streams/${encodedSessionId}/native/video`, websocketBase).toString(),
  };
}

function getContainedContentBox(
  boundsHeight: number,
  boundsWidth: number,
  contentHeight: number,
  contentWidth: number,
): { height: number; left: number; top: number; width: number } {
  const safeBoundsWidth = Math.max(boundsWidth, 1);
  const safeBoundsHeight = Math.max(boundsHeight, 1);
  const safeContentWidth = Math.max(contentWidth, 1);
  const safeContentHeight = Math.max(contentHeight, 1);
  const boundsRatio = safeBoundsWidth / safeBoundsHeight;
  const contentRatio = safeContentWidth / safeContentHeight;

  if (contentRatio >= boundsRatio) {
    const width = safeBoundsWidth;
    const height = width / contentRatio;
    return {
      height,
      left: 0,
      top: (safeBoundsHeight - height) / 2,
      width,
    };
  }

  const height = safeBoundsHeight;
  const width = height * contentRatio;
  return {
    height,
    left: (safeBoundsWidth - width) / 2,
    top: 0,
    width,
  };
}

function mapClientPointToDevice(args: {
  clientX: number;
  clientY: number;
  contentHeight: number;
  contentWidth: number;
  deviceHeight: number;
  deviceWidth: number;
  element: HTMLElement;
}) {
  const { clientX, clientY, contentHeight, contentWidth, deviceHeight, deviceWidth, element } = args;
  if (contentWidth <= 0 || contentHeight <= 0 || deviceWidth <= 0 || deviceHeight <= 0) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const contentBox = getContainedContentBox(rect.height, rect.width, contentHeight, contentWidth);
  const relativeX = clamp(clientX - rect.left - contentBox.left, 0, contentBox.width);
  const relativeY = clamp(clientY - rect.top - contentBox.top, 0, contentBox.height);

  return {
    x: clamp(Math.round((relativeX / contentBox.width) * deviceWidth), 0, deviceWidth),
    y: clamp(Math.round((relativeY / contentBox.height) * deviceHeight), 0, deviceHeight),
  };
}

async function drawBlobToCanvas(canvas: HTMLCanvasElement, blob: Blob): Promise<{ height: number; width: number }> {
  const imageUrl = URL.createObjectURL(blob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Failed to decode iOS simulator screenshot."));
      nextImage.src = imageUrl;
    });

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to initialize iOS simulator canvas.");
    }

    const container = canvas.parentElement;
    const boundsWidth = Math.max(container?.clientWidth ?? image.naturalWidth, 1);
    const boundsHeight = Math.max(container?.clientHeight ?? image.naturalHeight, 1);
    const displayBox = getContainedContentBox(
      boundsHeight,
      boundsWidth,
      image.naturalHeight,
      image.naturalWidth,
    );
    const displayWidth = Math.max(Math.round(displayBox.width), 1);
    const displayHeight = Math.max(Math.round(displayBox.height), 1);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderWidth = Math.max(Math.round(displayWidth * pixelRatio), 1);
    const renderHeight = Math.max(Math.round(displayHeight * pixelRatio), 1);

    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
    }

    if (canvas.style.width !== `${displayWidth}px`) {
      canvas.style.width = `${displayWidth}px`;
    }
    if (canvas.style.height !== `${displayHeight}px`) {
      canvas.style.height = `${displayHeight}px`;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.clearRect(0, 0, displayWidth, displayHeight);
    context.drawImage(image, 0, 0, displayWidth, displayHeight);

    return {
      height: image.naturalHeight,
      width: image.naturalWidth,
    };
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export function IosSimulatorViewer({
  deviceName,
  nativeBaseUrl = null,
  platformSessionId = null,
  sessionId,
}: IosSimulatorViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keyboardInputRef = useRef<HTMLTextAreaElement | null>(null);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const pointSizeRef = useRef({ height: 844, width: 390 });
  const framePixelSizeRef = useRef({ height: 844, width: 390 });
  const dragStateRef = useRef<DragState | null>(null);
  const screenshotAbortRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const fallbackRefreshTimerRef = useRef<number | null>(null);
  const controlReconnectTimerRef = useRef<number | null>(null);
  const actionRefreshTimersRef = useRef<number[]>([]);
  const hasFrameRef = useRef(false);
  const mediaModeRef = useRef<MediaMode>(supportsIosLiveViewer() ? "live" : "fallback");
  const requestFallbackRefreshRef = useRef<() => void>(() => undefined);

  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [liveAttempt, setLiveAttempt] = useState(0);
  const [mediaMode, setMediaMode] = useState<MediaMode>(supportsIosLiveViewer() ? "live" : "fallback");

  const urls = useMemo(() => buildIosViewerUrls({
    nativeBaseUrl,
    platformSessionId,
    sessionId,
  }), [nativeBaseUrl, platformSessionId, sessionId]);

  useEffect(() => {
    mediaModeRef.current = mediaMode;
  }, [mediaMode]);

  const loadPointDimensions = async () => {
    try {
      const response = await fetch(urls.status, {
        cache: "no-store",
      });
      if (!response.ok) {
        return;
      }

      const payload = await response.json().catch(() => null) as IosStatusResponse | null;
      const width = Number(payload?.session_info?.device_width);
      const height = Number(payload?.session_info?.device_height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return;
      }

      pointSizeRef.current = {
        height,
        width,
      };
    } catch {
      // Dimension lookup is best-effort; fallback defaults still keep input usable.
    }
  };

  useEffect(() => {
    void loadPointDimensions();
  }, [urls.status]);

  useEffect(() => {
    let disposed = false;

    const clearReconnectTimer = () => {
      if (controlReconnectTimerRef.current != null) {
        window.clearTimeout(controlReconnectTimerRef.current);
        controlReconnectTimerRef.current = null;
      }
    };

    const closeControlSocket = () => {
      const socket = controlSocketRef.current;
      controlSocketRef.current = null;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };

    const scheduleReconnect = (message: string) => {
      if (disposed || controlReconnectTimerRef.current != null) {
        return;
      }

      setConnectionState("connecting");
      if (!hasFrameRef.current) {
        setError(message);
      }

      controlReconnectTimerRef.current = window.setTimeout(() => {
        controlReconnectTimerRef.current = null;
        connectControlSocket();
      }, 1_500);
    };

    const connectControlSocket = () => {
      closeControlSocket();

      const socket = new WebSocket(urls.control);
      controlSocketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          return;
        }

        setConnectionState(hasFrameRef.current ? "connected" : "connecting");
        if (!hasFrameRef.current) {
          setError(null);
        }
        void loadPointDimensions();
      };

      socket.onerror = () => {
        scheduleReconnect("Reconnecting iOS control channel…");
      };

      socket.onclose = (closeEvent) => {
        if (disposed) {
          return;
        }

        if (closeEvent.wasClean && closeEvent.code === 1000) {
          setConnectionState("disconnected");
          return;
        }

        scheduleReconnect(closeEvent.reason || "Reconnecting iOS control channel…");
      };
    };

    connectControlSocket();

    return () => {
      disposed = true;
      clearReconnectTimer();
      closeControlSocket();
    };
  }, [urls.control]);

  useEffect(() => {
    if (mediaMode !== "live") {
      return;
    }

    if (!supportsIosLiveViewer()) {
      setMediaMode("fallback");
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      setConnectionState("error");
      setError("Unable to initialize iOS live viewer.");
      return;
    }

    let disposed = false;
    let animationFrameId: number | null = null;
    let isProcessingFrame = false;
    let pendingFrame: IosVideoFrame | null = null;

    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);

    const switchToFallback = (message: string) => {
      if (disposed) {
        return;
      }

      hasFrameRef.current = false;
      setHasFrame(false);
      setConnectionState("connecting");
      setError(message);
      setMediaMode("fallback");
    };

    const drawLiveFrame = (image: HTMLImageElement, pixelWidth: number, pixelHeight: number) => {
      const container = containerRef.current;
      const boundsWidth = Math.max(container?.clientWidth ?? pixelWidth, 1);
      const boundsHeight = Math.max(container?.clientHeight ?? pixelHeight, 1);
      const displayBox = getContainedContentBox(boundsHeight, boundsWidth, pixelHeight, pixelWidth);
      const displayWidth = Math.max(Math.round(displayBox.width), 1);
      const displayHeight = Math.max(Math.round(displayBox.height), 1);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const renderWidth = Math.max(Math.round(displayWidth * pixelRatio), 1);
      const renderHeight = Math.max(Math.round(displayHeight * pixelRatio), 1);

      if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
        canvas.width = renderWidth;
        canvas.height = renderHeight;
      }

      if (canvas.style.width !== `${displayWidth}px`) {
        canvas.style.width = `${displayWidth}px`;
      }
      if (canvas.style.height !== `${displayHeight}px`) {
        canvas.style.height = `${displayHeight}px`;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, displayWidth, displayHeight);
      context.drawImage(image, 0, 0, displayWidth, displayHeight);
    };

    const processFrame = (frame: IosVideoFrame) => {
      isProcessingFrame = true;

      const image = new Image();
      image.onload = () => {
        if (disposed) {
          isProcessingFrame = false;
          return;
        }

        const pixelWidth = frame.pixel_width ?? image.width;
        const pixelHeight = frame.pixel_height ?? image.height;

        pointSizeRef.current = {
          height: frame.point_height ?? pointSizeRef.current.height,
          width: frame.point_width ?? pointSizeRef.current.width,
        };
        framePixelSizeRef.current = {
          height: pixelHeight,
          width: pixelWidth,
        };

        drawLiveFrame(image, pixelWidth, pixelHeight);

        hasFrameRef.current = true;
        setHasFrame(true);
        setConnectionState(controlSocketRef.current?.readyState === WebSocket.OPEN ? "connected" : "connecting");
        setError(null);

        isProcessingFrame = false;
        if (pendingFrame) {
          const nextFrame = pendingFrame;
          pendingFrame = null;
          scheduleFrame(nextFrame);
        }
      };

      image.onerror = () => {
        isProcessingFrame = false;
        if (!hasFrameRef.current) {
          switchToFallback("Live iOS stream failed before the first frame arrived.");
        }
      };

      image.src = `data:image/jpeg;base64,${frame.data}`;
    };

    const scheduleFrame = (frame: IosVideoFrame) => {
      if (isProcessingFrame) {
        pendingFrame = frame;
        return;
      }

      if (animationFrameId != null) {
        pendingFrame = frame;
        return;
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        processFrame(frame);
      });
    };

    const videoSocket = new WebSocket(urls.video);

    videoSocket.onopen = () => {
      setConnectionState("connecting");
      setError(null);
    };

    videoSocket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as IosVideoFrame;
        if (frame.type !== "video_frame" || !frame.data) {
          return;
        }

        scheduleFrame(frame);
      } catch (frameError) {
        if (!hasFrameRef.current) {
          const message = frameError instanceof Error ? frameError.message : "Invalid iOS video frame payload.";
          switchToFallback(message);
        }
      }
    };

    videoSocket.onerror = () => {
      if (!hasFrameRef.current) {
        switchToFallback("Live iOS stream failed. Falling back to compatibility mode.");
      }
    };

    videoSocket.onclose = (closeEvent) => {
      if (disposed) {
        return;
      }

      if (closeEvent.wasClean && closeEvent.code === 1000) {
        setConnectionState("disconnected");
        return;
      }

      switchToFallback(closeEvent.reason || "Live iOS stream disconnected. Falling back to compatibility mode.");
    };

    return () => {
      disposed = true;
      if (animationFrameId != null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      videoSocket.close();
    };
  }, [liveAttempt, mediaMode, urls.video]);

  useEffect(() => {
    if (mediaMode !== "fallback") {
      requestFallbackRefreshRef.current = () => undefined;
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext("2d")) {
      setConnectionState("error");
      setError("Unable to initialize iOS compatibility viewer.");
      return;
    }

    let disposed = false;
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");

    const clearFallbackRefreshTimer = () => {
      if (fallbackRefreshTimerRef.current != null) {
        window.clearTimeout(fallbackRefreshTimerRef.current);
        fallbackRefreshTimerRef.current = null;
      }
    };

    const clearActionRefreshTimers = () => {
      for (const timer of actionRefreshTimersRef.current) {
        window.clearTimeout(timer);
      }
      actionRefreshTimersRef.current = [];
    };

    const scheduleFallbackPoll = () => {
      clearFallbackRefreshTimer();
      fallbackRefreshTimerRef.current = window.setTimeout(() => {
        fallbackRefreshTimerRef.current = null;
        requestFallbackRefreshRef.current();
      }, FALLBACK_SCREENSHOT_POLL_INTERVAL_MS);
    };

    const refreshScreenshot = async () => {
      if (disposed) {
        return;
      }

      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        return;
      }

      refreshInFlightRef.current = true;
      clearFallbackRefreshTimer();

      const controller = new AbortController();
      screenshotAbortRef.current = controller;

      try {
        const targetUrl = new URL(urls.screenshot);
        targetUrl.searchParams.set("t", Date.now().toString());

        const response = await fetch(targetUrl, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to refresh iOS compatibility view (${response.status}).`);
        }

        const blob = await response.blob();
        if (blob.size <= 0) {
          throw new Error("iOS compatibility screenshot was empty.");
        }

        const renderCanvas = canvasRef.current;
        if (!renderCanvas) {
          return;
        }

        const dimensions = await drawBlobToCanvas(renderCanvas, blob);
        framePixelSizeRef.current = dimensions;
        if (pointSizeRef.current.width <= 0 || pointSizeRef.current.height <= 0) {
          pointSizeRef.current = dimensions;
        }

        if (!disposed) {
          hasFrameRef.current = true;
          setHasFrame(true);
          setConnectionState(controlSocketRef.current?.readyState === WebSocket.OPEN ? "connected" : "connecting");
          setError(null);
        }
      } catch (refreshError) {
        if (disposed || controller.signal.aborted) {
          return;
        }

        const message = refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh the iOS compatibility view.";

        if (!hasFrameRef.current) {
          setConnectionState("error");
        }
        setError(message);
      } finally {
        if (screenshotAbortRef.current === controller) {
          screenshotAbortRef.current = null;
        }

        refreshInFlightRef.current = false;
        if (disposed) {
          return;
        }

        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          void refreshScreenshot();
          return;
        }

        scheduleFallbackPoll();
      }
    };

    requestFallbackRefreshRef.current = () => {
      void refreshScreenshot();
    };

    void loadPointDimensions();
    requestFallbackRefreshRef.current();

    return () => {
      disposed = true;
      requestFallbackRefreshRef.current = () => undefined;
      clearFallbackRefreshTimer();
      clearActionRefreshTimers();
      screenshotAbortRef.current?.abort();
      screenshotAbortRef.current = null;
    };
  }, [mediaMode, urls.screenshot, urls.status]);

  const restartLiveStream = () => {
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);
    setMediaMode("live");
    setLiveAttempt((current) => current + 1);
  };

  const focusKeyboardInput = () => {
    keyboardInputRef.current?.focus({
      preventScroll: true,
    });
  };

  const clearKeyboardBuffer = () => {
    const input = keyboardInputRef.current;
    if (!input) {
      return;
    }

    input.value = "";
    input.setSelectionRange(0, 0);
  };

  const sendControl = (payload: IosControlPayload) => {
    const socket = controlSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnectionState("connecting");
      setError("iOS control channel is reconnecting.");
      return;
    }

    socket.send(JSON.stringify(payload));

    if (mediaModeRef.current !== "fallback") {
      return;
    }

    for (const timer of actionRefreshTimersRef.current) {
      window.clearTimeout(timer);
    }

    actionRefreshTimersRef.current = FALLBACK_REFRESH_AFTER_ACTION_MS.map((delay) => {
      const timer = window.setTimeout(() => {
        actionRefreshTimersRef.current = actionRefreshTimersRef.current.filter((value) => value !== timer);
        requestFallbackRefreshRef.current();
      }, delay);
      return timer;
    });
  };

  const sendKeyboardText = (text: string) => {
    if (text.length === 0) {
      return;
    }

    sendControl({
      t: "text",
      text,
    });
  };

  const sendKeyboardKey = (key: string, duration?: number) => {
    sendControl({
      ...(duration != null ? { duration } : {}),
      key,
      t: "key",
    });
  };

  const handleKeyboardInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const text = event.currentTarget.value;
    if (text.length === 0) {
      return;
    }

    sendKeyboardText(text);
    clearKeyboardBuffer();
  };

  const handleKeyboardKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const specialKey = IOS_SPECIAL_KEY_MAP[event.key];
    if (!specialKey) {
      return;
    }

    event.preventDefault();
    sendKeyboardKey(specialKey, event.key === "Enter" ? 0.1 : undefined);
    clearKeyboardBuffer();
  };

  const getInteractivePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    return mapClientPointToDevice({
      clientX,
      clientY,
      contentHeight: framePixelSizeRef.current.height,
      contentWidth: framePixelSizeRef.current.width,
      deviceHeight: pointSizeRef.current.height,
      deviceWidth: pointSizeRef.current.width,
      element: canvas,
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    focusKeyboardInput();
    const point = getInteractivePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    dragStateRef.current = {
      startAt: Date.now(),
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const activeDrag = dragStateRef.current;
    if (!activeDrag) {
      return;
    }

    const point = getInteractivePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    dragStateRef.current = {
      ...activeDrag,
      x: point.x,
      y: point.y,
    };
  };

  const finishPointerGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const activeDrag = dragStateRef.current;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!activeDrag) {
      return;
    }

    const point = getInteractivePoint(event.clientX, event.clientY) ?? { x: activeDrag.x, y: activeDrag.y };
    const dx = point.x - activeDrag.startX;
    const dy = point.y - activeDrag.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= 12) {
      sendControl({
        t: "tap",
        x: point.x,
        y: point.y,
      });
      return;
    }

    sendControl({
      duration: clamp((Date.now() - activeDrag.startAt) / 1000, 0.12, 0.45),
      end_x: point.x,
      end_y: point.y,
      start_x: activeDrag.startX,
      start_y: activeDrag.startY,
      t: "swipe",
    });
  };

  const statusLabel = connectionState === "connected"
    ? mediaMode === "live"
      ? "Live"
      : "Fallback"
    : connectionState === "connecting"
      ? "Connecting"
      : connectionState === "disconnected"
        ? "Disconnected"
        : "Error";

  const overlayMessage = error ?? (
    mediaMode === "live"
      ? "Starting the iOS live stream directly in this panel."
      : "Using the compatibility renderer while the live stream is unavailable."
  );

  return (
    <div
      data-device-viewer="ios-native"
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_48%),linear-gradient(180deg,_rgba(9,9,11,0.96),_rgba(2,6,23,0.98))]"
    >
      <textarea
        ref={keyboardInputRef}
        aria-label="iOS keyboard bridge"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
        spellCheck={false}
        tabIndex={-1}
        onInput={handleKeyboardInput}
        onKeyDown={handleKeyboardKeyDown}
      />

      <div className="absolute left-3 top-3 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

      <div ref={containerRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <canvas
          ref={canvasRef}
          className="block max-h-full max-w-full touch-none rounded-[22px] bg-black shadow-[0_24px_90px_rgba(0,0,0,0.55)] outline-none"
          tabIndex={0}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={finishPointerGesture}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerGesture}
        />

        {!hasFrame ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/18 px-6 text-center">
            {connectionState === "error" ? (
              <Smartphone className="h-8 w-8 text-white/70" />
            ) : (
              <LoaderCircle className="h-8 w-8 animate-spin text-white/80" />
            )}
            <div>
              <p className="text-sm font-semibold text-white">{deviceName}</p>
              <p className="mt-1 text-xs leading-5 text-white/65">{overlayMessage}</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-md">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="iOS Reconnect"
            onClick={restartLiveStream}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="iOS Home"
            onClick={() => sendControl({ t: "button", button: "home" })}
          >
            <House className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="iOS Lock"
            onClick={() => sendControl({ t: "button", button: "lock" })}
          >
            <Lock className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
