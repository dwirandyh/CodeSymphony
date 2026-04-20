import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, House, LayoutGrid, LoaderCircle, Maximize2, Minimize2, Power, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { createDeviceStreamMetrics } from "../../lib/deviceStreamMetrics";
import { cn } from "../../lib/utils";
import { getMobileDeviceViewerControlsFlag, supportsAndroidNativeViewer } from "./deviceViewerEnvironment";
import {
  ANDROID_KEY_ACTION_DOWN,
  ANDROID_KEY_ACTION_UP,
  ANDROID_KEYCODE_APP_SWITCH,
  ANDROID_KEYCODE_BACK,
  ANDROID_KEYCODE_HOME,
  ANDROID_KEYCODE_POWER,
  buildAndroidKeyCodeMessage,
  buildAndroidScrollMessage,
  buildAndroidTouchMessage,
  buildAndroidVideoSettingsMessage,
  buildAndroidViewerWebSocketUrl,
  createDefaultAndroidVideoSettings,
  getAndroidVideoPacketType,
  isAndroidDeviceMessagePacket,
  isAndroidInitialPacket,
  isAndroidVideoKeyPacket,
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

const MIN_STREAM_BOUNDS = 160;
function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function getPointerAction(type: string): number | null {
  switch (type) {
    case "pointerdown":
      return 0;
    case "pointermove":
      return 2;
    case "pointerup":
    case "pointercancel":
      return 1;
    default:
      return null;
  }
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

export function AndroidDeviceViewer({ deviceName, serial, sessionId }: AndroidDeviceViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const bufferedPacketRef = useRef<Uint8Array | null>(null);
  const hasIdrRef = useRef(false);
  const hasPpsRef = useRef(false);
  const hasSpsRef = useRef(false);
  const resizeTimerRef = useRef<number | null>(null);
  const activeDisplayRef = useRef<AndroidDisplayInfo | null>(null);
  const activeVideoSettingsRef = useRef<AndroidVideoSettings | null>(null);
  const requestedBoundsRef = useRef<{ height: number; width: number } | null>(null);
  const pointerActiveRef = useRef(false);
  const deviceSizeRef = useRef({ height: 0, width: 0 });

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    supportsAndroidNativeViewer() ? "connecting" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState(deviceName);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
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
    if (!supportsAndroidNativeViewer()) {
      return;
    }

    metrics.markConnectStart({
      serial,
      viewerWebSocketUrl,
    });

    let disposed = false;
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
        deviceSizeRef.current = { height: canvas.height, width: canvas.width };
        metrics.markFrame({
          height: canvas.height,
          width: canvas.width,
        });
        setConnectionState("connected");
        setHasFrame(true);
        setError(null);
      },
      error: (decodeError) => {
        if (disposed) {
          return;
        }

        setConnectionState("error");
        setError(decodeError.message || "Failed to decode Android stream.");
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
      ws.send(buildAndroidVideoSettingsMessage(nextSettings));
    };

    const websocket = new WebSocket(viewerWebSocketUrl);
    websocket.binaryType = "arraybuffer";
    websocketRef.current = websocket;

    websocket.onopen = () => {
      if (disposed) {
        return;
      }

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
          sendVideoSettings();
          return;
        }

        if (isAndroidDeviceMessagePacket(buffer)) {
          return;
        }

        const packet = new Uint8Array(buffer);
        const packetType = getAndroidVideoPacketType(packet);
        if (packetType == null) {
          return;
        }

        const decoderConfig = parseAndroidVideoPacketConfig(packet);
        if (decoderConfig) {
          if (canvas.width !== decoderConfig.width || canvas.height !== decoderConfig.height) {
            canvas.width = decoderConfig.width;
            canvas.height = decoderConfig.height;
          }

          if (decoder.state !== "configured") {
            decoder.configure({
              codec: decoderConfig.codec,
              optimizeForLatency: true,
            });
          } else {
            try {
              decoder.configure({
                codec: decoderConfig.codec,
                optimizeForLatency: true,
              });
            } catch {
              decoder.close();
              try {
                decoderRef.current = createDecoder();
              } catch (decodeError) {
                setConnectionState("error");
                setError(
                  decodeError instanceof Error
                    ? decodeError.message
                    : "Failed to reinitialize Android stream decoder.",
                );
                return;
              }
              decoderRef.current.configure({
                codec: decoderConfig.codec,
                optimizeForLatency: true,
              });
            }
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
        if (!activeDecoder || activeDecoder.state !== "configured" || !hasIdrRef.current) {
          return;
        }

        bufferedPacketRef.current = null;
        hasSpsRef.current = false;
        hasPpsRef.current = false;
        activeDecoder.decode(new EncodedVideoChunk({
          data: bufferedPacket,
          timestamp: Math.round(performance.now() * 1_000),
          type: "key",
        }));
      };

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(handleBinaryPacket).catch(() => {
          if (disposed) {
            return;
          }

          setConnectionState("error");
          setError("Android websocket stream failed.");
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

      setConnectionState("error");
      setError("Android websocket stream failed.");
    };

    websocket.onclose = (closeEvent) => {
      if (disposed) {
        return;
      }

      if (closeEvent.wasClean) {
        setConnectionState("disconnected");
        return;
      }
      setConnectionState("error");
      setError(closeEvent.reason || "Android websocket stream closed unexpectedly.");
    };

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
      metrics.flush("cleanup", {
        hadFrame: deviceSizeRef.current.width > 0 && deviceSizeRef.current.height > 0,
      });
      resizeObserver?.disconnect();
      if (resizeTimerRef.current != null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      websocket.close();
      websocketRef.current = null;
      decoder.close();
      decoderRef.current = null;
    };
  }, [deviceName, metrics, serial, viewerWebSocketUrl]);

  const sendKeyPress = (keycode: number) => {
    const ws = websocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    metrics.markControl(`keycode:${keycode}`);
    ws.send(buildAndroidKeyCodeMessage(ANDROID_KEY_ACTION_DOWN, keycode));
    ws.send(buildAndroidKeyCodeMessage(ANDROID_KEY_ACTION_UP, keycode));
  };

  const sendPointerEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const ws = websocketRef.current;
    const canvas = canvasRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !canvas) {
      return;
    }

    const action = getPointerAction(event.type);
    if (action == null) {
      return;
    }

    if (event.type === "pointermove" && !pointerActiveRef.current) {
      return;
    }

    const deviceWidth = deviceSizeRef.current.width || canvas.width;
    const deviceHeight = deviceSizeRef.current.height || canvas.height;
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = clamp(Math.round(((event.clientX - rect.left) / rect.width) * deviceWidth), 0, deviceWidth);
    const y = clamp(Math.round(((event.clientY - rect.top) / rect.height) * deviceHeight), 0, deviceHeight);

    if (event.type === "pointerdown") {
      pointerActiveRef.current = true;
      canvas.setPointerCapture(event.pointerId);
      metrics.markControl("gesture:pointerdown", {
        gestureToControlMs: 0,
      });
    }

    if (event.type === "pointerup" || event.type === "pointercancel") {
      pointerActiveRef.current = false;
    }

    const buttons = action === 1 ? 0 : Math.max(1, event.buttons || 1);
    const pressure = action === 1 ? 0 : event.pressure > 0 ? event.pressure : 1;
    ws.send(buildAndroidTouchMessage({
      action,
      buttons,
      pointerId: 0,
      pressure,
      screenHeight: deviceHeight,
      screenWidth: deviceWidth,
      x,
      y,
    }));
  };

  const sendScrollEvent = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const ws = websocketRef.current;
    const canvas = canvasRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !canvas) {
      return;
    }

    const deviceWidth = deviceSizeRef.current.width || canvas.width;
    const deviceHeight = deviceSizeRef.current.height || canvas.height;
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const x = clamp(Math.round(((event.clientX - rect.left) / rect.width) * deviceWidth), 0, deviceWidth);
    const y = clamp(Math.round(((event.clientY - rect.top) / rect.height) * deviceHeight), 0, deviceHeight);

    ws.send(buildAndroidScrollMessage({
      hScroll: event.deltaX > 0 ? -1 : event.deltaX < 0 ? 1 : 0,
      screenHeight: deviceHeight,
      screenWidth: deviceWidth,
      vScroll: event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0,
      x,
      y,
    }));
    event.preventDefault();
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
      <div className="absolute left-3 top-3 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

      <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
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

      <div ref={containerRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <canvas
          ref={canvasRef}
          className="block max-h-full max-w-full touch-none rounded-[22px] bg-black shadow-[0_24px_90px_rgba(0,0,0,0.55)] outline-none"
          tabIndex={0}
          onContextMenu={(event) => event.preventDefault()}
          onPointerCancel={sendPointerEvent}
          onPointerDown={sendPointerEvent}
          onPointerMove={sendPointerEvent}
          onPointerUp={sendPointerEvent}
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

      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-md">
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
        </div>
      </div>
    </div>
  );
}
