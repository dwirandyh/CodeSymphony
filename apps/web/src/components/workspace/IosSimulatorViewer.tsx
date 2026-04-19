import { useEffect, useMemo, useRef, useState } from "react";
import type { IosDeviceStreamProtocol } from "@codesymphony/shared-types";
import { House, LoaderCircle, Lock, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "../ui/button";
import { api } from "../../lib/api";

type IosSimulatorViewerProps = {
  controlTransport?: "iframe" | "none" | "websocket";
  deviceName: string;
  iosStreamProtocol?: IosDeviceStreamProtocol | null;
  nativeBaseUrl?: string | null;
  platformSessionId?: string | null;
  sessionId: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
type MediaMode = "live" | "fallback";

type ViewportRect = {
  height: number;
  left: number;
  top: number;
  width: number;
};

type DragState = {
  moved: boolean;
  pointerId: number;
  startAt: number;
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

type IosVideoFrame = {
  data: string;
  pixel_height?: number;
  pixel_width?: number;
  point_height?: number;
  point_width?: number;
  type?: string;
};

type IosControlPayload = Record<string, number | string>;

type IosStreamMetadata = {
  codec?: string;
  pointHeight?: number;
  pointWidth?: number;
  pixelHeight?: number;
  pixelWidth?: number;
};

const FALLBACK_SCREENSHOT_POLL_INTERVAL_MS = 1_250;
const FALLBACK_REFRESH_AFTER_ACTION_MS = [120, 700];
const IOS_H264_PACKET_CONFIG = 1;
const IOS_H264_PACKET_KEY = 2;
const IOS_H264_PACKET_DELTA = 3;
const IOS_GESTURE_TAP_SLOP_CSS_PX = 12;
const IOS_LIVE_CALIBRATION_SCALES = [0.88, 0.92, 0.96, 1, 1.04, 1.08];
const IOS_LIVE_CALIBRATION_COARSE_SEARCH_MARGIN_PX = 96;
const IOS_LIVE_CALIBRATION_FINE_SEARCH_MARGIN_PX = 12;
const IOS_LIVE_CALIBRATION_COARSE_STEP_PX = 3;
const IOS_LIVE_CALIBRATION_SAMPLE_HEIGHT = 56;
const IOS_LIVE_CALIBRATION_SAMPLE_WIDTH = 28;
const IOS_LIVE_CALIBRATION_ATTEMPT_INTERVAL_MS = 650;
const IOS_LIVE_CALIBRATION_RETRY_DELAY_MS = 900;
const IOS_LIVE_ALIGNMENT_ASPECT_TOLERANCE = 0.012;
const IOS_TOUCH_DOWN_DELAY_MS = 140;
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

function supportsIosLiveViewer(streamProtocol: IosDeviceStreamProtocol | null | undefined): boolean {
  if (typeof window === "undefined" || typeof WebSocket !== "function") {
    return false;
  }

  if (streamProtocol === "webcodecs-h264") {
    return typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function";
  }

  return true;
}

function buildDirectIosWebSocketUrl(baseUrl: string, platformSessionId: string, channel: "control" | "video"): string {
  const websocketBase = new URL(baseUrl);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  return new URL(`/ws/${encodeURIComponent(platformSessionId)}/${channel}`, websocketBase).toString();
}

function buildIosViewerUrls(args: {
  controlTransport?: "iframe" | "none" | "websocket";
  nativeBaseUrl?: string | null;
  platformSessionId?: string | null;
  sessionId: string;
}) {
  const { controlTransport = "websocket", nativeBaseUrl, platformSessionId, sessionId } = args;
  const httpBase = new URL(api.runtimeBaseUrl);
  const websocketBase = new URL(api.runtimeBaseUrl);
  websocketBase.protocol = websocketBase.protocol === "https:" ? "wss:" : "ws:";
  const encodedSessionId = encodeURIComponent(sessionId);
  const hasDirectWebSocketTarget = typeof nativeBaseUrl === "string"
    && nativeBaseUrl.length > 0
    && typeof platformSessionId === "string"
    && platformSessionId.length > 0;

  return {
    control: controlTransport === "websocket"
      ? hasDirectWebSocketTarget
      ? buildDirectIosWebSocketUrl(nativeBaseUrl, platformSessionId, "control")
      : new URL(`/api/device-streams/${encodedSessionId}/native/control`, websocketBase).toString()
      : null,
    screenshot: controlTransport === "websocket"
      ? new URL(`/api/device-streams/${encodedSessionId}/native/screenshot`, httpBase).toString()
      : null,
    status: controlTransport === "websocket"
      ? new URL(`/api/device-streams/${encodedSessionId}/native/status`, httpBase).toString()
      : null,
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

  const targetContext = targetCanvas.getContext("2d", { willReadFrequently: true });
  const candidateContext = candidateCanvas.getContext("2d", { willReadFrequently: true });
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

export function IosSimulatorViewer({
  controlTransport = "websocket",
  deviceName,
  iosStreamProtocol = null,
  nativeBaseUrl = null,
  platformSessionId = null,
  sessionId,
}: IosSimulatorViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const keyboardInputRef = useRef<HTMLTextAreaElement | null>(null);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const pointSizeRef = useRef({ height: 844, width: 390 });
  const framePixelSizeRef = useRef({ height: 844, width: 390 });
  const rawFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rawFramePixelSizeRef = useRef({ height: 844, width: 390 });
  const dragStateRef = useRef<DragState | null>(null);
  const screenshotAbortRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const fallbackRefreshTimerRef = useRef<number | null>(null);
  const controlReconnectTimerRef = useRef<number | null>(null);
  const liveCalibrationInFlightRef = useRef(false);
  const liveCalibrationKeyRef = useRef("");
  const liveCalibrationAttemptAtRef = useRef(0);
  const liveCalibrationRetryTimerRef = useRef<number | null>(null);
  const liveViewportRef = useRef<ViewportRect | null>(null);
  const redrawLiveFrameRef = useRef<(() => void) | null>(null);
  const actionRefreshTimersRef = useRef<number[]>([]);
  const keyboardActiveRef = useRef(false);
  const keyboardFlushTimerRef = useRef<number | null>(null);
  const keyboardTextBufferRef = useRef("");
  const hasFrameRef = useRef(false);
  const liveViewportAlignedRef = useRef(false);
  const mediaModeRef = useRef<MediaMode>(supportsIosLiveViewer(iosStreamProtocol) ? "live" : "fallback");
  const requestFallbackRefreshRef = useRef<() => void>(() => undefined);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    supportsIosLiveViewer(iosStreamProtocol) ? "connecting" : "error",
  );
  const [error, setError] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [liveAttempt, setLiveAttempt] = useState(0);
  const [liveViewportAligned, setLiveViewportAligned] = useState(false);
  const [mediaMode, setMediaMode] = useState<MediaMode>(supportsIosLiveViewer(iosStreamProtocol) ? "live" : "fallback");

  const urls = useMemo(() => buildIosViewerUrls({
    controlTransport,
    nativeBaseUrl,
    platformSessionId,
    sessionId,
  }), [controlTransport, nativeBaseUrl, platformSessionId, sessionId]);

  const usesRuntimeNativeControl = !nativeBaseUrl && !platformSessionId;
  const controlEnabled = controlTransport === "websocket" && typeof urls.control === "string";
  const screenInteractionEnabled = controlEnabled && (mediaMode !== "live" || liveViewportAligned);

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
    const container = containerRef.current;
    const boundsWidth = Math.max(container?.clientWidth ?? viewport.width, 1);
    const boundsHeight = Math.max(container?.clientHeight ?? viewport.height, 1);
    const displayBox = getContainedContentBox(boundsHeight, boundsWidth, viewport.height, viewport.width);
    const displayWidth = Math.max(Math.round(displayBox.width), 1);
    const displayHeight = Math.max(Math.round(displayBox.height), 1);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderWidth = Math.max(Math.round(displayWidth * pixelRatio), 1);
    const renderHeight = Math.max(Math.round(displayHeight * pixelRatio), 1);
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

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

  const recalibrateLiveViewport = async () => {
    if (!urls.screenshot || liveCalibrationInFlightRef.current) {
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

  useEffect(() => {
    mediaModeRef.current = mediaMode;
  }, [mediaMode]);

  useEffect(() => {
    const liveSupported = supportsIosLiveViewer(iosStreamProtocol);
    setMediaMode(liveSupported ? "live" : "fallback");
    setConnectionState(liveSupported ? "connecting" : "error");
    if (!liveSupported) {
      setError("This browser cannot decode the native iOS simulator stream.");
    }
  }, [iosStreamProtocol]);

  const loadPointDimensions = async () => {
    if (!urls.status) {
      return;
    }

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
    const closeExistingSocket = () => {
      const existing = controlSocketRef.current;
      controlSocketRef.current = null;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        existing.close();
      }
    };

    if (!controlEnabled || !urls.control) {
      closeExistingSocket();
      setConnectionState((current) => (current === "connected" ? current : "connecting"));
      return;
    }

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
      if (!urls.control) {
        return;
      }

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
          // Ignore non-JSON messages from the control bridge.
        }
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
  }, [controlEnabled, urls.control]);

  useEffect(() => {
    if (mediaMode !== "live") {
      return;
    }

    if (!supportsIosLiveViewer(iosStreamProtocol)) {
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
    let startupFallbackTimer: number | null = null;

    clearLiveCalibration();
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);

    const switchToFallback = (message: string) => {
      if (disposed) {
        return;
      }

      if (startupFallbackTimer != null) {
        window.clearTimeout(startupFallbackTimer);
        startupFallbackTimer = null;
      }

      hasFrameRef.current = false;
      setHasFrame(false);
      setConnectionState(controlEnabled ? "connecting" : "connected");
      setError(message);
      setMediaMode("fallback");
    };

    const videoSocket = new WebSocket(urls.video);
    videoSocket.binaryType = "arraybuffer";

    if (iosStreamProtocol === "webcodecs-h264") {
      let codec = "";
      let configPacket: Uint8Array | null = null;
      let packetTimestamp = 0;

      const decoder = new VideoDecoder({
        output: (frame) => {
          if (disposed) {
            frame.close();
            return;
          }

          let rawCanvas = rawFrameCanvasRef.current;
          if (!rawCanvas) {
            rawCanvas = document.createElement("canvas");
            rawFrameCanvasRef.current = rawCanvas;
          }

          if (rawCanvas.width !== frame.displayWidth || rawCanvas.height !== frame.displayHeight) {
            rawCanvas.width = frame.displayWidth;
            rawCanvas.height = frame.displayHeight;
          }

          const rawContext = rawCanvas.getContext("2d");
          if (!rawContext) {
            frame.close();
            if (!hasFrameRef.current) {
              switchToFallback("Unable to initialize the iOS live frame surface.");
            }
            return;
          }

          rawContext.drawImage(frame, 0, 0, rawCanvas.width, rawCanvas.height);
          frame.close();

          rawFramePixelSizeRef.current = {
            height: rawCanvas.height,
            width: rawCanvas.width,
          };
          if (!liveViewportAlignedRef.current && frameLikelyMatchesDeviceAspect({
            deviceHeight: pointSizeRef.current.height,
            deviceWidth: pointSizeRef.current.width,
            frameHeight: rawCanvas.height,
            frameWidth: rawCanvas.width,
          })) {
            updateLiveViewportAligned(true);
          }
          redrawLiveFrameRef.current = () => {
            drawLiveSourceToCanvas(context, rawCanvas as HTMLCanvasElement, rawCanvas.height, rawCanvas.width);
          };
          redrawLiveFrameRef.current();
          void recalibrateLiveViewport();

          if (startupFallbackTimer != null) {
            window.clearTimeout(startupFallbackTimer);
            startupFallbackTimer = null;
          }
          hasFrameRef.current = true;
          setHasFrame(true);
          setConnectionState(
            controlEnabled
              ? controlSocketRef.current?.readyState === WebSocket.OPEN ? "connected" : "connecting"
              : "connected",
          );
          setError(null);
        },
        error: (decodeError) => {
          if (!hasFrameRef.current) {
            switchToFallback(decodeError.message || "Failed to decode the iOS simulator stream.");
          }
        },
      });

      videoSocket.onopen = () => {
        setConnectionState("connecting");
        setError(null);
      };

      startupFallbackTimer = window.setTimeout(() => {
        if (!hasFrameRef.current) {
          switchToFallback("Live iOS stream is taking too long. Switching to compatibility view.");
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

          if (!codec || decoder.state !== "configured") {
            return;
          }

          if (packetType === IOS_H264_PACKET_DELTA && decoder.decodeQueueSize > 2) {
            return;
          }

          const data = packetType === IOS_H264_PACKET_KEY && configPacket
            ? concatUint8Arrays(configPacket, payload)
            : payload;
          packetTimestamp = Math.max(
            packetTimestamp + VIDEO_CHUNK_INTERVAL_US,
            Math.round(performance.now() * 1_000),
          );

          try {
            decoder.decode(new EncodedVideoChunk({
              data,
              timestamp: packetTimestamp,
              type: packetType === IOS_H264_PACKET_KEY ? "key" : "delta",
            }));
          } catch (decodeError) {
            if (!hasFrameRef.current) {
              const message = decodeError instanceof Error
                ? decodeError.message
                : "Failed to decode the iOS simulator frame.";
              switchToFallback(message);
            }
          }
        };

        if (typeof event.data === "string") {
          try {
            const metadata = JSON.parse(event.data) as IosStreamMetadata;
            if (typeof metadata.codec === "string" && metadata.codec.length > 0 && metadata.codec !== codec) {
              codec = metadata.codec;
              decoder.configure({
                codec,
                optimizeForLatency: true,
              });
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
              if (
                usesRuntimeNativeControl
                && (pointSizeRef.current.width <= 0 || pointSizeRef.current.height <= 0)
              ) {
                pointSizeRef.current = {
                  height: pixelHeight,
                  width: pixelWidth,
                };
              }
            }
          } catch (metadataError) {
            if (!hasFrameRef.current) {
              const message = metadataError instanceof Error
                ? metadataError.message
                : "Invalid iOS stream metadata.";
              switchToFallback(message);
            }
          }
          return;
        }

        if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then(handleBinaryPacket).catch((blobError) => {
            if (!hasFrameRef.current) {
              const message = blobError instanceof Error
                ? blobError.message
                : "Failed to read the iOS simulator packet.";
              switchToFallback(message);
            }
          });
          return;
        }

        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }

        handleBinaryPacket(event.data);
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
        if (startupFallbackTimer != null) {
          window.clearTimeout(startupFallbackTimer);
          startupFallbackTimer = null;
        }
        videoSocket.close();
        decoder.close();
      };
    }

    let isProcessingFrame = false;
    let pendingFrame: IosVideoFrame | null = null;

    const drawLiveFrame = (image: HTMLImageElement, pixelWidth: number, pixelHeight: number) => {
      rawFramePixelSizeRef.current = {
        height: pixelHeight,
        width: pixelWidth,
      };
      drawLiveSourceToCanvas(context, image, pixelHeight, pixelWidth);
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
  }, [controlEnabled, iosStreamProtocol, liveAttempt, mediaMode, urls.video]);

  useEffect(() => {
    if (mediaMode !== "fallback") {
      requestFallbackRefreshRef.current = () => undefined;
      return;
    }

    if (!urls.screenshot) {
      setConnectionState("error");
      setError("Fallback mode is unavailable because no iOS control bridge is configured.");
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
    liveViewportRef.current = null;
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
        if (!urls.screenshot) {
          throw new Error("No screenshot endpoint is available for this iOS fallback session.");
        }

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
        if (usesRuntimeNativeControl || pointSizeRef.current.width <= 0 || pointSizeRef.current.height <= 0) {
          pointSizeRef.current = dimensions;
        }

        if (!disposed) {
          hasFrameRef.current = true;
          setHasFrame(true);
          setConnectionState(
            controlEnabled
              ? controlSocketRef.current?.readyState === WebSocket.OPEN ? "connected" : "connecting"
              : "connected",
          );
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
  }, [controlEnabled, mediaMode, urls.screenshot, urls.status, usesRuntimeNativeControl]);

  const restartLiveStream = () => {
    hasFrameRef.current = false;
    setHasFrame(false);
    setConnectionState("connecting");
    setError(null);
    setMediaMode("live");
    setLiveAttempt((current) => current + 1);
  };

  const focusKeyboardInput = () => {
    keyboardActiveRef.current = true;
    keyboardInputRef.current?.focus({
      preventScroll: true,
    });
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
    if (!controlEnabled) {
      setError("iOS control is not configured for this simulator session.");
      return;
    }

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
      moved: false,
      pointerId: event.pointerId,
      startAt: Date.now(),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: point.x,
      startY: point.y,
      touchDownSent: false,
      touchTimer: null,
      x: point.x,
      y: point.y,
    };
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
    }, IOS_TOUCH_DOWN_DELAY_MS);
    dragStateRef.current.touchTimer = touchTimer;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
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

    const clientDx = event.clientX - activeDrag.startClientX;
    const clientDy = event.clientY - activeDrag.startClientY;
    const clientDistance = Math.sqrt(clientDx * clientDx + clientDy * clientDy);
    const moved = activeDrag.moved || clientDistance > IOS_GESTURE_TAP_SLOP_CSS_PX;
    if (moved && activeDrag.touchTimer != null) {
      window.clearTimeout(activeDrag.touchTimer);
    }

    dragStateRef.current = {
      ...activeDrag,
      moved,
      touchTimer: moved ? null : activeDrag.touchTimer,
      x: point.x,
      y: point.y,
    };
  };

  const finishPointerGesture = (event: React.PointerEvent<HTMLCanvasElement>) => {
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
      window.clearTimeout(activeDrag.touchTimer);
    }

    const point = getInteractivePoint(event.clientX, event.clientY) ?? { x: activeDrag.x, y: activeDrag.y };
    const clientDx = event.clientX - activeDrag.startClientX;
    const clientDy = event.clientY - activeDrag.startClientY;
    const clientDistance = Math.sqrt(clientDx * clientDx + clientDy * clientDy);

    if (clientDistance <= IOS_GESTURE_TAP_SLOP_CSS_PX) {
      if (activeDrag.touchDownSent) {
        sendControl({
          phase: "up",
          t: "touch",
          x: point.x,
          y: point.y,
        });
      } else {
        sendControl({
          t: "tap",
          x: point.x,
          y: point.y,
        });
      }
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
      ? liveViewportAligned
        ? "Live"
        : "Aligning"
      : "Fallback"
    : connectionState === "connecting"
      ? "Connecting"
      : connectionState === "disconnected"
        ? "Disconnected"
        : "Error";

  const overlayMessage = error ?? (
    mediaMode === "live"
      ? controlEnabled
        ? "Starting the iOS live stream directly in this panel."
        : "Streaming live video directly in this panel. Control is temporarily unavailable."
      : "Using the compatibility renderer while the live stream is unavailable."
  );

  return (
    <div
      ref={rootRef}
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

      <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/70">
        {statusLabel}
      </div>

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

        {hasFrame && mediaMode === "live" && !liveViewportAligned ? (
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
            disabled={!controlEnabled}
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
            disabled={!controlEnabled}
          >
            <Lock className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
