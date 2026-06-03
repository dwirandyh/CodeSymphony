import { app, BrowserWindow, Notification, ipcMain, shell } from "electron";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DESKTOP_DEV_RUNTIME_PORT = 4321;
const DESKTOP_PROD_RUNTIME_PORT = 4322;
const DESKTOP_WEB_DEV_PORT = 5174;
const LOCALHOST_RUNTIME_HOST = "127.0.0.1";
const DUAL_STACK_RUNTIME_HOST = "::";
const COMMON_RUNTIME_EXECUTABLE_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const USER_RUNTIME_EXECUTABLE_DIR_SUFFIXES = [".bun/bin", ".opencode/bin", ".local/bin"];
const RUNTIME_STDOUT_LOG_MAX_BYTES = 16 * 1024 * 1024;
const RUNTIME_STDERR_LOG_MAX_BYTES = 4 * 1024 * 1024;
const DESKTOP_WINDOW_MIN_WIDTH = 1100;
const DESKTOP_WINDOW_MIN_HEIGHT = 700;
const MACOS_NOTIFICATION_SETTINGS_URLS = [
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.codesymphony.app",
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
];

let mainWindow = null;
let runtimeProcess = null;
let webDevProcess = null;
let shuttingDown = false;

function desktopRuntimeHost(isDev) {
  return isDev ? LOCALHOST_RUNTIME_HOST : DUAL_STACK_RUNTIME_HOST;
}

function workspaceRoot() {
  return path.resolve(__dirname, "../../..");
}

function runtimePort() {
  return app.isPackaged ? DESKTOP_PROD_RUNTIME_PORT : DESKTOP_DEV_RUNTIME_PORT;
}

function runtimeApiBase(port = runtimePort()) {
  return `http://${LOCALHOST_RUNTIME_HOST}:${port}/api`;
}

function runtimeUrl(port = runtimePort()) {
  return `http://${LOCALHOST_RUNTIME_HOST}:${port}`;
}

function webDevUrl() {
  return `http://${LOCALHOST_RUNTIME_HOST}:${DESKTOP_WEB_DEV_PORT}`;
}

function resourceDir() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname);
}

function runtimeBundleDir() {
  return app.isPackaged
    ? path.join(resourceDir(), "runtime-bundle")
    : path.join(__dirname, "runtime-bundle");
}

function runtimeExecutableDirs(homeDir = os.homedir()) {
  const dirs = [];
  for (const candidate of COMMON_RUNTIME_EXECUTABLE_DIRS) {
    if (existsSync(candidate)) dirs.push(candidate);
  }
  if (homeDir) {
    for (const suffix of USER_RUNTIME_EXECUTABLE_DIR_SUFFIXES) {
      const candidate = path.join(homeDir, suffix);
      if (existsSync(candidate)) dirs.push(candidate);
    }
  }
  return Array.from(new Set(dirs));
}

function buildRuntimePathEnv() {
  const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return Array.from(new Set([...existing, ...runtimeExecutableDirs()])).join(path.delimiter);
}

function resolveCommonBinary(binaryName) {
  for (const dir of runtimeExecutableDirs()) {
    const candidate = path.join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findBunCandidate(dir) {
  if (!existsSync(dir)) return null;
  const exact = path.join(dir, "bun");
  if (existsSync(exact)) return exact;
  const candidates = spawnSync("find", [dir, "-maxdepth", "1", "-type", "f", "-name", "bun-*"], {
    encoding: "utf8",
  }).stdout.trim().split("\n").filter(Boolean).sort();
  return candidates[0] ?? null;
}

function resolveBundledBunBinary() {
  const dirs = [
    path.join(resourceDir(), "binaries"),
    resourceDir(),
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), "binaries"),
  ];
  for (const dir of dirs) {
    const candidate = findBunCandidate(dir);
    if (candidate) return candidate;
  }
  return null;
}

function prismaEngineSuffix() {
  return process.arch === "arm64" ? "darwin-arm64" : "darwin";
}

function prismaQueryEngineLibraryName() {
  return `libquery_engine-${prismaEngineSuffix()}.dylib.node`;
}

function preparePrismaQueryEngine() {
  const source = path.join(
    runtimeBundleDir(),
    "node_modules",
    ".prisma",
    "client",
    prismaQueryEngineLibraryName(),
  );
  const targetDir = path.join(app.getPath("userData"), "prisma-engines");
  const target = path.join(targetDir, prismaQueryEngineLibraryName());
  if (!existsSync(source)) throw new Error(`Bundled Prisma engine not found: ${source}`);
  mkdirSync(targetDir, { recursive: true });
  const shouldCopy = !existsSync(target) || statSync(source).size !== statSync(target).size;
  if (shouldCopy) copyFileSync(source, target);
  return target;
}

function runtimeStdoutLogPath() {
  return path.join(app.getPath("userData"), "runtime.stdout.log");
}

function runtimeStderrLogPath() {
  return path.join(app.getPath("userData"), "runtime.stderr.log");
}

function truncateLogIfOversized(filePath, maxBytes) {
  if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
    writeFileSync(filePath, "");
  }
}

function stdioLogStreams() {
  const stdoutPath = runtimeStdoutLogPath();
  const stderrPath = runtimeStderrLogPath();
  truncateLogIfOversized(stdoutPath, RUNTIME_STDOUT_LOG_MAX_BYTES);
  truncateLogIfOversized(stderrPath, RUNTIME_STDERR_LOG_MAX_BYTES);
  return ["ignore", "pipe", "pipe", "pipe"];
}

async function appendRuntimeOutput(stream, filePath) {
  stream?.on("data", (chunk) => {
    void appendFile(filePath, chunk).catch(() => {});
  });
}

async function readRuntimeHealth(port) {
  try {
    const response = await fetch(`${runtimeUrl(port)}/health`, { signal: AbortSignal.timeout(750) });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

async function isCodesymphonyRuntimeAvailable(port) {
  return (await readRuntimeHealth(port)) === "{\"ok\":true}";
}

async function waitForUrl(url, timeoutMs = 45_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function desktopDevRuntimeDbPath() {
  return path.join(workspaceRoot(), "apps", "runtime", "prisma", "desktop.dev.db");
}

function ensureRuntimeDevDatabase(databasePath) {
  const runtimeDir = path.join(workspaceRoot(), "apps", "runtime");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const bun = resolveCommonBinary("bun") ?? "bun";
  const status = spawnSync(bun, ["x", "prisma", "migrate", "deploy"], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      DATABASE_URL: `file:${databasePath}`,
      PATH: buildRuntimePathEnv(),
    },
    stdio: "inherit",
  });
  if (status.status !== 0) throw new Error(`Failed to migrate desktop dev DB: ${databasePath}`);
}

function spawnRuntimeDev(port) {
  const databasePath = desktopDevRuntimeDbPath();
  ensureRuntimeDevDatabase(databasePath);

  const env = {
    ...process.env,
    DATABASE_URL: `file:${databasePath}`,
    RUNTIME_HOST: desktopRuntimeHost(true),
    RUNTIME_PORT: String(port),
    CODESYMPHONY_DEBUG_LOG_PATH: path.join(workspaceRoot(), "apps", "runtime", "debug.log"),
    PATH: buildRuntimePathEnv(),
  };
  for (const [envName, binaryName] of [
    ["CODEX_BINARY_PATH", "codex"],
    ["OPENCODE_BINARY_PATH", "opencode"],
  ]) {
    const binary = resolveCommonBinary(binaryName);
    if (binary) env[envName] = binary;
  }
  if (process.env.CODESYMPHONY_STARTUP_READY_DELAY_MS) {
    env.CODESYMPHONY_STARTUP_READY_DELAY_MS = process.env.CODESYMPHONY_STARTUP_READY_DELAY_MS;
  }

  return spawn("bash", ["apps/desktop/scripts/start-runtime-dev.sh"], {
    cwd: workspaceRoot(),
    env,
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
}

function spawnWebDevServer() {
  return spawn("bash", ["scripts/start-web-dev.sh"], {
    cwd: path.join(workspaceRoot(), "apps", "desktop"),
    env: { ...process.env, PATH: buildRuntimePathEnv() },
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
}

function spawnRuntimeProd(port) {
  const bun = resolveBundledBunBinary();
  if (!bun) throw new Error(`Failed to locate bundled Bun binary in ${resourceDir()}`);

  const bundleDir = runtimeBundleDir();
  const runtimeEntry = path.join(bundleDir, "dist", "index.js");
  const prismaDir = path.join(bundleDir, "prisma");
  if (!existsSync(runtimeEntry)) throw new Error(`Runtime entry not found: ${runtimeEntry}`);

  mkdirSync(app.getPath("userData"), { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: `file:${path.join(app.getPath("userData"), "codesymphony.db")}`,
    PRISMA_QUERY_ENGINE_LIBRARY: preparePrismaQueryEngine(),
    PRISMA_TEMPLATE_DB_PATH: path.join(prismaDir, "template.db"),
    RUNTIME_HOST: desktopRuntimeHost(false),
    RUNTIME_PORT: String(port),
    CODESYMPHONY_DEBUG_LOG_PATH: path.join(app.getPath("userData"), "debug.log"),
    CODESYMPHONY_TERMINAL_ZDOTDIR: path.join(app.getPath("userData"), "terminal-zsh"),
    CODESYMPHONY_TERMINAL_ZSHRC_TEMPLATE: path.join(bundleDir, "terminal-zsh", ".zshrc"),
    WEB_DIST_PATH: path.join(bundleDir, "web-dist"),
    PATH: buildRuntimePathEnv(),
  };
  for (const [envName, binaryName] of [
    ["CLAUDE_CODE_EXECUTABLE", "claude"],
    ["CODEX_BINARY_PATH", "codex"],
    ["OPENCODE_BINARY_PATH", "opencode"],
  ]) {
    const binary = resolveCommonBinary(binaryName);
    if (binary) env[envName] = binary;
  }
  if (process.env.CODESYMPHONY_STARTUP_READY_DELAY_MS) {
    env.CODESYMPHONY_STARTUP_READY_DELAY_MS = process.env.CODESYMPHONY_STARTUP_READY_DELAY_MS;
  }

  const child = spawn(bun, ["run", runtimeEntry], {
    cwd: bundleDir,
    env,
    detached: process.platform !== "win32",
    stdio: stdioLogStreams(),
  });
  void appendRuntimeOutput(child.stdout, runtimeStdoutLogPath());
  void appendRuntimeOutput(child.stderr, runtimeStderrLogPath());
  return child;
}

async function ensureManagedRuntime(port) {
  if (runtimeProcess && runtimeProcess.exitCode == null) return true;
  runtimeProcess = null;
  if (await isCodesymphonyRuntimeAvailable(port)) return true;
  runtimeProcess = app.isPackaged ? spawnRuntimeProd(port) : spawnRuntimeDev(port);
  return true;
}

function killProcessTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 500);
    return;
  }
  child.kill();
}

function stopManagedProcesses() {
  killProcessTree(runtimeProcess);
  killProcessTree(webDevProcess);
  runtimeProcess = null;
  webDevProcess = null;
}

function preloadArgs(port) {
  const args = [
    `--codesymphony-runtime-port=${port}`,
    `--codesymphony-runtime-api-base=${runtimeApiBase(port)}`,
  ];

  const scenario = process.env.CODESYMPHONY_STARTUP_SCENARIO?.trim();
  if (["cold-empty", "warm-persisted", "warm-runtime-delayed"].includes(scenario)) {
    args.push(`--codesymphony-startup-scenario=${scenario}`);
  }
  const persistedState = process.env.CODESYMPHONY_STARTUP_PERSISTED_STATE?.trim().toLowerCase();
  if (["true", "false", "1", "0"].includes(persistedState)) {
    args.push(`--codesymphony-startup-persisted-state=${persistedState === "true" || persistedState === "1"}`);
  }
  const snapshotJson = process.env.CODESYMPHONY_STARTUP_SHELL_SNAPSHOT_JSON?.trim();
  if (snapshotJson) args.push(`--codesymphony-startup-shell-snapshot-json=${snapshotJson}`);
  return args;
}

function notifyWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("window:state-changed", {
    fullscreen: mainWindow.isFullScreen(),
    maximized: mainWindow.isMaximized(),
  });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    title: "CodeSymphony",
    width: 1280,
    height: 820,
    minWidth: DESKTOP_WINDOW_MIN_WIDTH,
    minHeight: DESKTOP_WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: "#191d24",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: preloadArgs(port),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !shuttingDown) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  for (const eventName of ["resize", "move", "enter-full-screen", "leave-full-screen", "focus", "maximize", "unmaximize"]) {
    mainWindow.on(eventName, notifyWindowState);
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowedOrigin = app.isPackaged ? runtimeUrl(port) : webDevUrl();
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  return mainWindow;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function listDesktopProcesses() {
  if (process.platform === "win32") return [];
  const output = spawnSync("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,comm="], { encoding: "utf8" });
  if (output.status !== 0) return [];
  return output.stdout.split("\n").map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) return null;
    return {
      pid: Number.parseInt(parts[0], 10),
      ppid: Number.parseInt(parts[1], 10),
      cpu: normalizeNumber(parts[2]),
      memory: normalizeNumber(parts[3]) * 1024,
      command: parts.slice(4).join(" "),
    };
  }).filter((processInfo) => processInfo && Number.isInteger(processInfo.pid) && Number.isInteger(processInfo.ppid));
}

function processSnapshot() {
  const byPid = new Map();
  const childrenOf = new Map();
  for (const processInfo of listDesktopProcesses()) {
    byPid.set(processInfo.pid, processInfo);
    const children = childrenOf.get(processInfo.ppid) ?? [];
    children.push(processInfo.pid);
    childrenOf.set(processInfo.ppid, children);
  }
  return { byPid, childrenOf };
}

function subtreePids(snapshot, rootPid) {
  const result = new Set();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (result.has(pid)) continue;
    result.add(pid);
    for (const child of snapshot.childrenOf.get(pid) ?? []) stack.push(child);
  }
  return new Set([...result].filter((pid) => snapshot.byPid.has(pid)));
}

function sumUsage(snapshot, pids) {
  let cpu = 0;
  let memory = 0;
  for (const pid of pids) {
    const processInfo = snapshot.byPid.get(pid);
    if (!processInfo) continue;
    cpu += processInfo.cpu;
    memory += processInfo.memory;
  }
  return { cpu: normalizeNumber(cpu), memory: normalizeNumber(memory) };
}

function isWebviewProcess(command) {
  const normalized = command.toLowerCase();
  return normalized.includes("electron helper")
    || normalized.includes("chromium")
    || normalized.includes("webkit")
    || normalized.includes("webcontent")
    || normalized.includes("networkprocess")
    || normalized.includes("gpuprocess");
}

function collectResourceMonitorDesktopMetrics(runtimePid) {
  const snapshot = processSnapshot();
  const appPid = process.pid;
  const appSubtree = subtreePids(snapshot, appPid);
  const runtimeSubtree = Number.isInteger(runtimePid) && runtimePid > 0
    ? subtreePids(snapshot, runtimePid)
    : new Set(runtimeProcess?.pid ? [runtimeProcess.pid, ...subtreePids(snapshot, runtimeProcess.pid)] : []);
  const shellPids = snapshot.byPid.has(appPid) ? new Set([appPid]) : new Set();
  const webviewPids = new Set();
  const otherPids = new Set();

  for (const pid of new Set([...appSubtree, ...runtimeSubtree])) {
    if (pid === appPid || runtimeSubtree.has(pid)) continue;
    const processInfo = snapshot.byPid.get(pid);
    if (!processInfo) continue;
    if (isWebviewProcess(processInfo.command)) webviewPids.add(pid);
    else otherPids.add(pid);
  }

  return {
    shell: sumUsage(snapshot, shellPids),
    webview: sumUsage(snapshot, webviewPids),
    runtime: sumUsage(snapshot, runtimeSubtree),
    other: sumUsage(snapshot, otherPids),
  };
}

function registerIpcHandlers() {
  ipcMain.handle("desktop:open-external", async (_event, href) => shell.openExternal(String(href)));
  ipcMain.handle("desktop:send-notification", async (_event, payload) => {
    if (!Notification.isSupported()) return false;
    new Notification({ title: String(payload?.title ?? "CodeSymphony"), body: String(payload?.body ?? "") }).show();
    return true;
  });
  ipcMain.handle("desktop:open-notification-settings", async () => {
    for (const url of MACOS_NOTIFICATION_SETTINGS_URLS) {
      try {
        await shell.openExternal(url);
        return true;
      } catch {}
    }
    return false;
  });
  ipcMain.handle("desktop:collect-resource-monitor", (_event, runtimePid) => {
    return collectResourceMonitorDesktopMetrics(Number.isInteger(runtimePid) ? runtimePid : null);
  });
  ipcMain.handle("window:is-fullscreen", () => mainWindow?.isFullScreen() ?? false);
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    notifyWindowState();
    return true;
  });
}

async function startApp() {
  const port = runtimePort();
  await ensureManagedRuntime(port);
  if (!app.isPackaged) {
    webDevProcess = spawnWebDevServer();
    await Promise.all([
      waitForUrl(`${runtimeUrl(port)}/health`),
      waitForUrl(webDevUrl()),
    ]);
  } else {
    await waitForUrl(`${runtimeUrl(port)}/health`);
  }

  const window = createMainWindow(port);
  await window.loadURL(app.isPackaged ? runtimeUrl(port) : webDevUrl());
}

app.setName("CodeSymphony");
if (process.platform === "darwin") app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

registerIpcHandlers();

app.whenReady().then(startApp).catch((error) => {
  console.error("Failed to start CodeSymphony desktop shell.", error);
  app.quit();
});

app.on("activate", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  shuttingDown = true;
  stopManagedProcesses();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
