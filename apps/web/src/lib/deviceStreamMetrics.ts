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
  approxFps: number | null;
  avgFrameIntervalMs: number | null;
  controlSamples: number;
  elapsedMs: number;
  firstFrameMs: number | null;
  frameCount: number;
  maxControlToNextFrameMs: number | null;
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
      approxFps: roundMetric(approxFps),
      avgFrameIntervalMs: roundMetric(avgFrameIntervalMs),
      controlSamples,
      elapsedMs: roundMetric(elapsedMs) ?? 0,
      firstFrameMs: roundMetric(firstFrameMs),
      frameCount,
      maxControlToNextFrameMs: controlSamples > 0 ? roundMetric(maxControlToNextFrameMs) : null,
      maxFrameIntervalMs: frameIntervalCount > 0 ? roundMetric(maxFrameIntervalMs) : null,
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
      frameCount += 1;

      if (firstFrameMs == null) {
        firstFrameMs = Math.max(now - sessionStartedAt, 0);
        log("first_frame", {
          frameCount,
          firstFrameMs: roundMetric(firstFrameMs),
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
