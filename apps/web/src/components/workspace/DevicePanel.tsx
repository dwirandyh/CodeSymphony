import { useEffect, useMemo, useState } from "react";
import type { DeviceStatus, DeviceSummary } from "@codesymphony/shared-types";
import { ExternalLink, Play, RefreshCw, RotateCcw, Smartphone, Square, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { openExternalUrl } from "../../lib/openExternalUrl";
import { useDevices } from "../../pages/workspace/hooks/useDevices";
import { AndroidDeviceViewer } from "./AndroidDeviceViewer";
import { IosSimulatorViewer } from "./IosSimulatorViewer";

function getStatusVariant(status: DeviceStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "streaming") {
    return "default";
  }

  if (status === "error") {
    return "destructive";
  }

  if (status === "available") {
    return "secondary";
  }

  return "outline";
}

function platformLabel(platform: "android" | "ios-simulator"): string {
  return platform === "android" ? "Android" : "iOS Simulator";
}

function connectionLabel(connectionKind: DeviceSummary["connectionKind"]): string {
  switch (connectionKind) {
    case "emulator":
      return "Android Emulator";
    case "simulator":
      return "iOS Simulator";
    case "wifi":
      return "ADB over Wi-Fi";
    case "usb":
      return "USB";
    case "remote":
      return "Remote";
    default:
      return connectionKind;
  }
}

type DevicePanelProps = {
  onClose: () => void;
};

export function DevicePanel({ onClose }: DevicePanelProps) {
  const { snapshot, loading, error, refresh, startStream, stopStream, startingDeviceId, stoppingSessionId } = useDevices();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [viewerNonce, setViewerNonce] = useState(0);
  const tabsValue = selectedDeviceId ?? "__none__";

  useEffect(() => {
    if (snapshot.devices.length === 0) {
      setSelectedDeviceId(null);
      return;
    }

    if (selectedDeviceId && snapshot.devices.some((device) => device.id === selectedDeviceId)) {
      return;
    }

    const streamingDevice = snapshot.devices.find((device) => device.status === "streaming");
    setSelectedDeviceId(streamingDevice?.id ?? snapshot.devices[0]?.id ?? null);
  }, [selectedDeviceId, snapshot.devices]);

  const activeDevice = useMemo(
    () => snapshot.devices.find((device) => device.id === selectedDeviceId) ?? null,
    [selectedDeviceId, snapshot.devices],
  );
  const activeSession = useMemo(
    () => snapshot.activeSessions.find((session) => session.deviceId === selectedDeviceId) ?? null,
    [selectedDeviceId, snapshot.activeSessions],
  );
  const viewerSrc = activeSession ? `${api.runtimeBaseUrl}${activeSession.viewerUrl}` : null;
  const selectedDeviceLabel = activeDevice ? `${platformLabel(activeDevice.platform)} · ${connectionLabel(activeDevice.connectionKind)}` : null;

  useEffect(() => {
    setViewerNonce(0);
  }, [activeSession?.sessionId]);

  const handleReconnect = async () => {
    if (!activeDevice) {
      return;
    }

    if (activeSession) {
      await stopStream(activeSession.sessionId);
    }

    await startStream(activeDevice.id);
    setViewerNonce((current) => current + 1);
  };

  const handleStartStream = async () => {
    if (!activeDevice) {
      return;
    }

    await startStream(activeDevice.id);
  };

  const showLoadingState = loading && snapshot.devices.length === 0 && !error;

  return (
    <Tabs
      value={tabsValue}
      onValueChange={(value) => setSelectedDeviceId(value)}
      className="flex h-full min-h-0 flex-col bg-card/95"
    >
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold tracking-wide text-foreground">Devices</h2>
            <Badge variant="outline" className="rounded-full px-2">
              {snapshot.devices.length}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {selectedDeviceLabel ?? "Emulator, simulator, and attached device streams"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="Refresh devices" onClick={() => void refresh()}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Close Devices" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {snapshot.issues.length > 0 ? (
        <div className="space-y-2 border-b border-border/30 px-3 py-2">
          {snapshot.issues.map((issue) => (
            <div
              key={issue.id}
              className={cn(
                "rounded-xl border px-3 py-2 text-xs",
                issue.severity === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-border/40 bg-secondary/30 text-muted-foreground",
              )}
            >
              {issue.message}
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="border-b border-border/30 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {snapshot.devices.length > 0 ? (
        <>
          <div className="border-b border-border/30 px-2 py-2">
            <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl bg-secondary/45 p-1">
              {snapshot.devices.map((device) => (
                <TabsTrigger
                  key={device.id}
                  value={device.id}
                  className="min-w-[116px] justify-start gap-2 rounded-lg px-3 py-2 text-left data-[state=active]:bg-background"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">{device.name}</div>
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {platformLabel(device.platform)}
                    </div>
                  </div>
                  <Badge variant={getStatusVariant(device.status)} className="ml-auto shrink-0">
                    {device.status}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {activeDevice ? (
            <TabsContent value={activeDevice.id} className="mt-0 flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2 pt-2">
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-secondary/15 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{activeDevice.name}</h3>
                    <Badge variant={getStatusVariant(activeDevice.status)}>{activeDevice.status}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {platformLabel(activeDevice.platform)} · {connectionLabel(activeDevice.connectionKind)}
                  </p>
                </div>

                {activeSession && viewerSrc ? (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Reconnect stream"
                      aria-label="Reconnect stream"
                      onClick={() => void handleReconnect()}
                      disabled={!activeDevice.supportsEmbeddedStream || startingDeviceId === activeDevice.id || stoppingSessionId === activeSession.sessionId}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Open detached viewer"
                      aria-label="Open detached viewer"
                      onClick={() => void openExternalUrl(viewerSrc)}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Stop stream"
                      aria-label="Stop stream"
                      onClick={() => void stopStream(activeSession.sessionId)}
                      disabled={stoppingSessionId === activeSession.sessionId}
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </div>

              {activeDevice.lastError ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  {activeDevice.lastError}
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/40 bg-black/90">
                {activeSession && viewerSrc ? (
                  activeDevice.platform === "android" && activeDevice.serial ? (
                    <AndroidDeviceViewer
                      key={`${activeSession.sessionId}:${viewerNonce}`}
                      sessionId={activeSession.sessionId}
                      serial={activeDevice.serial}
                      deviceName={activeDevice.name}
                    />
                  ) : activeDevice.platform === "ios-simulator" ? (
                    <IosSimulatorViewer
                      key={`${activeSession.sessionId}:${viewerNonce}`}
                      sessionId={activeSession.sessionId}
                      deviceName={activeDevice.name}
                    />
                  ) : (
                    <iframe
                      key={`${activeSession.sessionId}:${viewerNonce}`}
                      title={`${activeDevice.name} viewer`}
                      src={viewerSrc}
                      className="h-full w-full border-0 bg-black"
                      allow="clipboard-read; clipboard-write; fullscreen"
                    />
                  )
                ) : (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                    <Smartphone className="mb-4 h-8 w-8 text-muted-foreground" />
                    <h3 className="text-sm font-medium text-foreground">No active stream</h3>
                    <p className="mt-2 max-w-xs text-xs leading-5 text-muted-foreground">
                      Start the viewer and focus directly on this device.
                    </p>
                    <Button
                      type="button"
                      className="mt-4"
                      onClick={() => void handleStartStream()}
                      disabled={!activeDevice.supportsEmbeddedStream || startingDeviceId === activeDevice.id}
                    >
                      <Play className="mr-1.5 h-3.5 w-3.5" />
                      {startingDeviceId === activeDevice.id ? "Starting..." : "Start Stream"}
                    </Button>
                  </div>
                )}
              </div>
            </TabsContent>
          ) : null}
        </>
      ) : showLoadingState ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <RefreshCw className="mb-4 h-9 w-9 animate-spin text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">Scanning devices…</h3>
          <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
            Looking for Android devices through adb and booted iOS simulators through simctl.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <Smartphone className="mb-4 h-9 w-9 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">No devices detected</h3>
          <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
            Connect an Android device or emulator with adb, or boot an iOS simulator so it can appear here.
          </p>
        </div>
      )}
    </Tabs>
  );
}
