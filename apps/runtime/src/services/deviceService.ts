import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
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
import type { LogEntry } from "./logService.js";
import { buildAndroidProxyViewerUrl, parseAdbDevicesOutput, parseSimctlDevicesOutput } from "./deviceService.utils.js";

const execFile = promisify(execFileCallback);
const DEFAULT_ANDROID_WS_SCRCPY_BASE_URL = "http://127.0.0.1:8765/";
const DEFAULT_IOS_BRIDGE_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const HEALTH_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

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
  platformSessionId?: string | null;
};

type DeviceViewerSession = {
  viewerMode: "redirect" | "proxy";
  platform: DevicePlatform;
  redirectUrl: string | null;
  proxyBaseUrl: string | null;
  proxyAuthorizationHeader: string | null;
  platformSessionId: string | null;
};

type ManagedSidecar = {
  child: ChildProcess;
  command: string;
  baseUrl: string;
  startedByRuntime: boolean;
};

type IosBridgeSession = {
  sessionId: string;
  name: string;
  serial: string | null;
  deviceType: string | null;
  iosVersion: string | null;
};

type DeviceMetadata = {
  serial: string | null;
  iosSessionId: string | null;
  iosVersion: string | null;
  deviceType: string | null;
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

function getIosBridgeBaseUrl(): string {
  return normalizeBaseUrl(process.env.IOS_BRIDGE_BASE_URL?.trim() || DEFAULT_IOS_BRIDGE_BASE_URL);
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

function extractPort(baseUrl: string, fallback: number): number {
  const url = new URL(baseUrl);
  if (url.port.length > 0) {
    const parsed = Number(url.port);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
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
    return { status: "streaming", lastError: null };
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

function normalizeIosSession(raw: unknown): IosBridgeSession | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const session = raw as Record<string, unknown>;
  const sessionId = typeof session.session_id === "string"
    ? session.session_id
    : typeof session.sessionId === "string"
      ? session.sessionId
      : typeof session.id === "string"
        ? session.id
        : null;

  if (!sessionId) {
    return null;
  }

  const nestedInfo = session.session_info && typeof session.session_info === "object"
    ? session.session_info as Record<string, unknown>
    : {};

  const nameCandidates = [
    session.device_type,
    session.device_name,
    nestedInfo.device_type,
    nestedInfo.device_name,
    nestedInfo.name,
    sessionId,
  ];
  const serialCandidates = [
    session.udid,
    session.device_udid,
    nestedInfo.udid,
    nestedInfo.device_udid,
  ];

  return {
    sessionId,
    name: nameCandidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "iOS Simulator",
    serial: serialCandidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null,
    deviceType: typeof session.device_type === "string"
      ? session.device_type
      : typeof nestedInfo.device_type === "string"
        ? nestedInfo.device_type
        : typeof nestedInfo.name === "string"
          ? nestedInfo.name
          : null,
    iosVersion: typeof session.ios_version === "string"
      ? session.ios_version
      : typeof nestedInfo.ios_version === "string"
        ? nestedInfo.ios_version
        : null,
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
    nativeBaseUrl: session.platform === "ios-simulator" ? session.proxyBaseUrl : null,
    platformSessionId: session.platform === "ios-simulator" ? session.platformSessionId ?? null : null,
  };
}

function createPlatformIssue(platform: DevicePlatform, message: string): DeviceIssue {
  return {
    id: `${platform}:${message}`,
    platform,
    severity: "warning",
    message,
  };
}

function buildIosDeviceId(serial: string | null, sessionId: string): string {
  const trimmedSerial = serial?.trim();
  return trimmedSerial ? `ios-simulator:${trimmedSerial}` : `ios-session:${sessionId}`;
}

function getDefaultIosBridgeCommand(port: number): string {
  const args = `start-server --host 127.0.0.1 --port ${port}`;

  if (process.platform === "win32") {
    return `ios-bridge ${args}`;
  }

  return `command -v ios-bridge >/dev/null 2>&1 && ios-bridge ${args} || uvx --from ios-bridge-cli ios-bridge ${args}`;
}

async function resolveAndroidDisplayName(device: ReturnType<typeof parseAdbDevicesOutput>[number]): Promise<string> {
  if (device.connectionKind !== "emulator") {
    return buildAndroidName(device);
  }

  try {
    const { stdout } = await execFile("adb", ["-s", device.serial, "emu", "avd", "name"], {
      encoding: "utf8",
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

export function createDeviceService(logService?: RuntimeLogService) {
  const listeners = new Set<DeviceListener>();
  const streamSessions = new Map<string, InternalStreamSession>();
  let deviceMetadata = new Map<string, DeviceMetadata>();
  let snapshot: DeviceInventorySnapshot = {
    devices: [],
    activeSessions: [],
    issues: [],
    refreshedAt: new Date(0).toISOString(),
  };
  let refreshPromise: Promise<DeviceInventorySnapshot> | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let androidSidecar: ManagedSidecar | null = null;
  let iosBridgeSidecar: ManagedSidecar | null = null;

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
      return current ?? {
        child: null as unknown as ChildProcess,
        command,
        baseUrl,
        startedByRuntime: false,
      };
    }

    if (!command) {
      throw new Error(`${name} is not reachable. Configure a start command or launch it manually.`);
    }

    const child = spawn(command, {
      cwd: process.cwd(),
      stdio: "ignore",
      shell: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
      },
    });
    child.unref();

    const managedSidecar: ManagedSidecar = {
      child,
      command,
      baseUrl,
      startedByRuntime: true,
    };

    child.on("exit", (code, signal) => {
      logService?.log("warn", "devices.sidecar", `${name} exited`, { code, signal, command });
      if (androidSidecar === managedSidecar) {
        androidSidecar = null;
      }
      if (iosBridgeSidecar === managedSidecar) {
        iosBridgeSidecar = null;
      }
      void refreshAndEmit();
    });

    logService?.log("info", "devices.sidecar", `Starting ${name}`, { command, baseUrl });
    await waitForHttpReady(baseUrl, healthPath, START_TIMEOUT_MS, acceptedHealthStatuses);
    return managedSidecar;
  }

  async function ensureAndroidSidecarReady(): Promise<string> {
    const baseUrl = getAndroidBaseUrl();
    const command = process.env.ANDROID_WS_SCRCPY_COMMAND?.trim() || "";

    androidSidecar = await startSidecar(androidSidecar, {
      name: "ws-scrcpy",
      command,
      baseUrl,
      healthPath: "/",
      acceptedHealthStatuses: [401],
    });

    return baseUrl;
  }

  async function ensureIosBridgeReady(): Promise<string> {
    const baseUrl = getIosBridgeBaseUrl();
    const port = extractPort(baseUrl, 8000);
    const command = process.env.IOS_BRIDGE_COMMAND?.trim() || getDefaultIosBridgeCommand(port);

    iosBridgeSidecar = await startSidecar(iosBridgeSidecar, {
      name: "ios-bridge",
      command,
      baseUrl,
      healthPath: "/health",
    });

    return baseUrl;
  }

  async function discoverAndroidDevices(issues: DeviceIssue[], nextDeviceMetadata: Map<string, DeviceMetadata>): Promise<DeviceSummary[]> {
    try {
      const { stdout } = await execFile("adb", ["devices", "-l"], {
        encoding: "utf8",
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      const parsed = parseAdbDevicesOutput(stdout);
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
          iosSessionId: null,
          iosVersion: null,
          deviceType: null,
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
        timeout: DISCOVERY_TIMEOUT_MS,
      });

      return parseSimctlDevicesOutput(stdout).filter((device) => device.isAvailable && device.state === "Booted");
    } catch (error) {
      const message = error instanceof Error ? error.message : "xcrun simctl unavailable";
      issues.push(createPlatformIssue("ios-simulator", `iOS simulator discovery unavailable: ${message}`));
      return [];
    }
  }

  async function fetchIosSessions(baseUrl: string): Promise<IosBridgeSession[]> {
    await fetch(new URL("/api/sessions/recover-orphaned", baseUrl), {
      method: "POST",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }).catch(() => undefined);

    const response = await fetch(new URL("/api/sessions/", baseUrl), {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ios-bridge returned ${response.status}`);
    }

    const payload = await response.json().catch(() => null) as { sessions?: unknown[] } | null;
    const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    return rawSessions
      .map((session) => normalizeIosSession(session))
      .filter((session): session is IosBridgeSession => session !== null);
  }

  async function createIosBridgeSession(baseUrl: string, metadata: DeviceMetadata): Promise<string> {
    const deviceType = metadata.deviceType?.trim();
    const iosVersion = metadata.iosVersion?.trim();

    if (!deviceType || !iosVersion) {
      throw new Error("No ios-bridge session exists for this simulator, and its device/version could not be resolved automatically.");
    }

    const response = await fetch(new URL("/api/sessions/create", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        device_type: deviceType,
        ios_version: iosVersion,
      }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });

    const payload = await response.json().catch(() => null) as { session_id?: unknown; detail?: unknown } | null;
    if (!response.ok) {
      const detail = typeof payload?.detail === "string" ? payload.detail : null;
      throw new Error(detail ?? `ios-bridge returned ${response.status}`);
    }

    if (typeof payload?.session_id !== "string" || payload.session_id.trim().length === 0) {
      throw new Error("ios-bridge returned an invalid session identifier");
    }

    return payload.session_id;
  }

  async function discoverIosDevices(issues: DeviceIssue[], nextDeviceMetadata: Map<string, DeviceMetadata>): Promise<DeviceSummary[]> {
    const devicesById = new Map<string, DeviceSummary>();
    const metadataById = new Map<string, DeviceMetadata>();
    const streamingDeviceIds = new Set([...streamSessions.values()].map((session) => session.deviceId));
    const bootedSimulators = await discoverBootedIosSimulators(issues);

    for (const simulator of bootedSimulators) {
      const id = buildIosDeviceId(simulator.udid, simulator.udid);
      devicesById.set(id, {
        id,
        name: simulator.name,
        platform: "ios-simulator",
        status: streamingDeviceIds.has(id) ? "streaming" : "available",
        connectionKind: "simulator",
        supportsEmbeddedStream: true,
        supportsControl: true,
        serial: simulator.udid,
        lastError: null,
      });
      metadataById.set(id, {
        serial: simulator.udid,
        iosSessionId: null,
        iosVersion: simulator.iosVersion,
        deviceType: simulator.name,
      });
    }

    const baseUrl = getIosBridgeBaseUrl();
    const reachable = await isHttpReady(baseUrl, "/health");

    try {
      if (!reachable) {
        issues.push(createPlatformIssue(
          "ios-simulator",
          "ios-bridge is unavailable. Booted simulators can still appear, but streaming requires ios-bridge to be installed and running.",
        ));
      } else {
        const sessions = await fetchIosSessions(baseUrl);
        for (const session of sessions) {
          const id = buildIosDeviceId(session.serial, session.sessionId);
          const existing = devicesById.get(id);
          devicesById.set(id, {
            id,
            name: existing?.name ?? session.name,
            platform: "ios-simulator",
            status: streamingDeviceIds.has(id) ? "streaming" : "available",
            connectionKind: "simulator",
            supportsEmbeddedStream: true,
            supportsControl: true,
            serial: session.serial,
            lastError: existing?.lastError ?? null,
          });
          metadataById.set(id, {
            serial: session.serial,
            iosSessionId: session.sessionId,
            iosVersion: session.iosVersion ?? metadataById.get(id)?.iosVersion ?? null,
            deviceType: session.deviceType ?? metadataById.get(id)?.deviceType ?? session.name,
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "ios-bridge unavailable";
      issues.push(createPlatformIssue("ios-simulator", `iOS simulator discovery unavailable: ${message}`));

      for (const [id, device] of devicesById) {
        devicesById.set(id, {
          ...device,
          lastError: device.lastError ?? "ios-bridge is unavailable for streaming",
        });
      }
    }

    for (const [id, metadata] of metadataById) {
      nextDeviceMetadata.set(id, metadata);
    }

    return [...devicesById.values()].map((device) => ({
      ...device,
      status: streamingDeviceIds.has(device.id) ? "streaming" : device.status,
    }));
  }

  async function resolveIosSessionId(deviceId: string, metadata: DeviceMetadata): Promise<string> {
    if (metadata.iosSessionId) {
      return metadata.iosSessionId;
    }

    const baseUrl = await ensureIosBridgeReady();
    const sessions = await fetchIosSessions(baseUrl);
    const matchingSession = metadata.serial
      ? sessions.find((session) => session.serial === metadata.serial)
      : null;

    if (matchingSession) {
      deviceMetadata.set(deviceId, {
        ...metadata,
        iosSessionId: matchingSession.sessionId,
      });
      return matchingSession.sessionId;
    }

    const sessionId = await createIosBridgeSession(baseUrl, metadata);
    deviceMetadata.set(deviceId, {
      ...metadata,
      iosSessionId: sessionId,
    });
    return sessionId;
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

      deviceMetadata = nextDeviceMetadata;

      return {
        devices: [...androidDevices, ...iosDevices].sort((a, b) => a.name.localeCompare(b.name)),
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
    let platformSessionId: string | null = null;
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
      const iosBridgeBaseUrl = await ensureIosBridgeReady();
      const metadata = deviceMetadata.get(device.id) ?? {
        serial: device.serial?.trim() || null,
        iosSessionId: device.id.startsWith("ios-session:") ? device.id.slice("ios-session:".length) : null,
        iosVersion: null,
        deviceType: normalizeDeviceLabel(device.name),
      } satisfies DeviceMetadata;
      const sessionId = await resolveIosSessionId(device.id, metadata);

      platformSessionId = sessionId;
      proxyBaseUrl = iosBridgeBaseUrl;
      controlTransport = "websocket";
      redirectUrl = new URL(`/control/${sessionId}`, iosBridgeBaseUrl).toString();
    }

    const session: InternalStreamSession = {
      sessionId,
      deviceId: device.id,
      platform: device.platform,
      viewerUrl,
      controlTransport,
      startedAt: new Date().toISOString(),
      viewerMode,
      redirectUrl: viewerMode === "redirect" ? redirectUrl : null,
      proxyBaseUrl,
      proxyAuthorizationHeader,
      platformSessionId,
    };

    streamSessions.set(session.sessionId, session);
    await refreshAndEmit();
    return toPublicSession(session);
  }

  async function stopStream(sessionId: string): Promise<void> {
    if (!streamSessions.delete(sessionId)) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

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
      platformSessionId: session.platformSessionId ?? null,
    };
  }

  async function sendControl(sessionId: string, input: SendDeviceControlInput): Promise<void> {
    if (!streamSessions.has(sessionId)) {
      throw new Error(`Stream session not found: ${sessionId}`);
    }

    if (input.action === "noop") {
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
    streamSessions.clear();

    const sidecars = [androidSidecar, iosBridgeSidecar].filter((value): value is ManagedSidecar => value !== null);
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
    iosBridgeSidecar = null;
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
    sendControl,
    stopAll,
  };
}
