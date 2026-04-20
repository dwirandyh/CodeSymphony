import { useEffect, useMemo, useRef, useState } from "react";
import { House, Keyboard, LoaderCircle, Lock, Maximize2, Minimize2, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";
import { debugLog } from "../../lib/debugLog";
import { createDeviceStreamMetrics } from "../../lib/deviceStreamMetrics";
import { cn } from "../../lib/utils";
import { getMobileDeviceViewerControlsFlag, supportsIosNativeViewer } from "./deviceViewerEnvironment";
import {
  buildIosDragPayload,
  detectIosGestureEdge,
  IOS_GESTURE_PATH_FLUSH_INTERVAL_MS,
  IOS_GESTURE_TAP_SLOP_CSS_PX,
  IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX,
  IOS_GESTURE_TOUCH_CANCEL_DISTANCE_CSS_PX,
  IOS_TOUCH_DOWN_DELAY_LIVE_MS,
  resolveIosGestureAxis,
  type IosGestureAxis,
  type IosGestureEdge,
  type IosGesturePathPoint,
  shouldAppendIosGesturePathPoint,
} from "./iosGesture";

type IosSimulatorViewerProps = {
  deviceName: string;
  sessionId: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

type ViewportRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

type DragState = {
  axis: IosGestureAxis | null;
  edge: IosGestureEdge | null;
  dragActive: boolean;
  dragFlushTimer: number | null;
  dragPoints: IosGesturePathPoint[];
  lastPathAtMs: number;
  lastPathClientX: number;
  lastPathClientY: number;
  moved: boolean;
  moveStartedAt: number | null;
  pointerId: number;
  scrollIntent: boolean;
  startAtMs: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  touchDownSent: boolean;
  touchTimer: number | null;
  x: number;
  y: number;
};

type IosStatusResponse = {
  session_info?: {
    device_height?: number;
    device_width?: number;
  };
};

type IosControlPayload = Record<string, unknown>;

type IosStreamMetadata = {
  codec?: string;
  pointHeight?: number;
  pointWidth?: number;
  pixelHeight?: number;
  pixelWidth?: number;
};

const IOS_H264_PACKET_CONFIG = 1;
const IOS_H264_PACKET_KEY = 2;
const IOS_H264_PACKET_DELTA = 3;
const IOS_H264_PACKET_CAPTURE_TIMESTAMP_BYTES = 8;
const IOS_LIVE_CALIBRATION_SCALES = [0.88, 0.92, 0.96, 1, 1.04, 1.08];
const IOS_LIVE_CALIBRATION_COARSE_SEARCH_MARGIN_PX = 96;
const IOS_LIVE_CALIBRATION_FINE_SEARCH_MARGIN_PX = 12;
const IOS_LIVE_CALIBRATION_COARSE_STEP_PX = 3;
const IOS_LIVE_CALIBRATION_SAMPLE_HEIGHT = 56;
const IOS_LIVE_CALIBRATION_SAMPLE_WIDTH = 28;
const IOS_LIVE_CALIBRATION_ATTEMPT_INTERVAL_MS = 650;
const IOS_LIVE_CALIBRATION_RETRY_DELAY_MS = 900;
const IOS_LIVE_ALIGNMENT_ASPECT_TOLERANCE = 0.012;
const IOS_MAX_RENDER_PIXEL_RATIO = 2;
const VIDEO_CHUNK_INTERVAL_US = 16_667;
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

function concatUint8Arrays(first: Uint8Array, second: Uint8Array): Uint8Array {
  const merged = new Uint8Array(first.length + second.length);
  merged.set(first);
  merged.set(second, first.length);
  return merged;
}

function readBigEndianUint64Number(bytes: Uint8Array): number | null {
  if (bytes.byteLength < IOS_H264_PACKET_CAPTURE_TIMESTAMP_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  return (high * 2 ** 32) + low;
}

function normalizeIosStreamMessage(message: string): string {
  if (/disconnected|closed/i.test(message)) {
    return "The iOS stream disconnected.";
  }

  if (/unable to initialize/i.test(message)) {
    return "Unable to initialize the iOS stream.";
  }

  if (/decode|packet|metadata/i.test(message)) {
    return "Unable to decode the iOS stream.";
  }

  return message;
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
    video: new URL(`/api/device-streams/${encodedSessionId}/native/video`, websocketBase).toString(),
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

function frameLikelyMatchesDeviceAspect(args: {
  deviceHeight: number;
  deviceWidth: number;
  frameHeight: number;
  frameWidth: number;
}): boolean {
  const { deviceHeight, deviceWidth, frameHeight, frameWidth } = args;
  if (deviceWidth <= 0 || deviceHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return false;
  }

  const deviceAspect = deviceWidth / deviceHeight;
  const frameAspect = frameWidth / frameHeight;
  return Math.abs(deviceAspect - frameAspect) <= IOS_LIVE_ALIGNMENT_ASPECT_TOLERANCE;
}

function fitViewportToAspect(frameHeight: number, frameWidth: number, aspectRatio: number): ViewportRect {
  const safeAspectRatio = aspectRatio > 0 ? aspectRatio : 1;
  const frameRatio = frameWidth / frameHeight;

  if (frameRatio >= safeAspectRatio) {
    const height = frameHeight;
    const width = height * safeAspectRatio;
    return {
      height,
      left: (frameWidth - width) / 2,
      top: 0,
      width,
    };
  }

  const width = frameWidth;
  const height = width / safeAspectRatio;
  return {
    height,
    left: 0,
    top: (frameHeight - height) / 2,
    width,
  };
}

async function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const imageUrl = URL.createObjectURL(blob);

  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to decode iOS simulator calibration screenshot."));
      image.src = imageUrl;
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function extractLumaSamples(context: CanvasRenderingContext2D, width: number, height: number): Float32Array {
  const image = context.getImageData(0, 0, width, height);
  const samples = new Float32Array(width * height);

  for (let index = 0; index < samples.length; index += 1) {
    const offset = index * 4;
    samples[index] = (
      image.data[offset] * 0.299
      + image.data[offset + 1] * 0.587
      + image.data[offset + 2] * 0.114
    ) / 255;
  }

  return samples;
}

async function detectViewportFromScreenshot(args: {
  rawCanvas: HTMLCanvasElement;
  screenshotBlob: Blob;
}): Promise<ViewportRect | null> {
  const { rawCanvas, screenshotBlob } = args;
  const frameWidth = rawCanvas.width;
  const frameHeight = rawCanvas.height;
  if (frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }

  const screenshot = await loadImageFromBlob(screenshotBlob);
  if (screenshot.naturalWidth <= 0 || screenshot.naturalHeight <= 0) {
    return null;
  }

  const aspectRatio = screenshot.naturalWidth / screenshot.naturalHeight;
  const fallbackViewport = fitViewportToAspect(frameHeight, frameWidth, aspectRatio);
  const targetCanvas = document.createElement("canvas");
  const candidateCanvas = document.createElement("canvas");
  targetCanvas.width = IOS_LIVE_CALIBRATION_SAMPLE_WIDTH;
  targetCanvas.height = IOS_LIVE_CALIBRATION_SAMPLE_HEIGHT;
  candidateCanvas.width = IOS_LIVE_CALIBRATION_SAMPLE_WIDTH;
  candidateCanvas.height = IOS_LIVE_CALIBRATION_SAMPLE_HEIGHT;

  const targetContext = targetCanvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  const candidateContext = candidateCanvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (!targetContext || !candidateContext) {
    return fallbackViewport;
  }

  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = "high";
  targetContext.drawImage(screenshot, 0, 0, targetCanvas.width, targetCanvas.height);
  const targetSamples = extractLumaSamples(targetContext, targetCanvas.width, targetCanvas.height);

  let bestRect = fallbackViewport;
  let bestScore = Number.POSITIVE_INFINITY;

  const scoreCandidate = (left: number, top: number, width: number, height: number) => {
    candidateContext.clearRect(0, 0, candidateCanvas.width, candidateCanvas.height);
    candidateContext.drawImage(
      rawCanvas,
      left,
      top,
      width,
      height,
      0,
      0,
      candidateCanvas.width,
      candidateCanvas.height,
    );

    const candidateSamples = extractLumaSamples(candidateContext, candidateCanvas.width, candidateCanvas.height);
    let score = 0;

    for (let index = 0; index < targetSamples.length; index += 1) {
      const difference = targetSamples[index] - candidateSamples[index];
      score += difference * difference;
    }

    if (score < bestScore) {
      bestScore = score;
      bestRect = {
        height,
        left,
        top,
        width,
      };
    }
  };

  const searchForScale = (scale: number, step: number, margin: number, anchorRect?: ViewportRect) => {
    let width = Math.round(fallbackViewport.width * scale);
    let height = Math.round(width / aspectRatio);

    if (height > frameHeight) {
      height = Math.round(fallbackViewport.height * scale);
      width = Math.round(height * aspectRatio);
    }

    if (width <= 0 || height <= 0 || width > frameWidth || height > frameHeight) {
      return;
    }

    const anchorLeft = anchorRect ? anchorRect.left + ((anchorRect.width - width) / 2) : (frameWidth - width) / 2;
    const anchorTop = anchorRect ? anchorRect.top + ((anchorRect.height - height) / 2) : (frameHeight - height) / 2;
    const minLeft = Math.max(0, Math.floor(anchorLeft - margin));
    const maxLeft = Math.min(frameWidth - width, Math.ceil(anchorLeft + margin));
    const minTop = Math.max(0, Math.floor(anchorTop - margin));
    const maxTop = Math.min(frameHeight - height, Math.ceil(anchorTop + margin));

    for (let top = minTop; top <= maxTop; top += step) {
      for (let left = minLeft; left <= maxLeft; left += step) {
        scoreCandidate(left, top, width, height);
      }
    }
  };

  for (const scale of IOS_LIVE_CALIBRATION_SCALES) {
    searchForScale(
      scale,
      IOS_LIVE_CALIBRATION_COARSE_STEP_PX,
      IOS_LIVE_CALIBRATION_COARSE_SEARCH_MARGIN_PX,
    );
  }

  for (const scale of IOS_LIVE_CALIBRATION_SCALES) {
    searchForScale(
      scale,
      1,
      IOS_LIVE_CALIBRATION_FINE_SEARCH_MARGIN_PX,
      bestRect,
    );
  }

  return {
    height: Math.max(Math.round(bestRect.height), 1),
    left: clamp(Math.round(bestRect.left), 0, Math.max(frameWidth - 1, 0)),
    top: clamp(Math.round(bestRect.top), 0, Math.max(frameHeight - 1, 0)),
    width: Math.max(Math.round(bestRect.width), 1),
  };
}

export function IosSimulatorViewer({ deviceName, sessionId }: IosSimulatorViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keyboardInputRef = useRef<HTMLTextAreaElement | null>(null);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const containerSizeRef = useRef({ height: 0, width: 0 });
  const canvasLayoutRef = useRef({
    displayHeight: 0,
    displayWidth: 0,
    renderHeight: 0,
    renderWidth: 0,
  });
  const pointSizeRef = useRef({ height: 844, width: 390 });
  const framePixelSizeRef = useRef({ height: 844, width: 390 });
  const rawFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawFrameContextRef = useRef<CanvasRenderingContext2D | null>(null);
  const rawFramePixelSizeRef = useRef({ height: 844, width: 390 });
  const dragStateRef = useRef<DragState | null>(null);
  const controlReconnectTimerRef = useRef<number | null>(null);
  const liveCalibrationInFlightRef = useRef(false);
  const liveCalibrationKeyRef = useRef("");
  const liveCalibrationAttemptAtRef = useRef(0);
  const liveCalibrationRetryTimerRef = useRef<number | null>(null);
  const liveViewportRef = useRef<ViewportRect | null>(null);
  const redrawLiveFrameRef = useRef<(() => void) | null>(null);
  const keyboardActiveRef = useRef(false);
  const keyboardFlushTimerRef = useRef<number | null>(null);
  const keyboardTextBufferRef = useRef("");
  const keyboardToggleSnapshotRef = useRef(false);
  const hasFrameRef = useRef(false);
  const liveViewportAlignedRef = useRef(false);
  const pointerGestureStartedAtRef = useRef<number | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    supportsIosNativeViewer() ? "connecting" : "error",
  );
  const [error, setError] = useState<string | null>(
    supportsIosNativeViewer() ? null : "This browser cannot decode the iOS native stream.",
  );
  const [hasFrame, setHasFrame] = useState(false);
  const [liveAttempt, setLiveAttempt] = useState(0);
  const [liveViewportAligned, setLiveViewportAligned] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [keyboardBridgeFocused, setKeyboardBridgeFocused] = useState(false);
  const showMobileViewerControls = useMemo(() => getMobileDeviceViewerControlsFlag(), []);

  const urls = useMemo(() => buildIosViewerUrls(sessionId), [sessionId]);
  const metrics = useMemo(
    () => createDeviceStreamMetrics({
      platform: "ios",
      sessionId,
      streamProtocol: "auto",
    }),
    [sessionId],
  );

  const screenInteractionEnabled = liveViewportAligned;

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

  const updateLiveViewportAligned = (aligned: boolean) => {
    liveViewportAlignedRef.current = aligned;
    setLiveViewportAligned((current) => current === aligned ? current : aligned);
  };

  const clearLiveCalibrationRetryTimer = () => {
    if (liveCalibrationRetryTimerRef.current != null) {
      window.clearTimeout(liveCalibrationRetryTimerRef.current);
      liveCalibrationRetryTimerRef.current = null;
    }
  };

  const clearLiveCalibration = () => {
    clearLiveCalibrationRetryTimer();
    liveCalibrationInFlightRef.current = false;
    liveCalibrationAttemptAtRef.current = 0;
    liveCalibrationKeyRef.current = "";
    liveViewportRef.current = null;
    rawFrameCanvasRef.current = null;
    rawFrameContextRef.current = null;
    rawFramePixelSizeRef.current = { height: 844, width: 390 };
    redrawLiveFrameRef.current = null;
    updateLiveViewportAligned(false);
  };

  const getVisibleViewport = (frameHeight: number, frameWidth: number): ViewportRect => {
    const viewport = liveViewportRef.current;
    if (!viewport) {
      return {
        height: frameHeight,
        left: 0,
        top: 0,
        width: frameWidth,
      };
    }

    return {
      height: clamp(Math.round(viewport.height), 1, frameHeight),
      left: clamp(Math.round(viewport.left), 0, Math.max(frameWidth - 1, 0)),
      top: clamp(Math.round(viewport.top), 0, Math.max(frameHeight - 1, 0)),
      width: clamp(Math.round(viewport.width), 1, frameWidth),
    };
  };

  const drawLiveSourceToCanvas = (
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    frameHeight: number,
    frameWidth: number,
  ) => {
    const viewport = getVisibleViewport(frameHeight, frameWidth);
    const containerSize = containerSizeRef.current;
    const boundsWidth = Math.max(containerSize.width || containerRef.current?.clientWidth || viewport.width, 1);
    const boundsHeight = Math.max(containerSize.height || containerRef.current?.clientHeight || viewport.height, 1);
    const displayBox = getContainedContentBox(boundsHeight, boundsWidth, viewport.height, viewport.width);
    const displayWidth = Math.max(Math.round(displayBox.width), 1);
    const displayHeight = Math.max(Math.round(displayBox.height), 1);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, IOS_MAX_RENDER_PIXEL_RATIO);
    const renderWidth = Math.max(Math.round(displayWidth * pixelRatio), 1);
    const renderHeight = Math.max(Math.round(displayHeight * pixelRatio), 1);
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const canvasLayout = canvasLayoutRef.current;
    if (canvasLayout.renderWidth !== renderWidth || canvasLayout.renderHeight !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
      canvasLayout.renderWidth = renderWidth;
      canvasLayout.renderHeight = renderHeight;
    }

    if (canvasLayout.displayWidth !== displayWidth) {
      canvas.style.width = `${displayWidth}px`;
      canvasLayout.displayWidth = displayWidth;
    }
    if (canvasLayout.displayHeight !== displayHeight) {
      canvas.style.height = `${displayHeight}px`;
      canvasLayout.displayHeight = displayHeight;
    }

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(
      source,
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      0,
      0,
      displayWidth,
      displayHeight,
    );

    framePixelSizeRef.current = {
      height: viewport.height,
      width: viewport.width,
    };
  };

  const ensureRawFrameSurface = (height: number, width: number) => {
    let rawCanvas = rawFrameCanvasRef.current;
    if (!rawCanvas) {
      rawCanvas = document.createElement("canvas");
      rawFrameCanvasRef.current = rawCanvas;
      rawFrameContextRef.current = null;
    }

    if (rawCanvas.width !== width || rawCanvas.height !== height) {
      rawCanvas.width = width;
      rawCanvas.height = height;
    }

    let rawContext = rawFrameContextRef.current;
    if (!rawContext) {
      rawContext = rawCanvas.getContext("2d", { alpha: false });
      if (!rawContext) {
        return null;
      }
      rawFrameContextRef.current = rawContext;
    }

    return {
      rawCanvas,
      rawContext,
    };
  };

  const recalibrateLiveViewport = async () => {
    if (liveCalibrationInFlightRef.current) {
      return;
    }

    const rawCanvas = rawFrameCanvasRef.current;
    if (!rawCanvas || rawCanvas.width <= 0 || rawCanvas.height <= 0) {
      return;
    }

    const deviceWidth = pointSizeRef.current.width;
    const deviceHeight = pointSizeRef.current.height;
    if (deviceWidth <= 0 || deviceHeight <= 0) {
      return;
    }

    const frameAlreadyAligned = frameLikelyMatchesDeviceAspect({
      deviceHeight,
      deviceWidth,
      frameHeight: rawCanvas.height,
      frameWidth: rawCanvas.width,
    });

    if (frameAlreadyAligned && !liveViewportAlignedRef.current) {
      updateLiveViewportAligned(true);
    }

    const calibrationKey = `${rawCanvas.width}x${rawCanvas.height}:${deviceWidth}x${deviceHeight}`;
    if (frameAlreadyAligned) {
      liveViewportRef.current = null;
      liveCalibrationKeyRef.current = calibrationKey;
      return;
    }

    if (liveCalibrationKeyRef.current === calibrationKey) {
      return;
    }

    const now = Date.now();
    if (now - liveCalibrationAttemptAtRef.current < IOS_LIVE_CALIBRATION_ATTEMPT_INTERVAL_MS) {
      return;
    }

    clearLiveCalibrationRetryTimer();
    liveCalibrationAttemptAtRef.current = now;
    liveCalibrationInFlightRef.current = true;

    try {
      const targetUrl = new URL(urls.screenshot);
      targetUrl.searchParams.set("t", `${Date.now()}`);
      const response = await fetch(targetUrl, { cache: "no-store" });
      const fallbackViewport = fitViewportToAspect(
        rawCanvas.height,
        rawCanvas.width,
        deviceWidth / deviceHeight,
      );

      if (!response.ok) {
        liveViewportRef.current = fallbackViewport;
        redrawLiveFrameRef.current?.();
        updateLiveViewportAligned(frameAlreadyAligned);
        liveCalibrationRetryTimerRef.current = window.setTimeout(() => {
          liveCalibrationRetryTimerRef.current = null;
          void recalibrateLiveViewport();
        }, IOS_LIVE_CALIBRATION_RETRY_DELAY_MS);
        return;
      }

      const viewport = await detectViewportFromScreenshot({
        rawCanvas,
        screenshotBlob: await response.blob(),
      });

      liveViewportRef.current = viewport ?? fallbackViewport;
      liveCalibrationKeyRef.current = calibrationKey;
      redrawLiveFrameRef.current?.();
      updateLiveViewportAligned(viewport !== null || frameAlreadyAligned);
    } catch {
      liveViewportRef.current = fitViewportToAspect(
        rawCanvas.height,
        rawCanvas.width,
        deviceWidth / deviceHeight,
      );
      redrawLiveFrameRef.current?.();
      updateLiveViewportAligned(frameAlreadyAligned);
      liveCalibrationRetryTimerRef.current = window.setTimeout(() => {
        liveCalibrationRetryTimerRef.current = null;
        void recalibrateLiveViewport();
      }, IOS_LIVE_CALIBRATION_RETRY_DELAY_MS);
    } finally {
      liveCalibrationInFlightRef.current = false;
    }
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
      // Dimension lookup is best-effort and not worth surfacing as a hard error.
    }
  };

  useEffect(() => {
    metrics.markConnectStart({
      controlUrl: urls.control,
      videoUrl: urls.video,
    });

    return () => {
      metrics.flush("cleanup", {
        hadFrame: hasFrameRef.current,
        liveViewportAligned: liveViewportAlignedRef.current,
      });
    };
  }, [metrics, urls.control, urls.video]);

  useEffect(() => {
    metrics.markMode("live", {
      liveViewportAligned,
    });
  }, [liveViewportAligned, metrics]);

  useEffect(() => {
    void loadPointDimensions();
  }, [urls.status]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateContainerSize = () => {
      containerSizeRef.current = {
        height: Math.max(container.clientHeight, 1),
        width: Math.max(container.clientWidth, 1),
      };
      redrawLiveFrameRef.current?.();
    };

    updateContainerSize();
    window.addEventListener("resize", updateContainerSize);

    if (typeof ResizeObserver !== "function") {
      return () => {
        window.removeEventListener("resize", updateContainerSize);
      };
    }

    const observer = new ResizeObserver(() => {
      updateContainerSize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateContainerSize);
    };
  }, []);

  useEffect(() => {
    const closeExistingSocket = () => {
      const existing = controlSocketRef.current;
      controlSocketRef.current = null;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        existing.close();
      }
    };

    let disposed = false;

    const clearReconnectTimer = () => {
      if (controlReconnectTimerRef.current != null) {
        window.clearTimeout(controlReconnectTimerRef.current);
        controlReconnectTimerRef.current = null;
      }
    };

    const connectControlSocket = () => {
      closeExistingSocket();
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

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }

        try {
          const payload = JSON.parse(event.data) as { error?: string };
          if (typeof payload.error === "string" && payload.error.length > 0) {
            setError(payload.error);
          }
        } catch {
          // Ignore non-JSON messages from the native control bridge.
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
      closeExistingSocket();
    };
  }, [urls.control]);

  useEffect(() => {
    if (!supportsIosNativeViewer()) {
      setConnectionState("error");
      setError("This browser cannot decode the iOS native stream.");
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    if (!canvas || !context) {
      setConnectionState("error");
      setError("Unable to initialize the iOS stream.");
      return;
    }

    let disposed = false;
    let startupTimer: number | null = null;
    let codec = "";
    let configPacket: Uint8Array | null = null;
    let loggedFirstBinaryPacket = false;
    let loggedFirstFrameOutput = false;
    let jpegDecodeInFlight = false;
    let pendingJpegFrame: {
      capturedAtMs: number | null;
      payload: Uint8Array;
      receivedAtMs: number;
    } | null = null;
    const frameTimings = new Map<number, {
      capturedAtMs: number;
      receivedAtMs: number;
    }>();
    let packetTimestamp = 0;

    clearLiveCalibration();
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);

    const videoSocket = new WebSocket(urls.video);
    videoSocket.binaryType = "arraybuffer";

    const renderDecodedSource = (args: {
      decodedAtMs: number;
      frameCapturedAtMs: number | null;
      pixelHeight: number;
      pixelWidth: number;
      receivedAtMs: number | null;
      release?: () => void;
      source: CanvasImageSource;
    }) => {
      const {
        decodedAtMs,
        frameCapturedAtMs,
        pixelHeight,
        pixelWidth,
        receivedAtMs,
        release,
        source,
      } = args;
      const frameAgeMs = frameCapturedAtMs != null
        ? Math.max(decodedAtMs - frameCapturedAtMs, 0)
        : null;
      const frameTransportAgeMs = frameCapturedAtMs != null && receivedAtMs != null
        ? Math.max(receivedAtMs - frameCapturedAtMs, 0)
        : null;
      const frameDecodeLatencyMs = receivedAtMs != null
        ? Math.max(decodedAtMs - receivedAtMs, 0)
        : null;

      const deviceWidth = pointSizeRef.current.width;
      const deviceHeight = pointSizeRef.current.height;
      const frameAlreadyAligned = frameLikelyMatchesDeviceAspect({
        deviceHeight,
        deviceWidth,
        frameHeight: pixelHeight,
        frameWidth: pixelWidth,
      });
      const calibrationKey = `${pixelWidth}x${pixelHeight}:${deviceWidth}x${deviceHeight}`;

      rawFramePixelSizeRef.current = {
        height: pixelHeight,
        width: pixelWidth,
      };

      if (frameAlreadyAligned) {
        liveViewportRef.current = null;
        liveCalibrationKeyRef.current = calibrationKey;
        if (!liveViewportAlignedRef.current) {
          updateLiveViewportAligned(true);
        }
        redrawLiveFrameRef.current = null;
        drawLiveSourceToCanvas(context, source, pixelHeight, pixelWidth);
      } else {
        const rawFrameSurface = ensureRawFrameSurface(pixelHeight, pixelWidth);
        if (!rawFrameSurface) {
          release?.();
          if (!hasFrameRef.current) {
            setConnectionState("error");
            setError("Unable to initialize the iOS stream.");
          }
          return;
        }

        rawFrameSurface.rawContext.drawImage(source, 0, 0, pixelWidth, pixelHeight);

        redrawLiveFrameRef.current = () => {
          drawLiveSourceToCanvas(context, rawFrameSurface.rawCanvas, pixelHeight, pixelWidth);
        };
        redrawLiveFrameRef.current();
      }

      if (!frameAlreadyAligned && liveCalibrationKeyRef.current !== calibrationKey) {
        void recalibrateLiveViewport();
      }
      release?.();

      metrics.markFrame({
        frameDecodeLatencyMs,
        frameAgeMs,
        frameTransportAgeMs,
        liveViewportAligned: liveViewportAlignedRef.current,
        pixelHeight,
        pixelWidth,
      });

      if (startupTimer != null) {
        window.clearTimeout(startupTimer);
        startupTimer = null;
      }
      if (!loggedFirstFrameOutput) {
        loggedFirstFrameOutput = true;
        debugLog("ios.viewer", "decoder.output.first_frame", {
          codec,
          frameAgeMs,
          frameDecodeLatencyMs,
          frameTransportAgeMs,
          pixelHeight,
          pixelWidth,
        });
      }
      hasFrameRef.current = true;
      setHasFrame(true);
      setConnectionState(
        controlSocketRef.current?.readyState === WebSocket.OPEN ? "connected" : "connecting",
      );
      setError(null);
    };

    const decodeJpegFrame = (frame: {
      capturedAtMs: number | null;
      payload: Uint8Array;
      receivedAtMs: number;
    }) => {
      jpegDecodeInFlight = true;
      const jpegBytes = frame.payload.buffer instanceof ArrayBuffer
        ? new Uint8Array(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
        : frame.payload.slice();
      void createImageBitmap(new Blob([jpegBytes], { type: "image/jpeg" }))
        .then((bitmap) => {
          if (disposed) {
            bitmap.close();
            return;
          }
          renderDecodedSource({
            decodedAtMs: Date.now(),
            frameCapturedAtMs: frame.capturedAtMs,
            pixelHeight: Math.max(bitmap.height, 1),
            pixelWidth: Math.max(bitmap.width, 1),
            receivedAtMs: frame.receivedAtMs,
            release: () => bitmap.close(),
            source: bitmap,
          });
        })
        .catch((decodeError) => {
          debugLog("ios.viewer", "jpeg.decode.error", {
            message: decodeError instanceof Error ? decodeError.message : String(decodeError),
          });
          if (!hasFrameRef.current) {
            const message = decodeError instanceof Error
              ? decodeError.message
              : "Unable to decode the iOS stream.";
            setConnectionState("error");
            setError(message);
          }
        })
        .finally(() => {
          jpegDecodeInFlight = false;
          const nextFrame = pendingJpegFrame;
          pendingJpegFrame = null;
          if (nextFrame) {
            decodeJpegFrame(nextFrame);
          }
        });
    };

    const queueJpegFrame = (frame: {
      capturedAtMs: number | null;
      payload: Uint8Array;
      receivedAtMs: number;
    }) => {
      if (jpegDecodeInFlight) {
        pendingJpegFrame = frame;
        return;
      }
      decodeJpegFrame(frame);
    };

    let decoder: VideoDecoder | null = null;

    const ensureDecoder = () => {
      if (decoder) {
        return decoder;
      }
      if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
        throw new Error("This browser cannot decode the iOS native stream.");
      }

      decoder = new VideoDecoder({
        output: (frame) => {
          if (disposed) {
            frame.close();
            return;
          }

          const decodedAtMs = Date.now();
          const frameTiming = typeof frame.timestamp === "number"
            ? frameTimings.get(frame.timestamp) ?? null
            : null;
          if (typeof frame.timestamp === "number") {
            frameTimings.delete(frame.timestamp);
          }
          renderDecodedSource({
            decodedAtMs,
            frameCapturedAtMs: frameTiming?.capturedAtMs ?? null,
            pixelHeight: Math.max(frame.displayHeight, 1),
            pixelWidth: Math.max(frame.displayWidth, 1),
            receivedAtMs: frameTiming?.receivedAtMs ?? null,
            release: () => frame.close(),
            source: frame,
          });
        },
        error: (decodeError) => {
          debugLog("ios.viewer", "decoder.output.error", {
            codec,
            message: decodeError.message,
          });
          if (!hasFrameRef.current) {
            setConnectionState("error");
            setError(decodeError.message || "Unable to decode the iOS stream.");
          }
        },
      });

      return decoder;
    };

    videoSocket.onopen = () => {
      setConnectionState("connecting");
      setError(null);
    };

    startupTimer = window.setTimeout(() => {
      if (!hasFrameRef.current) {
        debugLog("ios.viewer", "decoder.startup.timeout", {
          codec,
          decoderState: codec === "jpeg" || !decoder ? null : decoder.state,
        });
        setConnectionState("error");
        setError("The iOS stream is taking too long to start.");
      }
    }, 1_800);

    videoSocket.onmessage = (event) => {
      const handleBinaryPacket = (buffer: ArrayBuffer) => {
        const packet = new Uint8Array(buffer);
        const packetType = packet[0];
        const payload = packet.subarray(1);

        if (packetType === IOS_H264_PACKET_CONFIG) {
          configPacket = payload;
          return;
        }

        if (packetType !== IOS_H264_PACKET_KEY && packetType !== IOS_H264_PACKET_DELTA) {
          return;
        }

        const decoderState = codec === "jpeg" || !decoder ? null : decoder.state;
        if (!codec || (codec !== "jpeg" && decoderState !== "configured")) {
          if (!loggedFirstBinaryPacket) {
            loggedFirstBinaryPacket = true;
            debugLog("ios.viewer", codec === "jpeg" ? "jpeg.packet.ignored_until_configured" : "decoder.packet.ignored_until_configured", {
              codec,
              decoderState,
              packetType,
            });
          }
          return;
        }

        if (codec !== "jpeg" && packetType === IOS_H264_PACKET_DELTA && (decoder?.decodeQueueSize ?? 0) > 0) {
          return;
        }

        const capturedAtMs = readBigEndianUint64Number(payload);
        const receivedAtMs = Date.now();
        const payloadWithoutTimestamp = capturedAtMs != null
          ? payload.subarray(IOS_H264_PACKET_CAPTURE_TIMESTAMP_BYTES)
          : payload;

        if (codec === "jpeg") {
          if (!loggedFirstBinaryPacket) {
            loggedFirstBinaryPacket = true;
            debugLog("ios.viewer", "jpeg.packet.first", {
              payloadBytes: payloadWithoutTimestamp.byteLength,
            });
          }
          queueJpegFrame({
            capturedAtMs,
            payload: payloadWithoutTimestamp,
            receivedAtMs,
          });
          return;
        }

        const data = packetType === IOS_H264_PACKET_KEY && configPacket
          ? concatUint8Arrays(configPacket, payloadWithoutTimestamp)
          : payloadWithoutTimestamp;
        packetTimestamp = Math.max(
          packetTimestamp + VIDEO_CHUNK_INTERVAL_US,
          Math.round(performance.now() * 1_000),
        );

        try {
          const h264Decoder = ensureDecoder();
          if (!loggedFirstBinaryPacket) {
            loggedFirstBinaryPacket = true;
            debugLog("ios.viewer", "decoder.packet.first", {
              codec,
              configPacketBytes: configPacket?.byteLength ?? 0,
              decodeQueueSize: h264Decoder.decodeQueueSize,
              packetType,
              payloadBytes: payloadWithoutTimestamp.byteLength,
            });
          }
          if (capturedAtMs != null) {
            frameTimings.set(packetTimestamp, {
              capturedAtMs,
              receivedAtMs,
            });
            if (frameTimings.size > 24) {
              const oldestTimestamp = frameTimings.keys().next().value;
              if (typeof oldestTimestamp === "number") {
                frameTimings.delete(oldestTimestamp);
              }
            }
          }
          h264Decoder.decode(new EncodedVideoChunk({
            data,
            timestamp: packetTimestamp,
            type: packetType === IOS_H264_PACKET_KEY ? "key" : "delta",
          }));
        } catch (decodeError) {
          frameTimings.delete(packetTimestamp);
          debugLog("ios.viewer", "decoder.packet.error", {
            codec,
            message: decodeError instanceof Error ? decodeError.message : String(decodeError),
            packetType,
          });
          if (!hasFrameRef.current) {
            const message = decodeError instanceof Error
              ? decodeError.message
              : "Unable to decode the iOS stream.";
            setConnectionState("error");
            setError(message);
          }
        }
      };

      if (typeof event.data === "string") {
        try {
          const metadata = JSON.parse(event.data) as IosStreamMetadata;
          if (typeof metadata.codec === "string" && metadata.codec.length > 0 && metadata.codec !== codec) {
            codec = metadata.codec;
            if (codec === "jpeg") {
              debugLog("ios.viewer", "jpeg.configure.success", {
                codec,
              });
            } else {
              const h264Decoder = ensureDecoder();
              debugLog("ios.viewer", "decoder.configure.start", {
                codec,
              });
              h264Decoder.configure({
                codec,
                hardwareAcceleration: "prefer-hardware",
                optimizeForLatency: true,
              });
              debugLog("ios.viewer", "decoder.configure.success", {
                codec,
                decoderState: h264Decoder.state,
              });
            }
          }

          const pixelWidth = Number(metadata.pixelWidth);
          const pixelHeight = Number(metadata.pixelHeight);
          const pointWidth = Number(metadata.pointWidth);
          const pointHeight = Number(metadata.pointHeight);
          if (Number.isFinite(pointWidth) && Number.isFinite(pointHeight) && pointWidth > 0 && pointHeight > 0) {
            pointSizeRef.current = {
              height: pointHeight,
              width: pointWidth,
            };
          }
          if (Number.isFinite(pixelWidth) && Number.isFinite(pixelHeight) && pixelWidth > 0 && pixelHeight > 0) {
            rawFramePixelSizeRef.current = {
              height: pixelHeight,
              width: pixelWidth,
            };
          }
        } catch (metadataError) {
          debugLog("ios.viewer", "decoder.metadata.error", {
            message: metadataError instanceof Error ? metadataError.message : String(metadataError),
          });
          if (!hasFrameRef.current) {
            const message = metadataError instanceof Error
              ? metadataError.message
              : "Invalid iOS stream metadata.";
            setConnectionState("error");
            setError(message);
          }
        }
        return;
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then(handleBinaryPacket).catch((blobError) => {
          if (!hasFrameRef.current) {
            const message = blobError instanceof Error
              ? blobError.message
              : "Unable to read the iOS stream packet.";
            setConnectionState("error");
            setError(message);
          }
        });
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        handleBinaryPacket(event.data);
      }
    };

    videoSocket.onerror = () => {
      debugLog("ios.viewer", "socket.error", {
        codec,
        decoderState: codec === "jpeg" || !decoder ? null : decoder.state,
      });
      if (!hasFrameRef.current) {
        setConnectionState("error");
        setError("The iOS stream failed to start.");
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

      debugLog("ios.viewer", "socket.close", {
        code: closeEvent.code,
        codec,
        decoderState: codec === "jpeg" || !decoder ? null : decoder.state,
        reason: closeEvent.reason,
      });
      setConnectionState("error");
      setError(closeEvent.reason || "The iOS stream disconnected.");
    };

    return () => {
      disposed = true;
      if (startupTimer != null) {
        window.clearTimeout(startupTimer);
      }
      videoSocket.close();
      if (decoder && decoder.state !== "closed") {
        decoder.close();
      }
    };
  }, [liveAttempt, metrics, urls.screenshot, urls.video]);

  const restartLiveStream = () => {
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);
    setLiveAttempt((current) => current + 1);
  };

  const focusKeyboardInput = () => {
    keyboardActiveRef.current = true;
    keyboardInputRef.current?.focus({
      preventScroll: true,
    });
  };

  const dismissKeyboardInput = () => {
    flushKeyboardTextBuffer();
    keyboardActiveRef.current = false;
    keyboardInputRef.current?.blur();
    setKeyboardBridgeFocused(false);
  };

  const setSoftwareKeyboardVisible = (visible: boolean) => {
    sendControl({
      t: "system",
      name: visible ? "show_keyboard" : "hide_keyboard",
    });
  };

  const toggleKeyboardInput = (closeKeyboard = false) => {
    const input = keyboardInputRef.current;
    if (!input) {
      return;
    }

    if (closeKeyboard || document.activeElement === input || keyboardBridgeFocused) {
      dismissKeyboardInput();
      setSoftwareKeyboardVisible(false);
      canvasRef.current?.focus({
        preventScroll: true,
      });
      return;
    }

    setSoftwareKeyboardVisible(true);
    focusKeyboardInput();
  };

  const flushKeyboardTextBuffer = () => {
    if (keyboardFlushTimerRef.current != null) {
      window.clearTimeout(keyboardFlushTimerRef.current);
      keyboardFlushTimerRef.current = null;
    }

    const pendingText = keyboardTextBufferRef.current;
    keyboardTextBufferRef.current = "";
    if (pendingText.length === 0) {
      return;
    }

    sendControl({
      t: "text",
      text: pendingText,
    });
  };

  const queueKeyboardText = (text: string) => {
    if (text.length === 0) {
      return;
    }

    keyboardTextBufferRef.current += text;
    if (keyboardFlushTimerRef.current != null) {
      return;
    }

    keyboardFlushTimerRef.current = window.setTimeout(() => {
      flushKeyboardTextBuffer();
    }, 24);
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

    const action = typeof payload.t === "string" ? payload.t : "unknown";
    const isPointerGestureAction = action === "drag" || action === "tap" || action === "touch" || action === "swipe" || action === "system";
    const gestureToControlMs = isPointerGestureAction && pointerGestureStartedAtRef.current != null
      ? Math.max(performance.now() - pointerGestureStartedAtRef.current, 0)
      : null;
    const isTouchDownAction = action === "touch" && payload.phase === "down";
    if (isPointerGestureAction && !isTouchDownAction) {
      pointerGestureStartedAtRef.current = null;
    }

    metrics.markControl(action, {
      gestureToControlMs: gestureToControlMs != null ? Math.round(gestureToControlMs * 10) / 10 : null,
      mode: "live",
    });
    socket.send(JSON.stringify(payload));
  };

  useEffect(() => () => {
    const activeDrag = dragStateRef.current;
    dragStateRef.current = null;
    if (!activeDrag) {
      return;
    }

    clearDragTouchTimer(activeDrag);
    clearDragFlushTimer(activeDrag);
    if (activeDrag.dragActive || activeDrag.dragPoints.length > 0) {
      flushDragGesture(activeDrag, true);
      return;
    }

    if (activeDrag.touchDownSent) {
      sendControl({
        phase: "up",
        t: "touch",
        x: activeDrag.x,
        y: activeDrag.y,
      });
    }
  }, []);

  const sendKeyboardText = (text: string) => {
    if (text.length === 0) {
      return;
    }

    queueKeyboardText(text);
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

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) {
        keyboardActiveRef.current = false;
        return;
      }

      if (!root.contains(event.target as Node | null)) {
        keyboardActiveRef.current = false;
        flushKeyboardTextBuffer();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!keyboardActiveRef.current || isEditableTarget(event.target)) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const specialKey = IOS_SPECIAL_KEY_MAP[event.key];
      if (specialKey) {
        event.preventDefault();
        flushKeyboardTextBuffer();
        sendKeyboardKey(specialKey, event.key === "Enter" ? 0.1 : undefined);
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      event.preventDefault();
      sendKeyboardText(event.key);
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (!keyboardActiveRef.current || isEditableTarget(event.target)) {
        return;
      }

      const pastedText = event.clipboardData?.getData("text/plain") ?? "";
      if (pastedText.length === 0) {
        return;
      }

      event.preventDefault();
      sendKeyboardText(pastedText);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("paste", handlePaste, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("paste", handlePaste, true);
      flushKeyboardTextBuffer();
      keyboardActiveRef.current = false;
    };
  }, []);

  const getInteractivePoint = (clientX: number, clientY: number) => {
    const element = canvasRef.current;
    if (!element) {
      return null;
    }

    return mapClientPointToDevice({
      clientX,
      clientY,
      contentHeight: framePixelSizeRef.current.height,
      contentWidth: framePixelSizeRef.current.width,
      deviceHeight: pointSizeRef.current.height,
      deviceWidth: pointSizeRef.current.width,
      element,
    });
  };

  const clearDragTouchTimer = (dragState: DragState) => {
    if (dragState.touchTimer != null) {
      window.clearTimeout(dragState.touchTimer);
      dragState.touchTimer = null;
    }
  };

  const clearDragFlushTimer = (dragState: DragState) => {
    if (dragState.dragFlushTimer != null) {
      window.clearTimeout(dragState.dragFlushTimer);
      dragState.dragFlushTimer = null;
    }
  };

  const queueDragPoint = (args: {
    activeDrag: DragState;
    atMs: number;
    clientX: number;
    clientY: number;
    point: { x: number; y: number };
  }): boolean => {
    const { activeDrag, atMs, clientX, clientY, point } = args;
    const clientDx = clientX - activeDrag.lastPathClientX;
    const clientDy = clientY - activeDrag.lastPathClientY;
    const elapsedMs = atMs - activeDrag.lastPathAtMs;

    if (activeDrag.dragPoints.length > 0 && !shouldAppendIosGesturePathPoint({
      clientDx,
      clientDy,
      elapsedMs,
    })) {
      return false;
    }

    activeDrag.dragPoints.push({
      atMs,
      x: point.x,
      y: point.y,
    });
    activeDrag.lastPathAtMs = atMs;
    activeDrag.lastPathClientX = clientX;
    activeDrag.lastPathClientY = clientY;
    activeDrag.x = point.x;
    activeDrag.y = point.y;
    return true;
  };

  const flushDragGesture = (activeDrag: DragState, end: boolean) => {
    clearDragFlushTimer(activeDrag);

    const points = activeDrag.dragPoints.length > 0
      ? [...activeDrag.dragPoints]
      : end
        ? [{
          atMs: performance.now(),
          x: activeDrag.x,
          y: activeDrag.y,
        }]
        : [];
    if (points.length === 0) {
      return;
    }

    activeDrag.dragPoints = [];
    sendControl(buildIosDragPayload({
      phase: end ? "end" : (activeDrag.dragActive || activeDrag.touchDownSent) ? "move" : "start",
      points,
    }) satisfies IosControlPayload);
    activeDrag.dragActive = !end;
  };

  const scheduleDragFlush = (activeDrag: DragState) => {
    if (activeDrag.dragFlushTimer != null) {
      return;
    }

    activeDrag.dragFlushTimer = window.setTimeout(() => {
      const currentDrag = dragStateRef.current;
      if (!currentDrag || currentDrag.pointerId !== activeDrag.pointerId) {
        return;
      }

      flushDragGesture(currentDrag, false);
    }, IOS_GESTURE_PATH_FLUSH_INTERVAL_MS);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!screenInteractionEnabled) {
      return;
    }

    event.currentTarget.focus({
      preventScroll: true,
    });
    focusKeyboardInput();
    const point = getInteractivePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    dragStateRef.current = {
      axis: null,
      dragActive: false,
      dragFlushTimer: null,
      dragPoints: [],
      edge: detectIosGestureEdge({
        deviceHeight: pointSizeRef.current.height,
        deviceWidth: pointSizeRef.current.width,
        startX: point.x,
        startY: point.y,
      }),
      lastPathAtMs: performance.now(),
      lastPathClientX: event.clientX,
      lastPathClientY: event.clientY,
      moved: false,
      moveStartedAt: null,
      pointerId: event.pointerId,
      scrollIntent: false,
      startAtMs: performance.now(),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: point.x,
      startY: point.y,
      touchDownSent: false,
      touchTimer: null,
      x: point.x,
      y: point.y,
    };
    pointerGestureStartedAtRef.current = performance.now();

    const touchTimer = window.setTimeout(() => {
      const activeDrag = dragStateRef.current;
      if (!activeDrag || activeDrag.pointerId !== event.pointerId || activeDrag.moved || activeDrag.touchDownSent) {
        return;
      }

      sendControl({
        phase: "down",
        t: "touch",
        x: activeDrag.startX,
        y: activeDrag.startY,
      });
      dragStateRef.current = {
        ...activeDrag,
        touchDownSent: true,
        touchTimer: null,
      };
    }, IOS_TOUCH_DOWN_DELAY_LIVE_MS);
    dragStateRef.current.touchTimer = touchTimer;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!screenInteractionEnabled) {
      return;
    }

    const activeDrag = dragStateRef.current;
    if (!activeDrag) {
      return;
    }

    const point = getInteractivePoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    const now = Date.now();
    const nowMs = performance.now();
    const clientDx = event.clientX - activeDrag.startClientX;
    const clientDy = event.clientY - activeDrag.startClientY;
    const clientDistance = Math.hypot(clientDx, clientDy);
    const axis = resolveIosGestureAxis({
      clientDx,
      clientDy,
      edge: activeDrag.edge,
      lockedAxis: activeDrag.axis,
    });
    const scrollIntent = activeDrag.scrollIntent || axis !== null;
    const moved = activeDrag.moved || clientDistance > IOS_GESTURE_TAP_SLOP_CSS_PX || scrollIntent;
    const moveStartedAt = moved
      ? activeDrag.moveStartedAt ?? now
      : activeDrag.moveStartedAt;
    const shouldCancelTouchDown = scrollIntent || clientDistance >= IOS_GESTURE_TOUCH_CANCEL_DISTANCE_CSS_PX;
    if (shouldCancelTouchDown) {
      clearDragTouchTimer(activeDrag);
    }

    const nextDragState: DragState = {
      ...activeDrag,
      axis,
      moved,
      moveStartedAt,
      scrollIntent,
      touchTimer: shouldCancelTouchDown ? null : activeDrag.touchTimer,
      x: point.x,
      y: point.y,
    };

    const shouldContinueAsDrag = (!nextDragState.touchDownSent && scrollIntent)
      || (nextDragState.touchDownSent && clientDistance >= IOS_GESTURE_TOUCH_CANCEL_DISTANCE_CSS_PX);

    if (shouldContinueAsDrag) {
      if (!nextDragState.touchDownSent && !nextDragState.dragActive && nextDragState.dragPoints.length === 0) {
        nextDragState.dragPoints.push({
          atMs: nextDragState.startAtMs,
          x: nextDragState.startX,
          y: nextDragState.startY,
        });
      }

      const queued = queueDragPoint({
        activeDrag: nextDragState,
        atMs: nowMs,
        clientX: event.clientX,
        clientY: event.clientY,
        point,
      });
      dragStateRef.current = nextDragState;
      if (!queued) {
        return;
      }

      if (!nextDragState.dragActive) {
        flushDragGesture(nextDragState, false);
      } else {
        scheduleDragFlush(nextDragState);
      }
      return;
    }

    dragStateRef.current = nextDragState;
  };

  const finishPointerGesture = (event: React.PointerEvent<HTMLElement>) => {
    if (!screenInteractionEnabled) {
      return;
    }

    const activeDrag = dragStateRef.current;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!activeDrag) {
      return;
    }
    if (activeDrag.touchTimer != null) {
      clearDragTouchTimer(activeDrag);
    }
    clearDragFlushTimer(activeDrag);

    const point = getInteractivePoint(event.clientX, event.clientY) ?? { x: activeDrag.x, y: activeDrag.y };
    const clientDx = event.clientX - activeDrag.startClientX;
    const clientDy = event.clientY - activeDrag.startClientY;
    const clientDistance = Math.hypot(clientDx, clientDy);

    if (!activeDrag.scrollIntent && clientDistance <= IOS_GESTURE_TAP_SLOP_CSS_PX) {
      if (activeDrag.touchDownSent) {
        sendControl({
          phase: "up",
          t: "touch",
          x: point.x,
          y: point.y,
        });
        return;
      }

      sendControl({
        t: "tap",
        x: point.x,
        y: point.y,
      });
      return;
    }

    if (!activeDrag.touchDownSent) {
      const shouldStartDrag = activeDrag.scrollIntent || clientDistance > IOS_GESTURE_PATH_POINT_MIN_DISTANCE_CSS_PX;
      if (!shouldStartDrag) {
        return;
      }

      if (!activeDrag.dragActive && activeDrag.dragPoints.length === 0) {
        activeDrag.dragPoints.push({
          atMs: activeDrag.startAtMs,
          x: activeDrag.startX,
          y: activeDrag.startY,
        });
      }
      queueDragPoint({
        activeDrag,
        atMs: performance.now(),
        clientX: event.clientX,
        clientY: event.clientY,
        point,
      });
      flushDragGesture(activeDrag, true);
      return;
    }

    const shouldEndTouchAsDrag = activeDrag.dragActive
      || activeDrag.scrollIntent
      || clientDistance >= IOS_GESTURE_TOUCH_CANCEL_DISTANCE_CSS_PX;
    if (shouldEndTouchAsDrag) {
      queueDragPoint({
        activeDrag,
        atMs: performance.now(),
        clientX: event.clientX,
        clientY: event.clientY,
        point,
      });
      flushDragGesture(activeDrag, true);
      return;
    }

    if (activeDrag.touchDownSent) {
      sendControl({
        phase: "up",
        t: "touch",
        x: point.x,
        y: point.y,
      });
    }
  };

  const statusLabel = connectionState === "connected"
    ? liveViewportAligned
      ? "Streaming"
      : "Aligning"
    : connectionState === "connecting"
      ? "Connecting"
      : connectionState === "disconnected"
        ? "Disconnected"
        : "Error";

  const overlayMessage = error
    ? normalizeIosStreamMessage(error)
    : connectionState === "connecting"
      ? "Starting the iOS stream directly in this panel."
      : "Streaming iOS directly in this panel.";
  const showMobileKeyboardBridge = showMobileViewerControls && keyboardBridgeFocused;

  return (
    <div
      ref={rootRef}
      data-device-viewer="ios-native"
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.12),_transparent_48%),linear-gradient(180deg,_rgba(9,9,11,0.96),_rgba(2,6,23,0.98))]",
        viewerExpanded && "fixed inset-0 z-[90]",
      )}
    >
      <textarea
        ref={keyboardInputRef}
        aria-label="iOS keyboard bridge"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className={cn(
          showMobileKeyboardBridge
            ? "absolute inset-x-3 bottom-3 z-30 min-h-11 rounded-2xl border border-white/15 bg-black/45 px-3 py-2 text-sm text-white shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-md placeholder:text-white/45"
            : "pointer-events-none absolute left-0 top-0 h-px w-px opacity-0",
        )}
        enterKeyHint="done"
        inputMode="text"
        placeholder={showMobileKeyboardBridge ? "Type into iOS" : undefined}
        spellCheck={false}
        tabIndex={-1}
        onBlur={() => {
          flushKeyboardTextBuffer();
          keyboardActiveRef.current = false;
          setKeyboardBridgeFocused(false);
        }}
        onFocus={() => {
          keyboardActiveRef.current = true;
          setKeyboardBridgeFocused(true);
        }}
        onInput={handleKeyboardInput}
        onKeyDown={handleKeyboardKeyDown}
      />

      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

      {showMobileViewerControls ? (
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white",
              keyboardBridgeFocused && "bg-white/12 text-white",
            )}
            aria-label={keyboardBridgeFocused ? "Hide iOS keyboard" : "Show iOS keyboard"}
            title={keyboardBridgeFocused ? "Hide iOS keyboard" : "Show iOS keyboard"}
            onPointerDown={() => {
              keyboardToggleSnapshotRef.current = document.activeElement === keyboardInputRef.current || keyboardBridgeFocused;
            }}
            onClick={() => {
              toggleKeyboardInput(keyboardToggleSnapshotRef.current);
              keyboardToggleSnapshotRef.current = false;
            }}
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white"
            aria-label="iOS Shake"
            title="iOS Shake"
            onClick={() => sendControl({ t: "system", name: "shake" })}
          >
            <Smartphone className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white"
            aria-label={viewerExpanded ? "Exit iOS fullscreen" : "iOS fullscreen"}
            title={viewerExpanded ? "Exit iOS fullscreen" : "iOS fullscreen"}
            onClick={() => setViewerExpanded((current) => !current)}
          >
            {viewerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full border border-white/10 bg-black/45 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,0.25)] hover:bg-white/10 hover:text-white"
            aria-label="iOS Power"
            title="iOS Power"
            onClick={() => sendControl({ t: "button", button: "lock" })}
          >
            <Lock className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <div ref={containerRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 pt-3">
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

        {hasFrame && !liveViewportAligned ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/10 px-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-[11px] font-medium text-white/80 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>Aligning simulator viewport…</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 justify-center px-3 pb-3 pt-1">
        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 shadow-[0_16px_48px_rgba(0,0,0,0.35)] backdrop-blur-md">
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
          {!showMobileViewerControls ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white",
                keyboardBridgeFocused && "bg-white/12 text-white",
              )}
              aria-label={keyboardBridgeFocused ? "Hide iOS keyboard" : "Show iOS keyboard"}
              onPointerDown={() => {
                keyboardToggleSnapshotRef.current = document.activeElement === keyboardInputRef.current || keyboardBridgeFocused;
              }}
              onClick={() => {
                toggleKeyboardInput(keyboardToggleSnapshotRef.current);
                keyboardToggleSnapshotRef.current = false;
              }}
            >
              <Keyboard className="h-4 w-4" />
            </Button>
          ) : null}
          {!showMobileViewerControls ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full text-white/80 hover:bg-white/10 hover:text-white"
              aria-label="iOS Shake"
              onClick={() => sendControl({ t: "system", name: "shake" })}
            >
              <Smartphone className="h-4 w-4" />
            </Button>
          ) : null}
          {!showMobileViewerControls ? (
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
