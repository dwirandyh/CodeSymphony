import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { exec as execCallback, execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  DeviceInventorySnapshot,
  DeviceIssue,
  DevicePlatform,
  DeviceStatus,
  DeviceStreamSession,
  DeviceSummary,
  SendDeviceControlInput,
  StartDeviceStreamInput,
} from "@codesymphony/shared-types";
import WebSocket from "ws";
import { buildClaudeRuntimeEnv as buildSubprocessEnv } from "../claude/shellEnv.js";
import type { LogEntry } from "./logService.js";
import {
  annotateIosSimulatorBridgeTccError,
  buildAndroidInputTextCommands,
  buildAndroidProxyViewerUrl,
  parseAdbDevicesOutput,
  parseAndroidClipboardBooleanServiceCall,
  parseAndroidClipboardServiceCallOutput,
  parseCodesignSignatureState,
  parseSimctlDevicesOutput,
  resolveRememberedAndroidDevice,
  shouldRetainMissingAndroidSession,
  type RememberedAndroidDevice,
} from "./deviceService.utils.js";

const execFile = promisify(execFileCallback);
const exec = promisify(execCallback);
const managedSubprocessEnv = buildSubprocessEnv({
  ...process.env,
} as NodeJS.ProcessEnv);
const DEFAULT_ANDROID_WS_SCRCPY_BASE_URL = "http://127.0.0.1:8765/";
const DEFAULT_IOS_SIMULATOR_BRIDGE_FPS = 60;
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const ANDROID_DEVICE_STALE_GRACE_MS = 20_000;
const ANDROID_DEVICE_RECOVERY_COOLDOWN_MS = 8_000;
const IOS_SIMULATOR_BRIDGE_READY_TIMEOUT_MS = 15_000;
const ANDROID_CLIPBOARD_TIMEOUT_MS = 4_000;
const ANDROID_CLIPBOARD_HELPER_BUILD_TIMEOUT_MS = 15_000;
const ANDROID_CLIPBOARD_HELPER_DEVICE_PATH = "/data/local/tmp/codesymphony-clipboard.dex";
const ANDROID_CLIPBOARD_HELPER_ENTRYPOINT = "dev.codesymphony.android.ClipboardCli";
const ANDROID_CLIPBOARD_PASTE_KEYCODE = 279;
const ANDROID_CONTROL_TIMEOUT_MS = 5_000;
const ANDROID_CLIPBOARD_SERVICE_ARGS_BASE = [
  "s16",
  "com.android.shell",
  "s16",
  "shell",
  "i32",
  "0",
  "i32",
  "0",
] as const;

type DeviceListener = (snapshot: DeviceInventorySnapshot) => void;

type RuntimeLogService = {
  log: (
    level: LogEntry["level"],
    source: string,
    message: string,
    data?: unknown,
    scope?: Pick<LogEntry, "worktreeId" | "threadId">,
  ) => void;
};

type InternalStreamSession = DeviceStreamSession & {
  viewerMode: "redirect" | "proxy";
  redirectUrl: string | null;
  proxyBaseUrl: string | null;
  proxyAuthorizationHeader: string | null;
  iosNativeControl: boolean;
  iosUdid?: string | null;
  iosVideoBridge?: IosSimulatorVideoBridge | null;
};

type DeviceViewerSession = {
  viewerMode: "redirect" | "proxy";
  platform: DevicePlatform;
  redirectUrl: string | null;
  proxyBaseUrl: string | null;
  proxyAuthorizationHeader: string | null;
};

type IosSimulatorBridgePacketType = 0 | 1 | 2 | 3;

type IosSimulatorVideoBridge = {
  buffer: Buffer;
  child: ChildProcess;
  clients: Set<WebSocket>;
  closeReason: string | null;
  latestConfigPacket: Buffer | null;
  latestPointHeight: number | null;
  latestPointWidth: number | null;
  latestKeyPacket: Buffer | null;
  latestMetadata: string | null;
  latestPixelHeight: number | null;
  latestPixelWidth: number | null;
};

type ManagedSidecar = {
  child: ChildProcess;
  command: string;
  baseUrl: string;
  logPath: string | null;
  startedByRuntime: boolean;
};

type DeviceMetadata = {
  serial: string | null;
};

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.toString();
}

function getRefreshIntervalMs(): number {
  const raw = Number(process.env.DEVICE_REFRESH_INTERVAL_MS ?? DEFAULT_REFRESH_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_REFRESH_INTERVAL_MS;
}

function getAndroidBaseUrl(): string {
  return normalizeBaseUrl(process.env.ANDROID_WS_SCRCPY_BASE_URL?.trim() || DEFAULT_ANDROID_WS_SCRCPY_BASE_URL);
}

function getSidecarLogPath(name: string): string {
  const directory = joinPath(os.tmpdir(), "codesymphony", "sidecars");
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  return joinPath(directory, `${name}.log`);
}

function getAndroidClipboardHelperSourcePath(): string {
  return fileURLToPath(new URL("../../android-helpers/ClipboardCli.java", import.meta.url));
}

function getAndroidClipboardHelperBuildPath(...parts: string[]): string {
  const directory = joinPath(os.tmpdir(), "codesymphony", "android-clipboard-helper", ...parts);
  const parentDirectory = parts.length > 0 ? directory : joinPath(os.tmpdir(), "codesymphony", "android-clipboard-helper");
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }
  return directory;
}

function parseAndroidBuildToolsVersion(value: string): number[] {
  return value
    .split(/[^0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => Number.parseInt(segment, 10));
}

function compareAndroidBuildToolsVersionDesc(left: string, right: string): number {
  const leftParts = parseAndroidBuildToolsVersion(left);
  const rightParts = parseAndroidBuildToolsVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }

  return right.localeCompare(left);
}

function resolveAndroidD8Path(): string {
  const sdkRootCandidates = [
    process.env.ANDROID_BUILD_TOOLS_D8?.trim(),
    process.env.ANDROID_SDK_ROOT?.trim() ? joinPath(process.env.ANDROID_SDK_ROOT.trim(), "build-tools") : "",
    process.env.ANDROID_HOME?.trim() ? joinPath(process.env.ANDROID_HOME.trim(), "build-tools") : "",
    joinPath(os.homedir(), "Library", "Android", "sdk", "build-tools"),
    joinPath(os.homedir(), "Android", "Sdk", "build-tools"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of sdkRootCandidates) {
    if (candidate.endsWith("/d8") || candidate.endsWith("\\d8") || candidate.endsWith("/d8.bat") || candidate.endsWith("\\d8.bat")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    if (!existsSync(candidate)) {
      continue;
    }

    const versions = readdirSync(candidate, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareAndroidBuildToolsVersionDesc);

    for (const version of versions) {
      const d8Path = joinPath(candidate, version, process.platform === "win32" ? "d8.bat" : "d8");
      if (existsSync(d8Path)) {
        return d8Path;
      }
    }
  }

  throw new Error("Android build-tools d8 was not found. Install Android SDK Build-Tools or set ANDROID_BUILD_TOOLS_D8.");
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildNodeEntryCommand(nodePath: string, entryPath: string, envEntries: Record<string, string>): string {
  const envAssignments = Object.entries(envEntries)
    .map(([key, value]) => `${key}=${quotePosixShellArg(value)}`)
    .join(" ");
  const prefix = envAssignments.length > 0 ? `${envAssignments} ` : "";
  return `${prefix}${quotePosixShellArg(nodePath)} ${quotePosixShellArg(entryPath)}`;
}

function resolvePackagedAndroidSidecarCommand(): string {
  const entryPath = fileURLToPath(new URL("../../android-ws-scrcpy/dist/index.js", import.meta.url));
  const configPath = fileURLToPath(new URL("../../android-ws-scrcpy/ws-scrcpy.config.yaml", import.meta.url));
  const nodePath = process.execPath;

  if (!existsSync(entryPath) || !existsSync(configPath) || !existsSync(nodePath)) {
    return "";
  }

  return buildNodeEntryCommand(nodePath, entryPath, {
    WS_SCRCPY_CONFIG: configPath,
  });
}

function getBundledAndroidSidecarCommand(): string {
  const packagedCommand = resolvePackagedAndroidSidecarCommand();
  if (packagedCommand) {
    return packagedCommand;
  }

  const scriptPath = fileURLToPath(new URL("../../../../scripts/start-ws-scrcpy.sh", import.meta.url));
  return existsSync(scriptPath) ? scriptPath : "";
}

function getIosSimulatorBridgeFps(): number {
  const raw = Number(process.env.IOS_SIMULATOR_BRIDGE_FPS ?? DEFAULT_IOS_SIMULATOR_BRIDGE_FPS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 60 ? Math.floor(raw) : DEFAULT_IOS_SIMULATOR_BRIDGE_FPS;
}

function getAndroidBasicAuthorizationHeader(): string | null {
  const username = process.env.ADMIN_USER?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!username || typeof password !== "string") {
    return null;
  }

  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function isHttpReady(
  url: string,
  path = "/",
  timeoutMs = HEALTH_TIMEOUT_MS,
  acceptedStatuses: number[] = [],
): Promise<boolean> {
  const target = new URL(path, url);

  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok || acceptedStatuses.includes(response.status);
  } catch {
    return false;
  }
}

async function waitForHttpReady(url: string, path: string, timeoutMs: number, acceptedStatuses: number[] = []): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHttpReady(url, path, HEALTH_TIMEOUT_MS, acceptedStatuses)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${new URL(path, url).toString()}`);
}

function normalizeDeviceLabel(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function buildAndroidName(device: ReturnType<typeof parseAdbDevicesOutput>[number]): string {
  return normalizeDeviceLabel(device.model) ?? normalizeDeviceLabel(device.deviceName) ?? device.serial;
}

function resolveAndroidStatus(state: string, hasSession: boolean): { status: DeviceStatus; lastError: string | null } {
  if (hasSession) {
    if (state === "device") {
      return { status: "streaming", lastError: null };
    }

    return {
      status: "connecting",
      lastError: state === "offline"
        ? "Device is offline. Waiting for adb to reconnect."
        : state === "unauthorized"
          ? "Authorize adb debugging on the device first"
          : `adb reported state: ${state}`,
    };
  }

  if (state === "device") {
    return { status: "available", lastError: null };
  }

  if (state === "offline") {
    return { status: "offline", lastError: "Device is offline" };
  }

  return {
    status: "error",
    lastError: state === "unauthorized"
      ? "Authorize adb debugging on the device first"
      : `adb reported state: ${state}`,
  };
}

function toPublicSession(session: InternalStreamSession): DeviceStreamSession {
  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    platform: session.platform,
    viewerUrl: session.viewerUrl,
    controlTransport: session.controlTransport,
    startedAt: session.startedAt,
  };
}

function isAndroidDeviceSessionMissing(session: InternalStreamSession, availableAndroidDeviceIds: Set<string>): boolean {
  return session.platform === "android" && !availableAndroidDeviceIds.has(session.deviceId);
}

function createPlatformIssue(platform: DevicePlatform, message: string): DeviceIssue {
  return {
    id: `${platform}:${message}`,
    platform,
    severity: "warning",
    message,
  };
}

function resolveIosSimulatorBridgePackagePath(): string {
  const candidates = [
    resolvePath(process.cwd(), "simulator-bridge"),
    resolvePath(process.cwd(), "../simulator-bridge"),
    resolvePath(process.cwd(), "apps/simulator-bridge"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveIosSimulatorBridgeExecutablePath(): string | null {
  const packagePath = resolveIosSimulatorBridgePackagePath();
  const candidates = [
    resolvePath(packagePath, ".build/arm64-apple-macosx/debug/SimulatorBridge"),
    resolvePath(packagePath, ".build/debug/SimulatorBridge"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function createLocalIosSimulatorBridgeExecSpec(commandArgs: string[]): {
  args: string[];
  command: string;
  prettyCommand: string;
} {
  const executablePath = resolveIosSimulatorBridgeExecutablePath();
  if (executablePath) {
    return {
      args: commandArgs,
      command: executablePath,
      prettyCommand: [executablePath, ...commandArgs].join(" "),
    };
  }

  const packagePath = resolveIosSimulatorBridgePackagePath();
  const args = ["run", "--package-path", packagePath, "SimulatorBridge", ...commandArgs];
  return {
    args,
    command: "swift",
    prettyCommand: ["swift", ...args].join(" "),
  };
}

function createIosSimulatorBridgeSpawnSpec(udid: string): {
  args: string[];
  command: string;
  prettyCommand: string;
  shell: boolean;
} {
  const fps = getIosSimulatorBridgeFps();
  const override = process.env.IOS_SIMULATOR_BRIDGE_COMMAND?.trim();
  if (override) {
    const command = `${override} stream --udid ${udid} --fps ${fps}`;
    return {
      args: [],
      command,
      prettyCommand: command,
      shell: true,
    };
  }

  const localSpec = createLocalIosSimulatorBridgeExecSpec(["stream", "--udid", udid, "--fps", String(fps)]);
  return { ...localSpec, shell: false };
}

function resolveBundledRuntimeNodePath(): string | null {
  const normalizedExecPath = process.execPath.trim();
  if (!normalizedExecPath.endsWith("/Contents/MacOS/node")) {
    return null;
  }

  return existsSync(normalizedExecPath) ? normalizedExecPath : null;
}

async function inspectCodesignSignatureState(targetPath: string): Promise<"adhoc" | "signed" | "unsigned" | "unknown"> {
  try {
    const { stdout, stderr } = await execFile("codesign", ["-dv", "--verbose=4", targetPath], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: 5_000,
    });
    return parseCodesignSignatureState(`${stdout ?? ""}\n${stderr ?? ""}`);
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout ?? "") : "";
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr ?? "") : "";
    return parseCodesignSignatureState(`${stdout}\n${stderr}`);
  }
}

async function annotateIosSimulatorBridgeError(message: string): Promise<string> {
  const bundledRuntimePath = resolveBundledRuntimeNodePath();
  if (!bundledRuntimePath) {
    return message;
  }

  const bundledRuntimeSignature = await inspectCodesignSignatureState(bundledRuntimePath);
  return annotateIosSimulatorBridgeTccError(message, {
    bundledRuntimePath,
    bundledRuntimeSignature,
  });
}

async function resolveAndroidDisplayName(device: ReturnType<typeof parseAdbDevicesOutput>[number]): Promise<string> {
  if (device.connectionKind !== "emulator") {
    return buildAndroidName(device);
  }

  try {
    const { stdout } = await execFile("adb", ["-s", device.serial, "emu", "avd", "name"], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: 1_500,
    });
    const avdName = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== "OK");

    if (avdName) {
      return normalizeDeviceLabel(avdName) ?? buildAndroidName(device);
    }
  } catch {
    // Ignore emulator-name lookup failures and fall back to adb metadata.
  }

  return buildAndroidName(device);
}

async function runLocalIosSimulatorBridge(commandArgs: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  const spec = createLocalIosSimulatorBridgeExecSpec(commandArgs);
  const { stdout, stderr } = await execFile(spec.command, spec.args, {
    encoding: "buffer",
    env: managedSubprocessEnv,
    maxBuffer: 32 * 1024 * 1024,
    timeout: START_TIMEOUT_MS,
  });

  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
  };
}

async function captureIosSimulatorScreenshot(udid: string): Promise<Buffer> {
  const { stdout } = await execFile("xcrun", ["simctl", "io", udid, "screenshot", "--type=jpeg", "-"], {
    encoding: "buffer",
    env: managedSubprocessEnv,
    maxBuffer: 32 * 1024 * 1024,
    timeout: START_TIMEOUT_MS,
  });

  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

export function createDeviceService(logService?: RuntimeLogService) {
  const listeners = new Set<DeviceListener>();
  const streamSessions = new Map<string, InternalStreamSession>();
  const rememberedAndroidDevices = new Map<string, RememberedAndroidDevice>();
  let deviceMetadata = new Map<string, DeviceMetadata>();
  let snapshot: DeviceInventorySnapshot = {
    devices: [],
    activeSessions: [],
    issues: [],
    refreshedAt: new Date(0).toISOString(),
  };
  let refreshPromise: Promise<DeviceInventorySnapshot> | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let lastAndroidRecoveryAt = 0;
  let androidSidecar: ManagedSidecar | null = null;
  let androidClipboardHelperBuildPromise: Promise<string> | null = null;
  let androidClipboardHelperDexPath: string | null = null;
  let androidClipboardHelperSourceMtimeMs = 0;
  let iosSimulatorBridgeIssue: string | null = null;

  function pruneMissingAndroidStreamSessions(availableAndroidDeviceIds: Set<string>): void {
    const now = Date.now();

    for (const [sessionId, session] of [...streamSessions.entries()]) {
      if (!isAndroidDeviceSessionMissing(session, availableAndroidDeviceIds)) {
        continue;
      }

      const lastSeenAt = rememberedAndroidDevices.get(session.deviceId)?.lastSeenAt ?? Date.parse(session.startedAt);
      if (Number.isFinite(lastSeenAt) && shouldRetainMissingAndroidSession(lastSeenAt, now, ANDROID_DEVICE_STALE_GRACE_MS)) {
        continue;
      }

      streamSessions.delete(sessionId);
      logService?.log("warn", "devices.android-session", "Removed stale Android stream session", {
        deviceId: session.deviceId,
        sessionId,
      });
    }
  }

  function rememberAndroidDevices(devices: DeviceSummary[]): void {
    const now = Date.now();
    for (const device of devices) {
      if (device.platform !== "android") {
        continue;
      }

      rememberedAndroidDevices.set(device.id, {
        device,
        lastSeenAt: now,
      });
    }
  }

  function restoreRememberedAndroidDevices(
    androidDevices: DeviceSummary[],
    issues: DeviceIssue[],
    nextDeviceMetadata: Map<string, DeviceMetadata>,
  ): DeviceSummary[] {
    const activeSessionDeviceIds = new Set(
      [...streamSessions.values()]
        .filter((session) => session.platform === "android")
        .map((session) => session.deviceId),
    );
    const knownDeviceIds = new Set(androidDevices.map((device) => device.id));
    const restoredDevices: DeviceSummary[] = [];
    const now = Date.now();

    for (const [deviceId, rememberedDevice] of [...rememberedAndroidDevices.entries()]) {
      if (knownDeviceIds.has(deviceId)) {
        continue;
      }

      const resolved = resolveRememberedAndroidDevice(
        rememberedDevice,
        activeSessionDeviceIds.has(deviceId),
        now,
        ANDROID_DEVICE_STALE_GRACE_MS,
      );

      if (resolved.expired || !resolved.device) {
        rememberedAndroidDevices.delete(deviceId);
        continue;
      }

      restoredDevices.push(resolved.device);
      if (resolved.device.serial) {
        nextDeviceMetadata.set(deviceId, {
          serial: resolved.device.serial,
        });
      }
    }

    const reconnectingNames = restoredDevices
      .filter((device) => device.status === "connecting")
      .map((device) => device.name);

    if (reconnectingNames.length > 0) {
      issues.push(createPlatformIssue(
        "android",
        `Android connection dropped. Keeping the session warm while adb reconnects${reconnectingNames.length === 1 ? ` to ${reconnectingNames[0]}` : ""}.`,
      ));
    }

    return [...androidDevices, ...restoredDevices].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function attemptAndroidDeviceRecovery(reason: string): Promise<void> {
    const now = Date.now();
    if (now - lastAndroidRecoveryAt < ANDROID_DEVICE_RECOVERY_COOLDOWN_MS) {
      return;
    }

    lastAndroidRecoveryAt = now;
    logService?.log("warn", "devices.android-recovery", "Attempting adb recovery", { reason });

    await execFile("adb", ["start-server"], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: 2_000,
    }).catch(() => undefined);

    await execFile("adb", ["reconnect", "offline"], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: 3_000,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  function closeIosVideoBridgeClients(bridge: IosSimulatorVideoBridge, reason: string): void {
    if (bridge.closeReason) {
      return;
    }

    bridge.closeReason = reason;
    const message = reason.slice(0, 120) || "iOS simulator video stream stopped";

    for (const client of [...bridge.clients]) {
      bridge.clients.delete(client);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, message);
      }
    }
  }

  function terminateIosVideoBridge(bridge: IosSimulatorVideoBridge | null | undefined, reason: string): void {
    if (!bridge) {
      return;
    }

    closeIosVideoBridgeClients(bridge, reason);
    bridge.child.stdin?.end();

    if (bridge.child.killed || !bridge.child.pid) {
      return;
    }

    try {
      bridge.child.kill("SIGTERM");
    } catch {
      // Ignore teardown failures.
    }
  }

  function sendIosVideoBridgePacket(bridge: IosSimulatorVideoBridge, message: Buffer | string, isBinary: boolean): void {
    for (const client of bridge.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        bridge.clients.delete(client);
        continue;
      }

      client.send(message, { binary: isBinary, compress: false });
    }
  }

  function consumeIosSimulatorBridgeStdout(bridge: IosSimulatorVideoBridge, chunk: Buffer): void {
    bridge.buffer = bridge.buffer.length > 0 ? Buffer.concat([bridge.buffer, chunk]) : chunk;

    while (bridge.buffer.length >= 5) {
      const packetLength = bridge.buffer.readUInt32BE(0);
      if (packetLength <= 0 || bridge.buffer.length < packetLength + 4) {
        return;
      }

      const packetType = bridge.buffer[4] as IosSimulatorBridgePacketType;
      const payload = bridge.buffer.subarray(5, 4 + packetLength);
      bridge.buffer = bridge.buffer.subarray(4 + packetLength);

      if (packetType === 0) {
        const message = payload.toString("utf8");
        bridge.latestMetadata = message;
        try {
          const parsed = JSON.parse(message) as {
            pixelHeight?: unknown;
            pixelWidth?: unknown;
            pointHeight?: unknown;
            pointWidth?: unknown;
          };
          const pixelHeight = Number(parsed.pixelHeight);
          const pixelWidth = Number(parsed.pixelWidth);
          const pointHeight = Number(parsed.pointHeight);
          const pointWidth = Number(parsed.pointWidth);
          bridge.latestPixelHeight = Number.isFinite(pixelHeight) && pixelHeight > 0 ? pixelHeight : null;
          bridge.latestPixelWidth = Number.isFinite(pixelWidth) && pixelWidth > 0 ? pixelWidth : null;
          bridge.latestPointHeight = Number.isFinite(pointHeight) && pointHeight > 0 ? pointHeight : null;
          bridge.latestPointWidth = Number.isFinite(pointWidth) && pointWidth > 0 ? pointWidth : null;
        } catch {
          bridge.latestPointHeight = null;
          bridge.latestPointWidth = null;
          bridge.latestPixelHeight = null;
          bridge.latestPixelWidth = null;
        }
        sendIosVideoBridgePacket(bridge, message, false);
        continue;
      }

      const binaryMessage = Buffer.concat([Buffer.from([packetType]), payload]);
      if (packetType === 1) {
        bridge.latestConfigPacket = binaryMessage;
      }
      if (packetType === 2) {
        bridge.latestKeyPacket = binaryMessage;
      }

      if (packetType === 1 || packetType === 2 || packetType === 3) {
        sendIosVideoBridgePacket(bridge, binaryMessage, true);
      }
    }
  }

  async function startIosSimulatorVideoBridge(
    runtimeSessionId: string,
    udid: string,
    deviceName: string,
  ): Promise<IosSimulatorVideoBridge> {
    const spawnSpec = createIosSimulatorBridgeSpawnSpec(udid);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: process.cwd(),
      env: managedSubprocessEnv,
      shell: spawnSpec.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("Failed to initialize the simulator bridge process pipes.");
    }

    const bridge: IosSimulatorVideoBridge = {
      buffer: Buffer.alloc(0),
      child,
      clients: new Set(),
      closeReason: null,
      latestConfigPacket: null,
      latestPointHeight: null,
      latestPointWidth: null,
      latestKeyPacket: null,
      latestMetadata: null,
      latestPixelHeight: null,
      latestPixelWidth: null,
    };

    const stderrLines: string[] = [];
    const rememberStderr = (value: string) => {
      for (const line of value.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        stderrLines.push(trimmed);
        if (stderrLines.length > 20) {
          stderrLines.shift();
        }
        logService?.log("info", "devices.ios-simulator-bridge", trimmed, {
          deviceName,
          runtimeSessionId,
          udid,
        });
      }
    };

    const buildFailureReason = () => stderrLines.at(-1)
      ?? `Simulator bridge exited before the first frame for ${deviceName}.`;

    child.stderr.on("data", (chunk: Buffer | string) => {
      rememberStderr(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    });

    const readyPromise = new Promise<IosSimulatorVideoBridge>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(readyTimer);
        resolve(bridge);
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(readyTimer);
        reject(error);
      };

      const readyTimer = setTimeout(() => {
        settleReject(new Error(`Timed out waiting for the iOS simulator bridge to start for ${deviceName}.`));
      }, IOS_SIMULATOR_BRIDGE_READY_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer | string) => {
        consumeIosSimulatorBridgeStdout(bridge, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (bridge.latestMetadata) {
          settleResolve();
        }
      });

      child.on("error", (error) => {
        closeIosVideoBridgeClients(bridge, error.message);
        settleReject(error);
      });

      child.on("exit", (code, signal) => {
        const reason = buildFailureReason();
        closeIosVideoBridgeClients(bridge, reason);

        if (settled) {
          logService?.log("warn", "devices.ios-simulator-bridge", "Simulator bridge exited", {
            code,
            command: spawnSpec.prettyCommand,
            runtimeSessionId,
            signal,
            udid,
          });
          const activeSession = streamSessions.get(runtimeSessionId);
          if (activeSession?.iosVideoBridge === bridge) {
            iosSimulatorBridgeIssue = reason;
            streamSessions.delete(runtimeSessionId);
            void refreshAndEmit();
          }
          return;
        }

        settleReject(new Error(reason));
      });
    });

    logService?.log("info", "devices.ios-simulator-bridge", "Starting simulator bridge", {
      command: spawnSpec.prettyCommand,
      deviceName,
      runtimeSessionId,
      udid,
    });

    try {
      return await readyPromise;
    } catch (error) {
      terminateIosVideoBridge(bridge, error instanceof Error ? error.message : "Simulator bridge failed to start.");
      throw error;
    }
  }

  function emit(nextSnapshot: DeviceInventorySnapshot): void {
    snapshot = nextSnapshot;
    for (const listener of [...listeners]) {
      listener(nextSnapshot);
    }
  }

  function ensurePolling(): void {
    if (refreshTimer) {
      return;
    }

    refreshTimer = setInterval(() => {
      void refreshAndEmit();
    }, getRefreshIntervalMs());
  }

  function stopPollingIfIdle(): void {
    if (listeners.size === 0 && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function startSidecar(
    current: ManagedSidecar | null,
    options: {
      name: string;
      command: string;
      baseUrl: string;
      healthPath: string;
      acceptedHealthStatuses?: number[];
    },
  ): Promise<ManagedSidecar> {
    const { name, command, baseUrl, healthPath, acceptedHealthStatuses = [] } = options;

    if (await isHttpReady(baseUrl, healthPath, HEALTH_TIMEOUT_MS, acceptedHealthStatuses)) {
      const logPath = getSidecarLogPath(name);
      return current ?? {
        child: null as unknown as ChildProcess,
        command,
        baseUrl,
        logPath,
        startedByRuntime: false,
      };
    }

    if (!command) {
      throw new Error(`${name} is not reachable. Configure a start command or launch it manually.`);
    }

    const logPath = getSidecarLogPath(name);
    const wrappedCommand = process.platform === "win32"
      ? command
      : `(${command}) >> ${quotePosixShellArg(logPath)} 2>&1`;

    const child = spawn(wrappedCommand, {
      cwd: process.cwd(),
      stdio: "ignore",
      shell: true,
      detached: process.platform !== "win32",
      env: managedSubprocessEnv,
    });
    child.unref();

    const managedSidecar: ManagedSidecar = {
      child,
      command,
      baseUrl,
      logPath,
      startedByRuntime: true,
    };

    child.on("exit", (code, signal) => {
      logService?.log("warn", "devices.sidecar", `${name} exited`, { baseUrl, code, logPath, signal, command });
      if (androidSidecar === managedSidecar) {
        androidSidecar = null;
      }
      void refreshAndEmit();
    });

    logService?.log("info", "devices.sidecar", `Starting ${name}`, { baseUrl, command, logPath, wrappedCommand });
    await waitForHttpReady(baseUrl, healthPath, START_TIMEOUT_MS, acceptedHealthStatuses);
    return managedSidecar;
  }

  async function ensureAndroidSidecarReady(): Promise<string> {
    const baseUrl = getAndroidBaseUrl();
    const command = process.env.ANDROID_WS_SCRCPY_COMMAND?.trim() || getBundledAndroidSidecarCommand();

    androidSidecar = await startSidecar(androidSidecar, {
      name: "ws-scrcpy",
      command,
      baseUrl,
      healthPath: "/",
      acceptedHealthStatuses: [401],
    });

    return baseUrl;
  }

  async function listAdbDevicesWithRecovery(): Promise<ReturnType<typeof parseAdbDevicesOutput>> {
    const shouldAttemptRecovery = rememberedAndroidDevices.size > 0
      || [...streamSessions.values()].some((session) => session.platform === "android");

    const runDiscovery = async () => {
      const { stdout } = await execFile("adb", ["devices", "-l"], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      return parseAdbDevicesOutput(stdout);
    };

    let parsed = await runDiscovery();
    const hasReachableDevice = parsed.some((device) => device.state === "device");

    if (!shouldAttemptRecovery || hasReachableDevice) {
      return parsed;
    }

    await attemptAndroidDeviceRecovery(parsed.length === 0 ? "empty-device-list" : "no-ready-device");
    parsed = await runDiscovery();
    return parsed;
  }

  async function discoverAndroidDevices(issues: DeviceIssue[], nextDeviceMetadata: Map<string, DeviceMetadata>): Promise<DeviceSummary[]> {
    try {
      const parsed = await listAdbDevicesWithRecovery();
      const streamingDeviceIds = new Set([...streamSessions.values()].map((session) => session.deviceId));

      return await Promise.all(parsed.map(async (device) => {
        const deviceId = `android:${device.serial}`;
        const hasSession = streamingDeviceIds.has(deviceId);
        const { status, lastError } = resolveAndroidStatus(device.state, hasSession);
        const name = await resolveAndroidDisplayName(device);

        const summary = {
          id: deviceId,
          name,
          platform: "android",
          status,
          connectionKind: device.connectionKind,
          supportsEmbeddedStream: true,
          supportsControl: true,
          serial: device.serial,
          lastError,
        } satisfies DeviceSummary;

        nextDeviceMetadata.set(summary.id, {
          serial: device.serial,
        });

        return summary;
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "adb unavailable";
      issues.push(createPlatformIssue("android", `Android discovery unavailable: ${message}`));
      return [];
    }
  }

  async function discoverBootedIosSimulators(issues: DeviceIssue[]) {
    try {
      const { stdout } = await execFile("xcrun", ["simctl", "list", "devices", "available", "--json"], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: DISCOVERY_TIMEOUT_MS,
      });

      return parseSimctlDevicesOutput(stdout).filter((device) => device.isAvailable && device.state === "Booted");
    } catch (error) {
      const message = error instanceof Error ? error.message : "xcrun simctl unavailable";
      issues.push(createPlatformIssue("ios-simulator", `iOS simulator discovery unavailable: ${message}`));
      return [];
    }
  }

  async function discoverIosDevices(issues: DeviceIssue[], nextDeviceMetadata: Map<string, DeviceMetadata>): Promise<DeviceSummary[]> {
    const streamingDeviceIds = new Set([...streamSessions.values()].map((session) => session.deviceId));
    const bootedSimulators = await discoverBootedIosSimulators(issues);

    return bootedSimulators.map((simulator) => {
      const id = `ios-simulator:${simulator.udid}`;
      nextDeviceMetadata.set(id, {
        serial: simulator.udid,
      });

      return {
        id,
        name: simulator.name,
        platform: "ios-simulator",
        status: streamingDeviceIds.has(id) ? "streaming" : "available",
        connectionKind: "simulator",
        supportsEmbeddedStream: true,
        supportsControl: true,
        serial: simulator.udid,
        lastError: null,
      } satisfies DeviceSummary;
    });
  }

  async function refreshSnapshot(): Promise<DeviceInventorySnapshot> {
    if (refreshPromise) {
      return refreshPromise;
    }

    refreshPromise = (async () => {
      const issues: DeviceIssue[] = [];
      const nextDeviceMetadata = new Map<string, DeviceMetadata>();
      const [androidDevices, iosDevices] = await Promise.all([
        discoverAndroidDevices(issues, nextDeviceMetadata),
        discoverIosDevices(issues, nextDeviceMetadata),
      ]);
      rememberAndroidDevices(androidDevices);
      const mergedAndroidDevices = restoreRememberedAndroidDevices(androidDevices, issues, nextDeviceMetadata);
      pruneMissingAndroidStreamSessions(new Set(mergedAndroidDevices.map((device) => device.id)));

      if (iosSimulatorBridgeIssue) {
        issues.push(createPlatformIssue(
          "ios-simulator",
          `Native iOS simulator streaming is unavailable: ${iosSimulatorBridgeIssue}`,
        ));
      }

      deviceMetadata = nextDeviceMetadata;

      return {
        devices: [...mergedAndroidDevices, ...iosDevices].sort((a, b) => a.name.localeCompare(b.name)),
        activeSessions: [...streamSessions.values()].map((session) => toPublicSession(session)),
        issues,
        refreshedAt: new Date().toISOString(),
      } satisfies DeviceInventorySnapshot;
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function refreshAndEmit(): Promise<DeviceInventorySnapshot> {
    const nextSnapshot = await refreshSnapshot();
    emit(nextSnapshot);
    return nextSnapshot;
  }

  async function listSnapshot(): Promise<DeviceInventorySnapshot> {
    ensurePolling();
    if (snapshot.refreshedAt === new Date(0).toISOString()) {
      return refreshAndEmit();
    }

    return refreshSnapshot();
  }

  async function startStream(deviceId: string, input: StartDeviceStreamInput = {}): Promise<DeviceStreamSession> {
    ensurePolling();
    const existing = [...streamSessions.values()].find((session) => session.deviceId === deviceId);
    if (existing) {
      return toPublicSession(existing);
    }

    const currentSnapshot = await refreshSnapshot();
    const device = currentSnapshot.devices.find((item) => item.id === deviceId);
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    let redirectUrl = "";
    let viewerMode: InternalStreamSession["viewerMode"] = "redirect";
    let controlTransport: DeviceStreamSession["controlTransport"] = "iframe";
    const sessionId = randomUUID();
    let viewerUrl = `/api/device-streams/${encodeURIComponent(sessionId)}/viewer`;
    let proxyBaseUrl: string | null = null;
    let proxyAuthorizationHeader: string | null = null;
    if (device.platform === "android") {
      const serial = device.serial?.trim();
      if (!serial) {
        throw new Error("Android device serial is unavailable");
      }

      const baseUrl = await ensureAndroidSidecarReady();
      viewerMode = "proxy";
      controlTransport = "websocket";
      viewerUrl = buildAndroidProxyViewerUrl(sessionId, serial, input.preferredPlayer ?? "webcodecs");
      proxyBaseUrl = baseUrl;
      proxyAuthorizationHeader = getAndroidBasicAuthorizationHeader();
    } else {
      if (process.platform !== "darwin") {
        throw new Error("Native iOS simulator streaming requires macOS.");
      }

      const metadata = deviceMetadata.get(device.id) ?? {
        serial: device.serial?.trim() || null,
      } satisfies DeviceMetadata;
      const udid = metadata.serial?.trim() || device.serial?.trim();
      if (!udid) {
        throw new Error("iOS simulator UDID is unavailable.");
      }

      try {
        const iosVideoBridge = await startIosSimulatorVideoBridge(sessionId, udid, device.name);
        iosSimulatorBridgeIssue = null;

        const session: InternalStreamSession = {
          sessionId,
          deviceId: device.id,
          platform: device.platform,
          viewerUrl,
          controlTransport: "websocket",
          startedAt: new Date().toISOString(),
          viewerMode,
          redirectUrl: viewerMode === "redirect" && redirectUrl ? redirectUrl : null,
          iosNativeControl: true,
          iosUdid: udid,
          proxyBaseUrl: null,
          proxyAuthorizationHeader: null,
          iosVideoBridge,
        };

        streamSessions.set(session.sessionId, session);
        await refreshAndEmit();
        return toPublicSession(session);
      } catch (error) {
        const rawVideoBridgeError = error instanceof Error ? error.message : String(error);
        const videoBridgeError = await annotateIosSimulatorBridgeError(rawVideoBridgeError);
        iosSimulatorBridgeIssue = videoBridgeError;
        logService?.log("warn", "devices.ios-simulator-bridge", "Native iOS simulator streaming failed to start", {
          deviceId: device.id,
          deviceName: device.name,
          error: videoBridgeError,
          udid,
        });
        throw new Error(videoBridgeError || "Unable to start the iOS simulator stream.");
      }
    }

    const session: InternalStreamSession = {
      sessionId,
      deviceId: device.id,
      platform: device.platform,
      viewerUrl,
      controlTransport,
      startedAt: new Date().toISOString(),
      viewerMode,
      redirectUrl: null,
      iosNativeControl: false,
      iosUdid: null,
      proxyBaseUrl,
      proxyAuthorizationHeader,
      iosVideoBridge: null,
    };

    streamSessions.set(session.sessionId, session);
    await refreshAndEmit();
    return toPublicSession(session);
  }

  async function stopStream(sessionId: string): Promise<void> {
    const session = streamSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

    streamSessions.delete(sessionId);
    terminateIosVideoBridge(session.iosVideoBridge, "iOS simulator stream stopped");
    await refreshAndEmit();
  }

  function getViewerRedirectUrl(sessionId: string): string | null {
    return streamSessions.get(sessionId)?.redirectUrl ?? null;
  }

  function getViewerSession(sessionId: string): DeviceViewerSession | null {
    const session = streamSessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      viewerMode: session.viewerMode,
      platform: session.platform,
      redirectUrl: session.redirectUrl,
      proxyBaseUrl: session.proxyBaseUrl,
      proxyAuthorizationHeader: session.proxyAuthorizationHeader,
    };
  }

  function attachIosNativeVideoClient(sessionId: string, socket: WebSocket): boolean {
    const session = streamSessions.get(sessionId);
    const bridge = session?.iosVideoBridge;
    if (!session || session.platform !== "ios-simulator" || !bridge) {
      return false;
    }

    bridge.clients.add(socket);

    if (bridge.latestMetadata) {
      socket.send(bridge.latestMetadata);
    }

    if (bridge.latestConfigPacket) {
      socket.send(bridge.latestConfigPacket, { binary: true });
    }
    if (bridge.latestKeyPacket) {
      socket.send(bridge.latestKeyPacket, { binary: true });
    }

    if (bridge.closeReason) {
      socket.close(1011, bridge.closeReason.slice(0, 120));
      return true;
    }

    socket.on("close", () => {
      bridge.clients.delete(socket);
    });

    socket.on("error", () => {
      bridge.clients.delete(socket);
    });

    return true;
  }

  function getNativeIosControlSession(sessionId: string): InternalStreamSession | null {
    const session = streamSessions.get(sessionId);
    if (!session || session.platform !== "ios-simulator" || !session.iosNativeControl || !session.iosUdid) {
      return null;
    }

    return session;
  }

  function getNativeIosStatus(sessionId: string): {
    session_info: {
      device_height: number;
      device_width: number;
      pixel_height: number;
      pixel_width: number;
    };
  } | null {
    const session = getNativeIosControlSession(sessionId);
    if (!session) {
      return null;
    }

    const pixelHeight = session.iosVideoBridge?.latestPixelHeight ?? 0;
    const pixelWidth = session.iosVideoBridge?.latestPixelWidth ?? 0;
    const deviceHeight = session.iosVideoBridge?.latestPointHeight ?? 0;
    const deviceWidth = session.iosVideoBridge?.latestPointWidth ?? 0;
    if (pixelHeight <= 0 || pixelWidth <= 0 || deviceHeight <= 0 || deviceWidth <= 0) {
      return null;
    }

    return {
      session_info: {
        device_height: deviceHeight,
        device_width: deviceWidth,
        pixel_height: pixelHeight,
        pixel_width: pixelWidth,
      },
    };
  }

  async function getNativeIosScreenshot(sessionId: string): Promise<Buffer | null> {
    const session = getNativeIosControlSession(sessionId);
    if (!session?.iosUdid) {
      return null;
    }

    return captureIosSimulatorScreenshot(session.iosUdid);
  }

  function resolveAndroidSessionSerial(session: InternalStreamSession): string {
    if (session.platform !== "android") {
      throw new Error("Android clipboard is only available for Android sessions.");
    }

    const metadataSerial = deviceMetadata.get(session.deviceId)?.serial?.trim();
    if (metadataSerial) {
      return metadataSerial;
    }

    if (session.deviceId.startsWith("android:")) {
      const serial = session.deviceId.slice("android:".length).trim();
      if (serial.length > 0) {
        return serial;
      }
    }

    throw new Error("Android device serial is unavailable.");
  }

  async function ensureAndroidClipboardHelperDex(): Promise<string> {
    const sourcePath = getAndroidClipboardHelperSourcePath();
    const sourceMtimeMs = statSync(sourcePath).mtimeMs;
    const dexDirectory = getAndroidClipboardHelperBuildPath("dex");
    const dexPath = joinPath(dexDirectory, "classes.dex");

    if (existsSync(dexPath) && statSync(dexPath).mtimeMs >= sourceMtimeMs) {
      androidClipboardHelperDexPath = dexPath;
      androidClipboardHelperSourceMtimeMs = sourceMtimeMs;
      return dexPath;
    }

    if (
      androidClipboardHelperDexPath === dexPath
      && androidClipboardHelperSourceMtimeMs === sourceMtimeMs
      && existsSync(dexPath)
    ) {
      return dexPath;
    }

    if (androidClipboardHelperBuildPromise) {
      return await androidClipboardHelperBuildPromise;
    }

    androidClipboardHelperBuildPromise = (async () => {
      const classesDirectory = getAndroidClipboardHelperBuildPath("classes");
      const helperClassPath = joinPath(classesDirectory, "dev", "codesymphony", "android", "ClipboardCli.class");
      const d8Path = resolveAndroidD8Path();

      await execFile("javac", [
        "-d",
        classesDirectory,
        sourcePath,
      ], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: ANDROID_CLIPBOARD_HELPER_BUILD_TIMEOUT_MS,
      });
      await execFile(d8Path, [
        "--output",
        dexDirectory,
        helperClassPath,
      ], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: ANDROID_CLIPBOARD_HELPER_BUILD_TIMEOUT_MS,
      });

      androidClipboardHelperDexPath = dexPath;
      androidClipboardHelperSourceMtimeMs = sourceMtimeMs;
      return dexPath;
    })().finally(() => {
      androidClipboardHelperBuildPromise = null;
    });

    return await androidClipboardHelperBuildPromise;
  }

  async function runAndroidClipboardHelper(serial: string, args: string[]): Promise<string> {
    const dexPath = await ensureAndroidClipboardHelperDex();
    await execFile("adb", [
      "-s",
      serial,
      "push",
      dexPath,
      ANDROID_CLIPBOARD_HELPER_DEVICE_PATH,
    ], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: ANDROID_CLIPBOARD_TIMEOUT_MS,
    });
    const { stdout } = await execFile("adb", [
      "-s",
      serial,
      "shell",
      `CLASSPATH=${ANDROID_CLIPBOARD_HELPER_DEVICE_PATH}`,
      "app_process",
      "/",
      ANDROID_CLIPBOARD_HELPER_ENTRYPOINT,
      ...args,
    ], {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: ANDROID_CLIPBOARD_TIMEOUT_MS,
    });

    return stdout;
  }

  async function readAndroidClipboard(sessionId: string): Promise<string> {
    const session = streamSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

    const serial = resolveAndroidSessionSerial(session);
    try {
      return await runAndroidClipboardHelper(serial, ["get"]);
    } catch (helperError) {
      const { stdout: hasTextOutput } = await execFile("adb", [
        "-s",
        serial,
        "shell",
        "service",
        "call",
        "clipboard",
        "9",
        ...ANDROID_CLIPBOARD_SERVICE_ARGS_BASE,
      ], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: ANDROID_CLIPBOARD_TIMEOUT_MS,
      });
      const hasClipboardText = parseAndroidClipboardBooleanServiceCall(hasTextOutput);
      if (hasClipboardText === false) {
        return "";
      }

      const { stdout } = await execFile("adb", [
        "-s",
        serial,
        "shell",
        "service",
        "call",
        "clipboard",
        "4",
        ...ANDROID_CLIPBOARD_SERVICE_ARGS_BASE,
      ], {
        encoding: "utf8",
        env: managedSubprocessEnv,
        timeout: ANDROID_CLIPBOARD_TIMEOUT_MS,
      });
      const text = parseAndroidClipboardServiceCallOutput(stdout);
      if (text == null) {
        throw helperError instanceof Error
          ? helperError
          : new Error("Android clipboard contents could not be decoded.");
      }

      return text;
    }
  }

  async function writeAndroidClipboard(
    sessionId: string,
    input: {
      paste?: boolean;
      text: string;
    },
  ): Promise<void> {
    const session = streamSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

    const serial = resolveAndroidSessionSerial(session);
    const encodedText = Buffer.from(input.text, "utf8").toString("base64");
    await runAndroidClipboardHelper(serial, ["set-base64", encodedText]);

    if (input.paste) {
      await runAndroidShellCommand(serial, `input keyevent ${ANDROID_CLIPBOARD_PASTE_KEYCODE}`);
    }
  }

  function readPayloadNumber(payload: SendDeviceControlInput["payload"], key: string): number {
    const value = Number(payload?.[key]);
    if (!Number.isFinite(value)) {
      throw new Error(`Missing numeric control payload field: ${key}`);
    }
    return value;
  }

  function readPayloadString(payload: SendDeviceControlInput["payload"], key: string): string {
    const value = payload?.[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Missing string control payload field: ${key}`);
    }
    return value;
  }

  function readPayloadText(payload: SendDeviceControlInput["payload"], key: string): string {
    const value = payload?.[key];
    if (typeof value !== "string") {
      throw new Error(`Missing string control payload field: ${key}`);
    }
    return value;
  }

  function normalizeIosEdgeTouchCoordinate(value: number, max: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
      return value;
    }

    if (value <= 1 && value >= 0) {
      return value;
    }

    return Math.min(Math.max(value / max, 0), 1);
  }

  function normalizeIosTouchInputForBridge(
    session: InternalStreamSession,
    input: SendDeviceControlInput,
  ): SendDeviceControlInput {
    if (input.action !== "touch") {
      return input;
    }

    const payload = input.payload ?? {};
    const edge = typeof payload.edge === "string" ? payload.edge.trim() : "";
    if (!edge) {
      return input;
    }

    const width = session.iosVideoBridge?.latestPointWidth ?? 0;
    const height = session.iosVideoBridge?.latestPointHeight ?? 0;
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) {
      return input;
    }

    return {
      ...input,
      payload: {
        ...payload,
        x: normalizeIosEdgeTouchCoordinate(x, width),
        y: normalizeIosEdgeTouchCoordinate(y, height),
      },
    };
  }

  function quoteForPosixShell(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }

  async function runAndroidShellCommand(serial: string, command: string): Promise<void> {
    await exec(`adb -s ${quoteForPosixShell(serial)} shell ${command}`, {
      encoding: "utf8",
      env: managedSubprocessEnv,
      timeout: ANDROID_CONTROL_TIMEOUT_MS,
    });
  }

  async function sendNativeAndroidControl(session: InternalStreamSession, input: SendDeviceControlInput): Promise<void> {
    const serial = resolveAndroidSessionSerial(session);
    const payload = input.payload ?? {};

    switch (input.action) {
      case "tap": {
        const x = Math.round(readPayloadNumber(payload, "x"));
        const y = Math.round(readPayloadNumber(payload, "y"));
        await runAndroidShellCommand(serial, `input tap ${x} ${y}`);
        return;
      }

      case "swipe": {
        const x1 = Math.round(readPayloadNumber(payload, "x1"));
        const y1 = Math.round(readPayloadNumber(payload, "y1"));
        const x2 = Math.round(readPayloadNumber(payload, "x2"));
        const y2 = Math.round(readPayloadNumber(payload, "y2"));
        const duration = payload.duration == null
          ? null
          : Math.max(0, Math.round(Number(payload.duration)));
        const args = ["input", "swipe", String(x1), String(y1), String(x2), String(y2)];
        if (duration != null) {
          args.push(String(duration));
        }
        await runAndroidShellCommand(serial, args.join(" "));
        return;
      }

      case "key": {
        const keycode = Math.trunc(readPayloadNumber(payload, "keycode"));
        if (keycode < 0) {
          throw new Error(`Invalid Android keycode: ${keycode}`);
        }

        const args = ["input", "keyevent"];
        if (payload.duration != null) {
          const duration = Number(payload.duration);
          if (Number.isFinite(duration) && duration > 0) {
            args.push("--duration", String(Math.round(duration)));
          }
        }
        args.push(String(keycode));
        await runAndroidShellCommand(serial, args.join(" "));
        return;
      }

      case "text": {
        const text = readPayloadText(payload, "text");
        const commands = buildAndroidInputTextCommands(text);
        if (commands.length === 0) {
          return;
        }

        for (const command of commands) {
          if (command.type === "text") {
            await runAndroidShellCommand(serial, `input text ${quoteForPosixShell(command.value)}`);
            continue;
          }

          await runAndroidShellCommand(serial, `input keyevent ${command.value}`);
        }
        return;
      }

      default:
        throw new Error(`Unsupported control action: ${input.action}`);
    }
  }

  async function writeNativeIosBridgeControl(
    bridge: IosSimulatorVideoBridge,
    input: SendDeviceControlInput,
  ): Promise<void> {
    const stdin = bridge.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || bridge.closeReason) {
      throw new Error("iOS simulator bridge control pipe is unavailable.");
    }

    const message = `${JSON.stringify({
      action: input.action,
      payload: input.payload ?? {},
    })}\n`;

    await new Promise<void>((resolve, reject) => {
      stdin.write(message, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async function sendNativeIosControl(session: InternalStreamSession, input: SendDeviceControlInput): Promise<void> {
    if (!session.iosUdid) {
      throw new Error("iOS simulator UDID is unavailable for native control.");
    }

    const normalizedInput = normalizeIosTouchInputForBridge(session, input);

    if (session.iosVideoBridge) {
      try {
        await writeNativeIosBridgeControl(session.iosVideoBridge, normalizedInput);
        return;
      } catch (error) {
        logService?.log("warn", "devices.ios-simulator-bridge", "Falling back to one-shot iOS control command", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.sessionId,
          udid: session.iosUdid,
        });
      }
    }

    const payload = normalizedInput.payload ?? {};
    let args: string[];

    switch (normalizedInput.action) {
      case "tap":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "tap",
          "--x",
          String(readPayloadNumber(payload, "x")),
          "--y",
          String(readPayloadNumber(payload, "y")),
        ];
        break;
      case "touch":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "touch",
          "--x",
          String(readPayloadNumber(payload, "x")),
          "--y",
          String(readPayloadNumber(payload, "y")),
          "--phase",
          readPayloadString(payload, "phase"),
        ];
        if (typeof payload.edge === "string" && payload.edge.trim().length > 0) {
          args.push("--edge", payload.edge.trim());
        }
        break;
      case "swipe":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "swipe",
          "--start-x",
          String(readPayloadNumber(payload, "start_x")),
          "--start-y",
          String(readPayloadNumber(payload, "start_y")),
          "--end-x",
          String(readPayloadNumber(payload, "end_x")),
          "--end-y",
          String(readPayloadNumber(payload, "end_y")),
          "--duration",
          String(Math.min(Math.max(Number(payload.duration ?? 0.2), 0.08), 0.8)),
        ];
        if (typeof payload.delta === "number" && Number.isFinite(payload.delta)) {
          args.push("--delta", String(Math.min(Math.max(payload.delta, 2), 12)));
        }
        break;
      case "drag":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "drag",
          "--phase",
          readPayloadString(payload, "phase"),
          "--points-json",
          JSON.stringify(payload.points ?? []),
        ];
        break;
      case "text":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "text",
          "--text",
          readPayloadString(payload, "text"),
        ];
        break;
      case "key":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "key",
          "--key",
          readPayloadString(payload, "key"),
        ];
        if (payload.duration != null) {
          args.push("--duration", String(Number(payload.duration)));
        }
        break;
      case "button":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "button",
          "--button",
          readPayloadString(payload, "button"),
        ];
        break;
      case "system":
        args = [
          "control",
          "--udid",
          session.iosUdid,
          "--action",
          "system",
          "--name",
          readPayloadString(payload, "name"),
        ];
        break;
      default:
        throw new Error(`Unsupported control action: ${normalizedInput.action}`);
    }

    await runLocalIosSimulatorBridge(args);
  }

  async function sendControl(sessionId: string, input: SendDeviceControlInput): Promise<void> {
    const session = streamSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

    if (input.action === "noop") {
      return;
    }

    if (session.platform === "android") {
      await sendNativeAndroidControl(session, input);
      return;
    }

    if (session.platform === "ios-simulator" && session.iosNativeControl) {
      await sendNativeIosControl(session, input);
      return;
    }

    throw new Error(`Unsupported control action: ${input.action}`);
  }

  function subscribe(listener: DeviceListener): () => void {
    listeners.add(listener);
    ensurePolling();

    return () => {
      listeners.delete(listener);
      stopPollingIfIdle();
    };
  }

  async function stopAll(): Promise<void> {
    for (const session of streamSessions.values()) {
      terminateIosVideoBridge(session.iosVideoBridge, "Shutting down device service");
    }

    streamSessions.clear();
    iosSimulatorBridgeIssue = null;

    const sidecars = [androidSidecar].filter((value): value is ManagedSidecar => value !== null);
    for (const sidecar of sidecars) {
      if (!sidecar.startedByRuntime || !sidecar.child.pid) {
        continue;
      }

      try {
        if (process.platform !== "win32") {
          process.kill(-sidecar.child.pid, "SIGTERM");
        } else {
          sidecar.child.kill("SIGTERM");
        }
      } catch {
        // Ignore teardown failures.
      }
    }

    androidSidecar = null;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  return {
    listSnapshot,
    subscribe,
    startStream,
    stopStream,
    getViewerRedirectUrl,
    getViewerSession,
    attachIosNativeVideoClient,
    getNativeIosStatus,
    getNativeIosScreenshot,
    readAndroidClipboard,
    writeAndroidClipboard,
    sendControl,
    stopAll,
  };
}
