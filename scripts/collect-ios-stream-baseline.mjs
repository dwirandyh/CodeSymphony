#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const args = {
    intervalMs: 1000,
    output: null,
    runtimeBaseUrl: "http://127.0.0.1:4331",
    samples: 10,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        args.output = argv[index + 1] ?? null;
        index += 1;
        break;
      case "--runtime-base-url":
        args.runtimeBaseUrl = argv[index + 1] ?? args.runtimeBaseUrl;
        index += 1;
        break;
      case "--samples":
        args.samples = Number.parseInt(argv[index + 1] ?? "", 10) || args.samples;
        index += 1;
        break;
      case "--interval-ms":
        args.intervalMs = Number.parseInt(argv[index + 1] ?? "", 10) || args.intervalMs;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return args;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function round(value, precision = 1) {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatMetric(value, unit = "", precision = 1) {
  const rounded = round(value, precision);
  if (rounded == null) {
    return "n/a";
  }

  return `${rounded}${unit}`;
}

function formatMiBFromKiB(kib) {
  if (kib == null || !Number.isFinite(kib)) {
    return "n/a";
  }

  return `${round(kib / 1024, 1)} MiB`;
}

function isoDateStamp(date) {
  return date.toISOString().slice(0, 10);
}

async function readBootedSimulators() {
  const { stdout } = await execFile("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "--json"], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function parsePsRows(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+([0-9.]+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }

      return {
        command: match[4],
        cpu: Number.parseFloat(match[2]),
        pid: Number.parseInt(match[1], 10),
        rssKiB: Number.parseInt(match[3], 10),
      };
    })
    .filter((row) => row !== null);
}

async function sampleBridgeProcess(udid, sampleCount, intervalMs) {
  const samples = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,%cpu=,rss=,command="], {
      encoding: "utf8",
    });
    const row = parsePsRows(stdout).find((entry) => (
      entry.command.includes("SimulatorBridge stream")
      && entry.command.includes(`--udid ${udid}`)
    ));

    if (row) {
      samples.push({
        cpu: row.cpu,
        pid: row.pid,
        rssKiB: row.rssKiB,
      });
    }

    if (index < sampleCount - 1) {
      await delay(intervalMs);
    }
  }

  return samples;
}

function summarizeNumericSamples(values) {
  if (values.length === 0) {
    return {
      average: null,
      max: null,
      min: null,
    };
  }

  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  return {
    average: sum / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
  };
}

function selectLatestSessionEntries(entries) {
  const sessionEntries = new Map();

  for (const entry of entries) {
    const sessionId = typeof entry?.data?.sessionId === "string" ? entry.data.sessionId : null;
    if (!sessionId) {
      continue;
    }

    const bucket = sessionEntries.get(sessionId) ?? [];
    bucket.push(entry);
    sessionEntries.set(sessionId, bucket);
  }

  if (sessionEntries.size === 0) {
    throw new Error(
      "No device-stream.ios metrics found. Open the workspace with ?deviceMetrics=1&debugLogSources=device-stream.ios and keep the iOS Devices panel visible first.",
    );
  }

  const orderedSessions = [...sessionEntries.entries()]
    .map(([sessionId, bucket]) => ({
      entries: bucket.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0)),
      latestTs: Math.max(...bucket.map((entry) => Number(entry.ts ?? 0))),
      sessionId,
    }))
    .sort((left, right) => right.latestTs - left.latestTs);

  return orderedSessions[0];
}

function detectCaptureMode(entries, sessionId) {
  const bridgeMessages = entries
    .filter((entry) => entry?.source === "devices.ios-simulator-bridge" && entry?.data?.runtimeSessionId === sessionId)
    .map((entry) => String(entry.message ?? ""));

  if (bridgeMessages.some((message) => message.includes("via direct framebuffer capture"))) {
    return {
      currentStreamPath: "Direct framebuffer -> IOSurface -> JPEG",
      mode: "framebuffer",
      title: "iOS Simulator Stream Measurement",
      hostAudioCapture: "Disabled",
      hostScreenRecordingPermission: "Not required",
    };
  }

  if (bridgeMessages.some((message) => message.includes("via ScreenCaptureKit"))) {
    return {
      currentStreamPath: "ScreenCaptureKit -> SCStream",
      mode: "window",
      title: "iOS Simulator Stream Measurement",
      hostAudioCapture: "Disabled (`capturesAudio = false`)",
      hostScreenRecordingPermission: "Required",
    };
  }

  return {
    currentStreamPath: "Unknown",
    mode: "unknown",
    title: "iOS Simulator Stream Measurement",
    hostAudioCapture: "Unknown",
    hostScreenRecordingPermission: "Unknown",
  };
}

function buildMarkdownReport({
  activeSession,
  bootedDevice,
  captureMode,
  cpuSummary,
  generatedAt,
  intervalMs,
  latestSessionEntries,
  runtimeBaseUrl,
  samples,
  statusPayload,
}) {
  const firstFrame = latestSessionEntries.entries.find((entry) => entry.message === "first_frame")?.data ?? null;
  const summaries = latestSessionEntries.entries
    .filter((entry) => entry.message === "summary")
    .map((entry) => entry.data);
  const latestSummary = summaries.at(-1) ?? null;
  const controlLatencies = latestSessionEntries.entries
    .filter((entry) => entry.message === "control_to_next_frame")
    .map((entry) => entry.data?.latencyMs)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  const logicalWidth = statusPayload?.session_info?.device_width ?? null;
  const logicalHeight = statusPayload?.session_info?.device_height ?? null;
  const pixelWidth = statusPayload?.session_info?.pixel_width ?? null;
  const pixelHeight = statusPayload?.session_info?.pixel_height ?? null;
  const scaleVsLogicalWidth = logicalWidth && pixelWidth ? pixelWidth / logicalWidth : null;
  const scaleVsLogicalHeight = logicalHeight && pixelHeight ? pixelHeight / logicalHeight : null;

  const isFramebufferMode = captureMode.mode === "framebuffer";

  return `# ${captureMode.title}

Date: ${isoDateStamp(generatedAt)}
Generated at: ${generatedAt.toISOString()}

## Environment

| Field | Value |
| --- | --- |
| Runtime base URL | \`${runtimeBaseUrl}\` |
| Active session | \`${activeSession.sessionId}\` |
| Device | \`${bootedDevice?.name ?? activeSession.deviceId}\` |
| UDID | \`${bootedDevice?.udid ?? activeSession.deviceId}\` |
| Simulator runtime | \`${bootedDevice?.runtime ?? "unknown"}\` |
| Current stream path | \`${captureMode.currentStreamPath}\` |
| Host Screen Recording permission | ${captureMode.hostScreenRecordingPermission} |
| Host system audio capture | ${captureMode.hostAudioCapture} |

## Capture Geometry

| Metric | Value |
| --- | ---: |
| Logical device size | \`${logicalWidth ?? "n/a"} x ${logicalHeight ?? "n/a"}\` pt |
| Current capture size | \`${pixelWidth ?? "n/a"} x ${pixelHeight ?? "n/a"}\` px |
| Width ratio vs logical size | \`${formatMetric(scaleVsLogicalWidth, "x", 2)}\` |
| Height ratio vs logical size | \`${formatMetric(scaleVsLogicalHeight, "x", 2)}\` |

Interpretation:

- ${isFramebufferMode
    ? `The current framebuffer path is no longer window-size dependent.`
    : `The current ScreenCaptureKit path is window-size dependent.`}
- The important apples-to-apples comparison is:
  - matched output resolution to the baseline \`323 x 703\` px ScreenCaptureKit capture
  - logical-size framebuffer output at \`${pixelWidth ?? "n/a"} x ${pixelHeight ?? "n/a"}\` px

## Measured Result

| Dimension | Result |
| --- | ---: |
| First frame | \`${formatMetric(firstFrame?.firstFrameMs, "ms")}\` |
| First frame age | \`${formatMetric(firstFrame?.frameAgeMs, "ms")}\` |
| First frame decode latency | \`${formatMetric(firstFrame?.frameDecodeLatencyMs, "ms")}\` |
| First frame transport age | \`${formatMetric(firstFrame?.frameTransportAgeMs, "ms")}\` |
| Warm steady-state FPS | \`${formatMetric(latestSummary?.approxFps, "", 1)}\` |
| Warm avg frame interval | \`${formatMetric(latestSummary?.avgFrameIntervalMs, "ms")}\` |
| Warm avg frame age | \`${formatMetric(latestSummary?.avgFrameAgeMs, "ms")}\` |
| Warm avg decode latency | \`${formatMetric(latestSummary?.avgFrameDecodeLatencyMs, "ms")}\` |
| Warm avg transport age | \`${formatMetric(latestSummary?.avgFrameTransportAgeMs, "ms")}\` |
| Control-to-next-frame latency | \`${controlLatencies.length > 0 ? controlLatencies.map((value) => `${round(value, 1)}ms`).join(", ") : "n/a"}\` |
| Max measured control-to-next-frame | \`${formatMetric(latestSummary?.maxControlToNextFrameMs, "ms")}\` |
| Bridge CPU (${samples} x ${intervalMs}ms) | avg \`${formatMetric(cpuSummary.cpu.average, "%", 2)}\`, min \`${formatMetric(cpuSummary.cpu.min, "%", 1)}\`, max \`${formatMetric(cpuSummary.cpu.max, "%", 1)}\` |
| Bridge RSS (${samples} x ${intervalMs}ms) | avg \`${formatMiBFromKiB(cpuSummary.rss.average)}\`, min \`${formatMiBFromKiB(cpuSummary.rss.min)}\`, max \`${formatMiBFromKiB(cpuSummary.rss.max)}\` |

## Comparison Matrix For Framebuffer Migration

| Dimension | Why it matters | Current baseline | Framebuffer target |
| --- | --- | ---: | --- |
| Host privacy friction | This is the main product reason to migrate | Screen Recording permission required | No Screen Recording prompt |
| Startup to first frame | Determines perceived stream startup | \`${formatMetric(firstFrame?.firstFrameMs, "ms")}\` | Not slower than \`+10%\` at matched resolution |
| Warm steady-state FPS | Captures smoothness under idle/normal interaction | \`${formatMetric(latestSummary?.approxFps, "", 1)}\` | Same or higher |
| Avg frame age | Proxy for end-to-end freshness | \`${formatMetric(latestSummary?.avgFrameAgeMs, "ms")}\` | Same or lower |
| Avg decode latency | Keeps viewer-side decode overhead visible | \`${formatMetric(latestSummary?.avgFrameDecodeLatencyMs, "ms")}\` | Same or lower |
| Control-to-next-frame | Closest current proxy to interaction responsiveness | \`${formatMetric(latestSummary?.maxControlToNextFrameMs, "ms")}\` max | \`<= 15ms\` at matched resolution |
| Bridge CPU | Prevents “permission-free but much heavier” regressions | \`${formatMetric(cpuSummary.cpu.average, "%", 2)}\` avg | Same or lower at matched resolution |
| Bridge RSS | Prevents persistent process bloat | \`${formatMiBFromKiB(cpuSummary.rss.average)}\` avg | Same or lower |
| Output resolution policy | Prevents invalid apples-to-oranges comparisons | \`${pixelWidth ?? "n/a"} x ${pixelHeight ?? "n/a"}\` px | Run both matched-resolution and native-resolution modes |

## Notes

- ${isFramebufferMode
    ? `This measurement is running on the direct framebuffer path. Compare it against [docs/ios-simulator-stream-baseline-2026-05-01.md](/Users/dwirandyh/Work/Personal/codesymphony/docs/ios-simulator-stream-baseline-2026-05-01.md:1) for the ScreenCaptureKit baseline.`
    : `This measurement is running on the ScreenCaptureKit baseline path.`}
- The warm-path baseline should be compared against the framebuffer warm path. Do not compare framebuffer steady-state numbers against the current startup outliers (\`maxFrameAgeMs\`, \`maxFrameIntervalMs\`) from the initial connection phase.
- The current path does not capture host/system audio. If the framebuffer path also skips audio, then audio permission is not part of the migration acceptance criteria.
- Latest metrics session used: \`${latestSessionEntries.sessionId}\`.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date();
  const outputPath = args.output
    ? path.resolve(args.output)
    : path.resolve(`docs/ios-simulator-stream-baseline-${isoDateStamp(generatedAt)}.md`);

  const devicesPayload = await fetchJson(`${args.runtimeBaseUrl}/api/devices`);
  const activeSession = devicesPayload.data?.activeSessions?.find((session) => session.platform === "ios-simulator");
  if (!activeSession) {
    throw new Error("No active iOS simulator stream session found.");
  }

  const statusPayload = await fetchJson(
    `${args.runtimeBaseUrl}/api/device-streams/${encodeURIComponent(activeSession.sessionId)}/native/status`,
  );
  const debugPayload = await fetchJson(
    `${args.runtimeBaseUrl}/api/debug/log-buffer?source=device-stream.ios&limit=500`,
  );
  const logPayload = await fetchJson(`${args.runtimeBaseUrl}/api/logs`);
  const latestSessionEntries = selectLatestSessionEntries(debugPayload.data?.entries ?? []);
  const captureMode = detectCaptureMode(logPayload.data ?? [], activeSession.sessionId);

  const bootedSimulators = await readBootedSimulators();
  const bootedDevice = Object.entries(bootedSimulators.devices ?? {})
    .flatMap(([runtime, entries]) => (
      Array.isArray(entries)
        ? entries.map((entry) => ({ ...entry, runtime }))
        : []
    ))
    .find((entry) => entry.udid === activeSession.deviceId.replace(/^ios-simulator:/, ""));

  const udid = bootedDevice?.udid ?? activeSession.deviceId.replace(/^ios-simulator:/, "");
  const processSamples = await sampleBridgeProcess(udid, args.samples, args.intervalMs);
  const cpuSummary = {
    cpu: summarizeNumericSamples(processSamples.map((sample) => sample.cpu)),
    rss: summarizeNumericSamples(processSamples.map((sample) => sample.rssKiB)),
  };

  const markdown = buildMarkdownReport({
    activeSession,
    bootedDevice,
    captureMode,
    cpuSummary,
    generatedAt,
    intervalMs: args.intervalMs,
    latestSessionEntries,
    runtimeBaseUrl: args.runtimeBaseUrl,
    samples: args.samples,
    statusPayload,
  });

  await writeFile(outputPath, markdown, "utf8");
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
