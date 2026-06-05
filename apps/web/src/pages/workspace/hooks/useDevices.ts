import { useCallback, useEffect, useState } from "react";
import type { DeviceInventorySnapshot, DeviceStreamSession, StartDeviceStreamInput } from "@codesymphony/shared-types";
import { api } from "../../../lib/api";
import { debugLog } from "../../../lib/debugLog";

const EMPTY_SNAPSHOT: DeviceInventorySnapshot = {
  devices: [],
  activeSessions: [],
  issues: [],
  refreshedAt: new Date(0).toISOString(),
};
const DEVICE_SNAPSHOT_TIMEOUT_MS = 5_000;

function roundDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function getNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function createDeviceSnapshotTimeoutError(): Error {
  return new Error(`Device discovery timed out after ${DEVICE_SNAPSHOT_TIMEOUT_MS}ms`);
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

async function fetchDevicesSnapshot(reason: "initial" | "reconnect" | "refresh"): Promise<DeviceInventorySnapshot> {
  const startedAt = getNowMs();
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort();
  }, DEVICE_SNAPSHOT_TIMEOUT_MS);

  debugLog("devices.panel", "snapshot.load.started", {
    reason,
  });

  try {
    const snapshot = await api.getDevices(controller.signal);
    debugLog("devices.panel", "snapshot.load.succeeded", {
      deviceCount: snapshot.devices.length,
      durationMs: roundDurationMs(getNowMs() - startedAt),
      issueCount: snapshot.issues.length,
      reason,
      sessionCount: snapshot.activeSessions.length,
    });
    return snapshot;
  } catch (error) {
    const resolvedError = isAbortError(error)
      ? createDeviceSnapshotTimeoutError()
      : (error instanceof Error ? error : new Error("Failed to load devices"));
    debugLog("devices.panel", "snapshot.load.failed", {
      durationMs: roundDurationMs(getNowMs() - startedAt),
      error: resolvedError.message,
      reason,
    });
    throw resolvedError;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function upsertSession(snapshot: DeviceInventorySnapshot, session: DeviceStreamSession): DeviceInventorySnapshot {
  const existingIndex = snapshot.activeSessions.findIndex((entry) => entry.sessionId === session.sessionId);
  const activeSessions = existingIndex >= 0
    ? snapshot.activeSessions.map((entry, index) => index === existingIndex ? session : entry)
    : [...snapshot.activeSessions, session];

  const devices = snapshot.devices.map((device) =>
    device.id === session.deviceId
      ? {
        ...device,
        status: "streaming" as const,
        lastError: null,
      }
      : device,
  );

  return {
    ...snapshot,
    devices,
    activeSessions,
    refreshedAt: new Date().toISOString(),
  };
}

function removeSession(snapshot: DeviceInventorySnapshot, sessionId: string): DeviceInventorySnapshot {
  const removedSession = snapshot.activeSessions.find((entry) => entry.sessionId === sessionId) ?? null;
  const activeSessions = snapshot.activeSessions.filter((entry) => entry.sessionId !== sessionId);
  const streamingDeviceIds = new Set(activeSessions.map((entry) => entry.deviceId));
  const devices = removedSession
    ? snapshot.devices.map((device) =>
      device.id === removedSession.deviceId
        ? (() => {
          const nextStatus: DeviceInventorySnapshot["devices"][number]["status"] = streamingDeviceIds.has(device.id)
            ? "streaming"
            : "available";
          return {
            ...device,
            status: nextStatus,
          };
        })()
        : device,
    )
    : snapshot.devices;

  return {
    ...snapshot,
    devices,
    activeSessions,
    refreshedAt: new Date().toISOString(),
  };
}

export function useDevices() {
  const [snapshot, setSnapshot] = useState<DeviceInventorySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startingDeviceId, setStartingDeviceId] = useState<string | null>(null);
  const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(null);

  const applySnapshot = useCallback((nextSnapshot: DeviceInventorySnapshot) => {
    setSnapshot(nextSnapshot);
    setLoading(false);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextSnapshot = await fetchDevicesSnapshot("refresh");
      applySnapshot(nextSnapshot);
    } catch (fetchError) {
      setLoading(false);
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load devices");
    }
  }, [applySnapshot]);

  useEffect(() => {
    let disposed = false;
    let stream: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async (reason: "initial" | "reconnect" = "initial") => {
      try {
        const nextSnapshot = await fetchDevicesSnapshot(reason);
        if (!disposed) {
          applySnapshot(nextSnapshot);
        }
      } catch (fetchError) {
        if (!disposed) {
          setLoading(false);
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load devices");
        }
      }

      if (disposed) {
        return;
      }

      stream = api.streamDevices();
      stream.onmessage = (event) => {
        try {
          const nextSnapshot = JSON.parse(event.data as string) as DeviceInventorySnapshot;
          if (!disposed) {
            applySnapshot(nextSnapshot);
          }
        } catch {
          if (!disposed) {
            setError("Failed to parse device updates");
          }
        }
      };

      stream.onerror = () => {
        stream?.close();
        stream = null;
        if (disposed || reconnectTimer) {
          return;
        }

        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connect("reconnect");
        }, 3_000);
      };
    };

    void connect("initial");

    return () => {
      disposed = true;
      stream?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, [applySnapshot]);

  const startStream = useCallback(async (deviceId: string, input: StartDeviceStreamInput = {}) => {
    setStartingDeviceId(deviceId);
    try {
      const session = await api.startDeviceStream(deviceId, input);
      setSnapshot((current) => upsertSession(current, session));
      setError(null);
      return session;
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "Failed to start device stream";
      setError(message);
      throw startError;
    } finally {
      setStartingDeviceId(null);
    }
  }, []);

  const stopStream = useCallback(async (sessionId: string) => {
    setStoppingSessionId(sessionId);
    try {
      await api.stopDeviceStream({ sessionId });
      setSnapshot((current) => removeSession(current, sessionId));
      setError(null);
    } catch (stopError) {
      const message = stopError instanceof Error ? stopError.message : "Failed to stop device stream";
      setError(message);
      throw stopError;
    } finally {
      setStoppingSessionId(null);
    }
  }, []);

  return {
    snapshot,
    loading,
    error,
    refresh,
    startStream,
    stopStream,
    startingDeviceId,
    stoppingSessionId,
  };
}
