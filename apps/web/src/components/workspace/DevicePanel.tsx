import { useEffect, useMemo, useState, type ComponentProps } from "react";
import type { DeviceConnectionKind, DeviceIssue, DeviceStatus } from "@codesymphony/shared-types";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api";
import { isTauriDesktop, openExternalUrl } from "../../lib/openExternalUrl";
import { useDevices } from "../../pages/workspace/hooks/useDevices";
import { AndroidDeviceViewer } from "./AndroidDeviceViewer";
import { supportsAndroidNativeViewer } from "./deviceViewerEnvironment";
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

function connectionKindLabel(connectionKind: DeviceConnectionKind): string {
  if (connectionKind === "usb") {
    return "USB";
  }

  if (connectionKind === "wifi") {
    return "Wi-Fi";
  }

  if (connectionKind === "emulator") {
    return "Emulator";
  }

  if (connectionKind === "simulator") {
    return "Simulator";
  }

  return connectionKind === "remote" ? "Remote" : "Device";
}

function deviceStatusLabel(status: DeviceStatus): string {
  if (status === "streaming") {
    return "Live";
  }

  if (status === "available") {
    return "Ready";
  }

  if (status === "error") {
    return "Issue";
  }

  return "Idle";
}

const MACOS_SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function normalizeIssueMessage(issue: DeviceIssue): string {
  if (issue.platform === "ios-simulator" && /declined TCCs/i.test(issue.message)) {
    return "Grant Screen Recording to CodeSymphony in System Settings > Privacy & Security > Screen & System Audio Recording, then reconnect the stream.";
  }

  return issue.message
    .replace(/^Native iOS simulator streaming is unavailable:\s*/i, "")
    .replace(/^Android discovery unavailable:\s*/i, "")
    .trim();
}

function issueTone(severity: DeviceIssue["severity"]): string {
  if (severity === "error") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }

  if (severity === "warning") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-100";
  }

  return "border-sky-500/30 bg-sky-500/10 text-sky-100";
}

type DevicePanelProps = {
  onClose: () => void;
};

type DeviceActionIconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  icon: LucideIcon;
  label: string;
  iconClassName?: string;
};

function DeviceActionIconButton({
  icon: Icon,
  label,
  className,
  iconClassName,
  type = "button",
  variant = "outline",
  ...props
}: DeviceActionIconButtonProps) {
  return (
    <Button
      type={type}
      variant={variant}
      size="icon"
      aria-label={label}
      title={label}
      className={cn(
        "h-8 w-8 rounded-full",
        variant === "outline" ? "border-border/60 bg-background/80 hover:bg-secondary/45" : undefined,
        className,
      )}
      {...props}
    >
      <Icon className={cn("h-3.5 w-3.5", iconClassName)} />
    </Button>
  );
}

export function DevicePanel({ onClose }: DevicePanelProps) {
  const { snapshot, loading, error, refresh, startStream, stopStream, startingDeviceId, stoppingSessionId } = useDevices();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [deviceSelectorOpen, setDeviceSelectorOpen] = useState(false);
  const [viewerNonce, setViewerNonce] = useState(0);

  useEffect(() => {
    if (snapshot.devices.length === 0) {
      setSelectedDeviceId(null);
      setDeviceSelectorOpen(false);
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
  const activeIssues = useMemo(() => {
    if (!activeDevice) {
      return snapshot.issues;
    }

    return snapshot.issues.filter((issue) => !issue.platform || issue.platform === activeDevice.platform);
  }, [activeDevice, snapshot.issues]);
  const viewerSrc = activeSession ? `${api.runtimeBaseUrl}${activeSession.viewerUrl}` : null;
  const desktopApp = isTauriDesktop();
  const canUseAndroidNativePanelViewer = supportsAndroidNativeViewer();
  const selectorDevice = activeDevice ?? snapshot.devices[0] ?? null;

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
    <div className="flex h-full min-h-0 flex-col bg-card/95">
      <div className="border-b border-border/40 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold tracking-[0.01em] text-foreground">Devices</h2>
            <Badge variant="outline" className="rounded-full px-2">
              {snapshot.devices.length}
            </Badge>
          </div>

          <Button type="button" variant="ghost" size="icon" aria-label="Close Devices" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-2 flex min-w-0 items-center gap-2">
          {selectorDevice ? (
            <Popover open={deviceSelectorOpen} onOpenChange={setDeviceSelectorOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Choose device"
                  title="Choose device"
                  className="h-9 min-w-0 max-w-[184px] flex-1 justify-between rounded-xl border-border/60 bg-background/80 px-3 hover:bg-secondary/45"
                >
                  <div className="min-w-0 text-left">
                    <span className="block truncate text-sm font-semibold text-foreground">{selectorDevice.name}</span>
                  </div>
                  <ChevronDown className={cn("ml-3 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", deviceSelectorOpen && "rotate-180")} />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={8}
                className="w-[min(380px,calc(100vw-2rem))] rounded-2xl border-border/60 bg-popover/95 p-2 shadow-[0_20px_70px_rgba(15,23,42,0.26)]"
              >
                <div className="flex items-center justify-between gap-2 px-1 py-1.5">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      Available Devices
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Pick the target shown in this panel.
                    </div>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2">
                    {snapshot.devices.length}
                  </Badge>
                </div>
                <div className="mt-1 space-y-1">
                  {snapshot.devices.map((device) => {
                    const selected = device.id === selectedDeviceId;

                    return (
                      <button
                        key={device.id}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                          selected
                            ? "border-primary/30 bg-primary/10 shadow-sm"
                            : "border-transparent bg-background/50 hover:border-border/60 hover:bg-secondary/45",
                        )}
                        onClick={() => {
                          setSelectedDeviceId(device.id);
                          setDeviceSelectorOpen(false);
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-semibold text-foreground">{device.name}</span>
                            {selected ? (
                              <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                                Selected
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>{platformLabel(device.platform)}</span>
                            <span aria-hidden="true" className="opacity-35">•</span>
                            <span>{connectionKindLabel(device.connectionKind)}</span>
                          </div>
                        </div>
                        <Badge variant={getStatusVariant(device.status)} className="shrink-0">
                          {deviceStatusLabel(device.status)}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}

          <div className="flex shrink-0 items-center gap-1.5">
            {activeDevice && !activeSession ? (
              <DeviceActionIconButton
                icon={startingDeviceId === activeDevice.id ? RefreshCw : Play}
                label={startingDeviceId === activeDevice.id ? "Starting Stream" : "Start Stream"}
                variant="default"
                className="shadow-sm"
                iconClassName={cn(startingDeviceId === activeDevice.id && "animate-spin")}
                onClick={() => void handleStartStream()}
                disabled={!activeDevice.supportsEmbeddedStream || startingDeviceId === activeDevice.id}
              />
            ) : null}
            {activeDevice && activeSession && viewerSrc ? (
              <>
                <DeviceActionIconButton
                  icon={RotateCcw}
                  label="Reconnect Stream"
                  onClick={() => void handleReconnect()}
                  disabled={!activeDevice.supportsEmbeddedStream || startingDeviceId === activeDevice.id || stoppingSessionId === activeSession.sessionId}
                />
                {activeDevice.platform === "android" ? (
                  <DeviceActionIconButton
                    icon={ExternalLink}
                    label="Open Viewer"
                    onClick={() => void openExternalUrl(viewerSrc)}
                  />
                ) : null}
                <DeviceActionIconButton
                  icon={stoppingSessionId === activeSession.sessionId ? RefreshCw : Square}
                  label={stoppingSessionId === activeSession.sessionId ? "Stopping Stream" : "Stop Stream"}
                  className="border-destructive/30 bg-background/80 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  iconClassName={cn(stoppingSessionId === activeSession.sessionId && "animate-spin")}
                  onClick={() => void stopStream(activeSession.sessionId)}
                  disabled={stoppingSessionId === activeSession.sessionId}
                />
              </>
            ) : null}
            <DeviceActionIconButton
              icon={RefreshCw}
              label="Refresh Devices"
              onClick={() => void refresh()}
              iconClassName={cn(loading && "animate-spin")}
            />
          </div>
        </div>
      </div>

      {error ? (
        <div className="border-b border-border/30 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {activeDevice ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1.5">
            {activeIssues.length > 0 ? (
              <div className="space-y-2 px-1 pb-2">
                {activeIssues.map((issue) => {
                  const isScreenRecordingIssue = issue.platform === "ios-simulator" && /declined TCCs/i.test(issue.message);

                  return (
                    <div
                      key={issue.id}
                      className={cn(
                        "rounded-xl border px-3 py-2.5 text-[11px] leading-4 shadow-sm",
                        issueTone(issue.severity),
                      )}
                      role={issue.severity === "error" ? "alert" : undefined}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">
                            {isScreenRecordingIssue ? "Screen Recording required" : issue.severity === "error" ? "Device issue" : "Device notice"}
                          </div>
                          <p className="mt-1 break-words opacity-90">
                            {normalizeIssueMessage(issue)}
                          </p>
                        </div>
                        {desktopApp && isScreenRecordingIssue ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-[11px]"
                            onClick={() => void openExternalUrl(MACOS_SCREEN_RECORDING_SETTINGS_URL)}
                          >
                            Open Settings
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/40 bg-black/90">
              {activeSession && viewerSrc ? (
                activeDevice.platform === "android" && activeDevice.serial && canUseAndroidNativePanelViewer ? (
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
                    Use the compact controls above to start the selected device in this panel.
                  </p>
                </div>
              )}
            </div>
          </div>
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
    </div>
  );
}
