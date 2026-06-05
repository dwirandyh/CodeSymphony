const { contextBridge, ipcRenderer, webUtils } = require("electron");

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((candidate) => candidate.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const runtimePort = Number.parseInt(readArg("codesymphony-runtime-port") ?? "", 10);
const runtimeApiBase = readArg("codesymphony-runtime-api-base") ?? null;
const startupScenario = readArg("codesymphony-startup-scenario") ?? null;
const persistedState = readArg("codesymphony-startup-persisted-state") ?? null;
const startupSnapshotJson = readArg("codesymphony-startup-shell-snapshot-json") ?? null;

if (Number.isInteger(runtimePort) && runtimePort > 0) {
  contextBridge.exposeInMainWorld("__CS_RUNTIME_PORT", runtimePort);
}

if (runtimeApiBase) {
  contextBridge.exposeInMainWorld("__CS_RUNTIME_API_BASE", runtimeApiBase);
}

contextBridge.exposeInMainWorld("__CS_DESKTOP", true);
contextBridge.exposeInMainWorld("__CS_DESKTOP__", true);
contextBridge.exposeInMainWorld("__CS_ELECTRON", true);
contextBridge.exposeInMainWorld("__CS_ELECTRON__", true);

if (startupScenario) {
  contextBridge.exposeInMainWorld("__CS_STARTUP_SCENARIO_OVERRIDE__", startupScenario);
  window.addEventListener("DOMContentLoaded", () => {
    window.localStorage.setItem("codesymphony.startupPerf.scenario", startupScenario);
  }, { once: true });
}

if (persistedState === "true" || persistedState === "false") {
  const value = persistedState === "true";
  contextBridge.exposeInMainWorld("__CS_STARTUP_PERSISTED_STATE_OVERRIDE__", value);
  if (!value) {
    contextBridge.exposeInMainWorld("__CS_STARTUP_IGNORE_STORED_SNAPSHOT__", true);
    contextBridge.exposeInMainWorld("__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__", null);
  }
  window.addEventListener("DOMContentLoaded", () => {
    window.localStorage.setItem("codesymphony.startupPerf.persistedState", persistedState);
    if (!value) {
      window.localStorage.removeItem("codesymphony:workspace:startup-shell:v1");
    }
  }, { once: true });
}

if (startupSnapshotJson) {
  contextBridge.exposeInMainWorld("__CS_STARTUP_SHELL_SNAPSHOT_OVERRIDE__", startupSnapshotJson);
  window.addEventListener("DOMContentLoaded", () => {
    window.localStorage.setItem("codesymphony:workspace:startup-shell:v1", startupSnapshotJson);
  }, { once: true });
}

contextBridge.exposeInMainWorld("__CS_ELECTRON_BRIDGE__", {
  collectResourceMonitorDesktopMetrics(runtimePid) {
    return ipcRenderer.invoke("desktop:collect-resource-monitor", runtimePid ?? null);
  },
  getFilePaths(files) {
    return Array.from(files ?? [])
      .map((file) => webUtils.getPathForFile(file))
      .filter((filePath) => typeof filePath === "string" && filePath.length > 0);
  },
  isFullscreen() {
    return ipcRenderer.invoke("window:is-fullscreen");
  },
  onWindowStateChanged(handler) {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("window:state-changed", listener);
    return () => ipcRenderer.removeListener("window:state-changed", listener);
  },
  openExternalUrl(href) {
    return ipcRenderer.invoke("desktop:open-external", href);
  },
  openNativeNotificationSettings() {
    return ipcRenderer.invoke("desktop:open-notification-settings");
  },
  sendNativeDesktopNotification(payload) {
    return ipcRenderer.invoke("desktop:send-notification", payload);
  },
  startDragging() {
    return Promise.resolve();
  },
  toggleMaximize() {
    return ipcRenderer.invoke("window:toggle-maximize");
  },
});
