import { debugLog } from "./debugLog";

type StreamMetricsOptions = {
  platform: "android" | "ios";
  sessionId: string;
  streamProtocol?: string | null;
};

type PendingControlSample = {
  action: string;
  sentAt: number;
};

type SummaryPayload = {
  avgFrameAgeMs: number | null;
  avgFrameDecodeLatencyMs: number | null;
  approxFps: number | null;
  avgFrameIntervalMs: number | null;
  avgFrameTransportAgeMs: number | null;
  controlSamples: number;
  elapsedMs: number;
  firstFrameMs: number | null;
  frameCount: number;
  latestFrameDecodeLatencyMs: number | null;
  latestFrameAgeMs: number | null;
  latestFrameTransportAgeMs: number | null;
  maxControlToNextFrameMs: number | null;
  maxFrameDecodeLatencyMs: number | null;
  maxFrameAgeMs: number | null;
  maxFrameTransportAgeMs: number | null;
  maxFrameIntervalMs: number | null;
};

function roundMetric(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value * 10) / 10;
}

export function isDeviceMetricsEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("deviceMetrics") === "1";
  } catch {
    return false;
  }
}

export function createDeviceStreamMetrics(options: StreamMetricsOptions) {
  const enabled = isDeviceMetricsEnabled();
  const source = `device-stream.${options.platform}`;
  const sessionStartedAt = typeof performance !== "undefined" ? performance.now() : 0;
  let lastFrameAt: number | null = null;
  let firstFrameMs: number | null = null;
  let frameCount = 0;
  let frameIntervalSum = 0;
  let frameIntervalCount = 0;
  let maxFrameIntervalMs = 0;
  let frameAgeSum = 0;
  let frameAgeCount = 0;
  let frameDecodeLatencySum = 0;
  let frameDecodeLatencyCount = 0;
  let latestFrameDecodeLatencyMs: number | null = null;
  let maxFrameDecodeLatencyMs = 0;
  let latestFrameAgeMs: number | null = null;
  let maxFrameAgeMs = 0;
  let frameTransportAgeSum = 0;
  let frameTransportAgeCount = 0;
  let latestFrameTransportAgeMs: number | null = null;
  let maxFrameTransportAgeMs = 0;
  let pendingControl: PendingControlSample | null = null;
  let controlSamples = 0;
  let maxControlToNextFrameMs = 0;
  let lastPeriodicLogAt = sessionStartedAt;

  const log = (message: string, data?: Record<string, unknown>) => {
    if (!enabled) {
      return;
    }

    debugLog(source, message, {
      platform: options.platform,
      sessionId: options.sessionId,
      streamProtocol: options.streamProtocol ?? null,
      ...data,
    });
  };

  const buildSummary = (): SummaryPayload => {
    const elapsedMs = Math.max((typeof performance !== "undefined" ? performance.now() : sessionStartedAt) - sessionStartedAt, 0);
    const avgFrameIntervalMs = frameIntervalCount > 0 ? frameIntervalSum / frameIntervalCount : null;
    const approxFps = avgFrameIntervalMs && avgFrameIntervalMs > 0 ? 1000 / avgFrameIntervalMs : null;

    return {
      avgFrameAgeMs: frameAgeCount > 0 ? roundMetric(frameAgeSum / frameAgeCount) : null,
      avgFrameDecodeLatencyMs: frameDecodeLatencyCount > 0 ? roundMetric(frameDecodeLatencySum / frameDecodeLatencyCount) : null,
      approxFps: roundMetric(approxFps),
      avgFrameIntervalMs: roundMetric(avgFrameIntervalMs),
      avgFrameTransportAgeMs: frameTransportAgeCount > 0 ? roundMetric(frameTransportAgeSum / frameTransportAgeCount) : null,
      controlSamples,
      elapsedMs: roundMetric(elapsedMs) ?? 0,
      firstFrameMs: roundMetric(firstFrameMs),
      frameCount,
      latestFrameDecodeLatencyMs: roundMetric(latestFrameDecodeLatencyMs),
      latestFrameAgeMs: roundMetric(latestFrameAgeMs),
      maxControlToNextFrameMs: controlSamples > 0 ? roundMetric(maxControlToNextFrameMs) : null,
      maxFrameDecodeLatencyMs: frameDecodeLatencyCount > 0 ? roundMetric(maxFrameDecodeLatencyMs) : null,
      maxFrameAgeMs: frameAgeCount > 0 ? roundMetric(maxFrameAgeMs) : null,
      maxFrameTransportAgeMs: frameTransportAgeCount > 0 ? roundMetric(maxFrameTransportAgeMs) : null,
      maxFrameIntervalMs: frameIntervalCount > 0 ? roundMetric(maxFrameIntervalMs) : null,
      latestFrameTransportAgeMs: roundMetric(latestFrameTransportAgeMs),
    };
  };

  return {
    markConnectStart(extra?: Record<string, unknown>) {
      log("connect_start", extra);
    },
    markMode(mode: "fallback" | "live", extra?: Record<string, unknown>) {
      log("mode", {
        mode,
        ...extra,
      });
    },
    markFrame(extra?: Record<string, unknown>) {
      const now = typeof performance !== "undefined" ? performance.now() : sessionStartedAt;
      const rawFrameAgeMs = typeof extra?.frameAgeMs === "number" && Number.isFinite(extra.frameAgeMs)
        ? Math.max(extra.frameAgeMs, 0)
        : null;
      const rawFrameDecodeLatencyMs = typeof extra?.frameDecodeLatencyMs === "number" && Number.isFinite(extra.frameDecodeLatencyMs)
        ? Math.max(extra.frameDecodeLatencyMs, 0)
        : null;
      const rawFrameTransportAgeMs = typeof extra?.frameTransportAgeMs === "number" && Number.isFinite(extra.frameTransportAgeMs)
        ? Math.max(extra.frameTransportAgeMs, 0)
        : null;
      frameCount += 1;

      if (rawFrameAgeMs != null) {
        frameAgeCount += 1;
        frameAgeSum += rawFrameAgeMs;
        latestFrameAgeMs = rawFrameAgeMs;
        maxFrameAgeMs = Math.max(maxFrameAgeMs, rawFrameAgeMs);
      }
      if (rawFrameDecodeLatencyMs != null) {
        frameDecodeLatencyCount += 1;
        frameDecodeLatencySum += rawFrameDecodeLatencyMs;
        latestFrameDecodeLatencyMs = rawFrameDecodeLatencyMs;
        maxFrameDecodeLatencyMs = Math.max(maxFrameDecodeLatencyMs, rawFrameDecodeLatencyMs);
      }
      if (rawFrameTransportAgeMs != null) {
        frameTransportAgeCount += 1;
        frameTransportAgeSum += rawFrameTransportAgeMs;
        latestFrameTransportAgeMs = rawFrameTransportAgeMs;
        maxFrameTransportAgeMs = Math.max(maxFrameTransportAgeMs, rawFrameTransportAgeMs);
      }

      if (firstFrameMs == null) {
        firstFrameMs = Math.max(now - sessionStartedAt, 0);
        log("first_frame", {
          frameDecodeLatencyMs: roundMetric(rawFrameDecodeLatencyMs),
          frameCount,
          firstFrameMs: roundMetric(firstFrameMs),
          frameAgeMs: roundMetric(rawFrameAgeMs),
          frameTransportAgeMs: roundMetric(rawFrameTransportAgeMs),
          ...extra,
        });
      }

      if (lastFrameAt != null) {
        const intervalMs = Math.max(now - lastFrameAt, 0);
        frameIntervalSum += intervalMs;
        frameIntervalCount += 1;
        maxFrameIntervalMs = Math.max(maxFrameIntervalMs, intervalMs);
      }
      lastFrameAt = now;

      if (pendingControl) {
        const latencyMs = Math.max(now - pendingControl.sentAt, 0);
        controlSamples += 1;
        maxControlToNextFrameMs = Math.max(maxControlToNextFrameMs, latencyMs);
        log("control_to_next_frame", {
          action: pendingControl.action,
          latencyMs: roundMetric(latencyMs),
          ...extra,
        });
        pendingControl = null;
      }

      if (now - lastPeriodicLogAt >= 5000) {
        lastPeriodicLogAt = now;
        log("summary", buildSummary());
      }
    },
    markControl(action: string, extra?: Record<string, unknown>) {
      pendingControl = {
        action,
        sentAt: typeof performance !== "undefined" ? performance.now() : sessionStartedAt,
      };
      log("control_sent", {
        action,
        ...extra,
      });
    },
    flush(reason: string, extra?: Record<string, unknown>) {
      log("summary", {
        reason,
        ...buildSummary(),
        ...extra,
      });
    },
  };
}
