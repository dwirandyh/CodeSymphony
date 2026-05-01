#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const args = {
    bridgePath: "",
    loopCount: 4,
    output: "",
    runtimeBaseUrl: "http://127.0.0.1:4331",
    sessionId: "",
    stepDelayMs: 700,
    tailDelayMs: 1500,
    udid: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--bridge-path":
        args.bridgePath = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--loop-count":
        args.loopCount = Number.parseInt(argv[index + 1] ?? "", 10) || args.loopCount;
        index += 1;
        break;
      case "--output":
        args.output = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--runtime-base-url":
        args.runtimeBaseUrl = argv[index + 1] ?? args.runtimeBaseUrl;
        index += 1;
        break;
      case "--session-id":
        args.sessionId = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--step-delay-ms":
        args.stepDelayMs = Number.parseInt(argv[index + 1] ?? "", 10) || args.stepDelayMs;
        index += 1;
        break;
      case "--tail-delay-ms":
        args.tailDelayMs = Number.parseInt(argv[index + 1] ?? "", 10) || args.tailDelayMs;
        index += 1;
        break;
      case "--udid":
        args.udid = argv[index + 1] ?? "";
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return args;
}

function round(value, precision = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function resolveBridgePath(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const candidates = [
    path.resolve("apps/simulator-bridge/.build/arm64-apple-macosx/debug/SimulatorBridge"),
    path.resolve("apps/simulator-bridge/.build/debug/SimulatorBridge"),
  ];

  for (const candidate of candidates) {
    try {
      return candidate;
    } catch {
      // Ignore resolution issues.
    }
  }

  return candidates[0];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function resolveActiveSession(runtimeBaseUrl, preferredSessionId) {
  if (preferredSessionId) {
    return preferredSessionId;
  }

  const devices = await fetchJson(`${runtimeBaseUrl}/api/devices`);
  const session = devices.data?.activeSessions?.find((entry) => entry.platform === "ios-simulator");
  if (!session?.sessionId) {
    throw new Error("No active iOS simulator session found.");
  }

  return session.sessionId;
}

async function resolveUdid(runtimeBaseUrl, sessionId, preferredUdid) {
  if (preferredUdid) {
    return preferredUdid;
  }

  const devices = await fetchJson(`${runtimeBaseUrl}/api/devices`);
  const session = devices.data?.activeSessions?.find((entry) => entry.sessionId === sessionId);
  const deviceId = typeof session?.deviceId === "string" ? session.deviceId : "";
  const udid = deviceId.replace(/^ios-simulator:/, "");
  if (!udid) {
    throw new Error("Unable to resolve the iOS simulator UDID.");
  }

  return udid;
}

async function runBridgeControl(bridgePath, udid, name) {
  await execFile(bridgePath, [
    "control",
    "--udid",
    udid,
    "--action",
    "system",
    "--name",
    name,
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMarkdown({
  bridgePath,
  elapsedMs,
  frameCount,
  generatedAt,
  keyframes,
  deltaframes,
  metadata,
  sessionId,
  stepDelayMs,
  tailDelayMs,
  totalBytes,
  udid,
}) {
  const approxFps = elapsedMs > 0 ? ((frameCount - 1) / (elapsedMs / 1000)) : 0;
  const avgFrameBytes = frameCount > 0 ? totalBytes / frameCount : 0;
  const bitrateMbps = elapsedMs > 0 ? (totalBytes * 8) / (elapsedMs / 1000) / 1_000_000 : 0;

  return `# iOS Native Video Packet Measurement

Date: ${generatedAt.toISOString().slice(0, 10)}
Generated at: ${generatedAt.toISOString()}

## Environment

| Field | Value |
| --- | --- |
| Active session | \`${sessionId}\` |
| UDID | \`${udid}\` |
| Bridge executable | \`${bridgePath}\` |
| Codec | \`${metadata?.codec ?? "unknown"}\` |
| Pixel size | \`${metadata?.pixelWidth ?? "n/a"} x ${metadata?.pixelHeight ?? "n/a"}\` |
| Logical size | \`${metadata?.pointWidth ?? "n/a"} x ${metadata?.pointHeight ?? "n/a"}\` |
| Gesture loop | \`app_switcher <-> swipe_home\` |
| Step delay | \`${stepDelayMs}ms\` |
| Tail delay | \`${tailDelayMs}ms\` |

## Result

| Dimension | Value |
| --- | ---: |
| Frame count | \`${frameCount}\` |
| Key frames | \`${keyframes}\` |
| Delta frames | \`${deltaframes}\` |
| Captured span | \`${round(elapsedMs, 1)}ms\` |
| Approx active FPS | \`${round(approxFps, 2)}\` |
| Total payload | \`${round(totalBytes / 1024, 1)} KiB\` |
| Avg frame payload | \`${round(avgFrameBytes / 1024, 1)} KiB\` |
| Approx payload bitrate | \`${round(bitrateMbps, 2)} Mbps\` |
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const generatedAt = new Date();
  const bridgePath = resolveBridgePath(args.bridgePath);
  const sessionId = await resolveActiveSession(args.runtimeBaseUrl, args.sessionId);
  const udid = await resolveUdid(args.runtimeBaseUrl, sessionId, args.udid);

  const wsBase = new URL(args.runtimeBaseUrl);
  wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
  const videoUrl = new URL(`/api/device-streams/${encodeURIComponent(sessionId)}/native/video`, wsBase);

  const measurement = await new Promise((resolve, reject) => {
    let closed = false;
    let metadata = null;
    let frameCount = 0;
    let keyframes = 0;
    let deltaframes = 0;
    let totalBytes = 0;
    let firstCapturedAt = null;
    let lastCapturedAt = null;

    const socket = new WebSocket(videoUrl);
    socket.binaryType = "arraybuffer";

    socket.onmessage = async (event) => {
      const data = event.data;
      if (typeof data === "string") {
        try {
          metadata = JSON.parse(data);
        } catch {
          // Ignore metadata parse failures.
        }
        return;
      }

      const buffer = data instanceof Blob
        ? await data.arrayBuffer()
        : data;
      const packet = buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const packetType = packet[0];
      if (packetType !== 2 && packetType !== 3) {
        return;
      }

      const payload = packet.subarray(1);
      if (payload.byteLength < 8) {
        return;
      }

      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const high = view.getUint32(0);
      const low = view.getUint32(4);
      const capturedAt = (high * 2 ** 32) + low;

      if (firstCapturedAt == null) {
        firstCapturedAt = capturedAt;
      }
      lastCapturedAt = capturedAt;
      frameCount += 1;
      totalBytes += payload.byteLength - 8;

      if (packetType === 2) {
        keyframes += 1;
      } else {
        deltaframes += 1;
      }
    };

    socket.onopen = async () => {
      try {
        for (let index = 0; index < args.loopCount; index += 1) {
          await runBridgeControl(bridgePath, udid, "app_switcher");
          await sleep(args.stepDelayMs);
          await runBridgeControl(bridgePath, udid, "swipe_home");
          await sleep(args.stepDelayMs);
        }

        await sleep(args.tailDelayMs);
        socket.close();
      } catch (error) {
        reject(error);
      }
    };

    socket.onerror = (event) => {
      reject(event.error ?? new Error("WebSocket error"));
    };
    socket.onclose = () => {
      if (closed) {
        return;
      }
      closed = true;
      resolve({
        metadata,
        frameCount,
        keyframes,
        deltaframes,
        totalBytes,
        elapsedMs: firstCapturedAt != null && lastCapturedAt != null ? lastCapturedAt - firstCapturedAt : 0,
      });
    };
  });

  const markdown = buildMarkdown({
    bridgePath,
    generatedAt,
    sessionId,
    stepDelayMs: args.stepDelayMs,
    tailDelayMs: args.tailDelayMs,
    udid,
    ...measurement,
  });

  if (args.output) {
    const outputPath = path.resolve(args.output);
    await writeFile(outputPath, markdown, "utf8");
    console.log(outputPath);
    return;
  }

  console.log(markdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
