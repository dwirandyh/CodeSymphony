import { useEffect, useMemo, useRef, useState } from "react";
import { House, LoaderCircle, Lock, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";

type IosSimulatorViewerProps = {
  deviceName: string;
  sessionId: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

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

const SCREENSHOT_POLL_INTERVAL_MS = 2_000;
const POST_ACTION_REFRESH_DELAYS_MS = [180, 900];

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function buildIosViewerUrls(sessionId: string) {
  const httpBase = new URL(api.runtimeBaseUrl);
  const websocketBase = new URL(api.runtimeBaseUrl);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  const encodedSessionId = encodeURIComponent(sessionId);

  return {
    control: new URL(`/api/device-streams/${encodedSessionId}/native/control`, websocketBase).toString(),
    screenshot: new URL(`/api/device-streams/${encodedSessionId}/native/screenshot`, httpBase).toString(),
    status: new URL(`/api/device-streams/${encodedSessionId}/native/status`, httpBase).toString(),
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

    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return {
      height: image.naturalHeight,
      width: image.naturalWidth,
    };
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

export function IosSimulatorViewer({ deviceName, sessionId }: IosSimulatorViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const pointSizeRef = useRef({ height: 844, width: 390 });
  const dragStateRef = useRef<DragState | null>(null);
  const hasFrameRef = useRef(false);
  const screenshotAbortRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const actionRefreshTimersRef = useRef<number[]>([]);
  const requestRefreshRef = useRef<() => void>(() => undefined);
  const queueActionRefreshesRef = useRef<() => void>(() => undefined);

  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  const urls = useMemo(() => buildIosViewerUrls(sessionId), [sessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext("2d")) {
      setConnectionState("error");
      setError("Unable to initialize iOS simulator canvas.");
      return;
    }

    let disposed = false;
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearActionRefreshTimers = () => {
      for (const timer of actionRefreshTimersRef.current) {
        window.clearTimeout(timer);
      }
      actionRefreshTimersRef.current = [];
    };

    const schedulePoll = (delay = SCREENSHOT_POLL_INTERVAL_MS) => {
      clearRefreshTimer();
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        requestRefreshRef.current();
      }, delay);
    };

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
        // Status metadata is best-effort; screenshot rendering can continue without it.
      }
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
      clearRefreshTimer();

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
          throw new Error(`Failed to refresh iOS simulator view (${response.status}).`);
        }

        const blob = await response.blob();
        if (blob.size <= 0) {
          throw new Error("iOS simulator screenshot was empty.");
        }

        const renderCanvas = canvasRef.current;
        if (!renderCanvas) {
          return;
        }

        const dimensions = await drawBlobToCanvas(renderCanvas, blob);
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
          : "Failed to refresh iOS simulator view.";

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

        schedulePoll();
      }
    };

    requestRefreshRef.current = () => {
      void refreshScreenshot();
    };

    queueActionRefreshesRef.current = () => {
      clearActionRefreshTimers();
      for (const delay of POST_ACTION_REFRESH_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          actionRefreshTimersRef.current = actionRefreshTimersRef.current.filter((value) => value !== timer);
          requestRefreshRef.current();
        }, delay);
        actionRefreshTimersRef.current.push(timer);
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
      if (disposed || reconnectTimerRef.current != null) {
        return;
      }

      setConnectionState("connecting");
      if (!hasFrameRef.current) {
        setError(message);
      }

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connectControlSocket();
      }, 1_500);
    };

    const connectControlSocket = () => {
      closeControlSocket();

      const controlSocket = new WebSocket(urls.control);
      controlSocketRef.current = controlSocket;

      controlSocket.onopen = () => {
        if (disposed) {
          return;
        }

        setConnectionState(hasFrameRef.current ? "connected" : "connecting");
        setError(null);
        void loadPointDimensions();
        requestRefreshRef.current();
      };

      controlSocket.onerror = () => {
        scheduleReconnect("Reconnecting iOS control websocket…");
      };

      controlSocket.onclose = (closeEvent) => {
        if (disposed) {
          return;
        }

        if (closeEvent.wasClean && closeEvent.code === 1000) {
          setConnectionState("disconnected");
          return;
        }

        scheduleReconnect(closeEvent.reason || "Reconnecting iOS control websocket…");
      };
    };

    void loadPointDimensions();
    connectControlSocket();
    requestRefreshRef.current();

    return () => {
      disposed = true;
      dragStateRef.current = null;
      requestRefreshRef.current = () => undefined;
      queueActionRefreshesRef.current = () => undefined;
      clearRefreshTimer();
      clearReconnectTimer();
      clearActionRefreshTimers();
      screenshotAbortRef.current?.abort();
      screenshotAbortRef.current = null;
      closeControlSocket();
    };
  }, [urls.control, urls.screenshot, urls.status]);

  const sendControl = (payload: Record<string, number | string>) => {
    const socket = controlSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnectionState("connecting");
      setError("iOS control channel is reconnecting.");
      return;
    }

    socket.send(JSON.stringify(payload));
    queueActionRefreshesRef.current();
  };

  const getCanvasPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const width = pointSizeRef.current.width;
    const height = pointSizeRef.current.height;
    if (rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) {
      return null;
    }

    return {
      x: clamp(Math.round(((clientX - rect.left) / rect.width) * width), 0, width),
      y: clamp(Math.round(((clientY - rect.top) / rect.height) * height), 0, height),
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = getCanvasPoint(event.clientX, event.clientY);
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

    const point = getCanvasPoint(event.clientX, event.clientY);
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

    const point = getCanvasPoint(event.clientX, event.clientY) ?? { x: activeDrag.x, y: activeDrag.y };
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
    ? "Ready"
    : connectionState === "connecting"
      ? "Connecting"
      : connectionState === "disconnected"
        ? "Disconnected"
        : "Error";

  return (
    <div
      data-device-viewer="ios-native"
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_48%),linear-gradient(180deg,_rgba(9,9,11,0.96),_rgba(2,6,23,0.98))]"
    >
      <div className="absolute left-3 top-3 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
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
              <p className="mt-1 text-xs leading-5 text-white/65">
                {error ?? "Menyambungkan simulator iOS langsung ke panel ini tanpa iframe."}
              </p>
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
            aria-label="iOS Refresh"
            onClick={() => requestRefreshRef.current()}
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
