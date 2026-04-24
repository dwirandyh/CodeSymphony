import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { ExternalApp } from "@codesymphony/shared-types";

const execFile = promisify(execFileCallback);
const APP_ICON_CACHE_DIR = path.join(os.tmpdir(), "codesymphony-app-icons");

async function readHostClipboard(): Promise<string> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFile("pbpaste", [], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return stdout;
    }

    if (process.platform === "linux") {
      const { stdout } = await execFile("bash", [
        "-lc",
        "if command -v wl-paste >/dev/null 2>&1; then wl-paste --no-newline; elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard -o; elif command -v xsel >/dev/null 2>&1; then xsel --clipboard --output; else exit 127; fi",
      ], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return stdout;
    }

    if (process.platform === "win32") {
      const { stdout } = await execFile("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Clipboard -Raw",
      ], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return stdout;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read the host clipboard";
    throw new Error(`Unable to read the host clipboard: ${message}`);
  }

  throw new Error(`Reading the host clipboard is not supported on platform: ${process.platform}`);
}

async function writeHostClipboard(text: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await execFile("bash", [
        "-lc",
        "printf %s \"$1\" | pbcopy",
        "--",
        text,
      ], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return;
    }

    if (process.platform === "linux") {
      await execFile("bash", [
        "-lc",
        "if command -v wl-copy >/dev/null 2>&1; then printf %s \"$1\" | wl-copy; elif command -v xclip >/dev/null 2>&1; then printf %s \"$1\" | xclip -selection clipboard; elif command -v xsel >/dev/null 2>&1; then printf %s \"$1\" | xsel --clipboard --input; else exit 127; fi",
        "--",
        text,
      ], {
        encoding: "utf8",
        timeout: 5_000,
      });
      return;
    }

    if (process.platform === "win32") {
      await execFile("powershell", [
        "-NoProfile",
        "-Command",
        "Set-Clipboard -Value $env:CS_CLIPBOARD_TEXT",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          CS_CLIPBOARD_TEXT: text,
        },
        timeout: 5_000,
      });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to write the host clipboard";
    throw new Error(`Unable to write the host clipboard: ${message}`);
  }

  throw new Error(`Writing the host clipboard is not supported on platform: ${process.platform}`);
}

function normalizeSelectedPath(output: string): string {
  return output.trim().replace(/\/$/, "");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBundleIconPath(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const { stdout } = await execFile(
    "plutil",
    ["-extract", "CFBundleIconFile", "raw", "-o", "-", plistPath],
    { encoding: "utf8", timeout: 5_000 },
  );

  const iconFile = stdout.trim();
  if (!iconFile) {
    throw new Error("App bundle does not declare an icon");
  }

  const iconFileName = path.extname(iconFile) ? iconFile : `${iconFile}.icns`;
  const iconPath = path.join(appPath, "Contents", "Resources", iconFileName);

  if (!(await pathExists(iconPath))) {
    throw new Error(`App icon file not found: ${iconFileName}`);
  }

  return iconPath;
}

async function resolveCachedPngPath(iconPath: string): Promise<string> {
  await mkdir(APP_ICON_CACHE_DIR, { recursive: true });

  const iconStat = await stat(iconPath);
  const cacheKey = createHash("sha1")
    .update(`${iconPath}:${iconStat.mtimeMs}`)
    .digest("hex");
  const outputPath = path.join(APP_ICON_CACHE_DIR, `${cacheKey}.png`);

  if (!(await pathExists(outputPath))) {
    await execFile("sips", ["-s", "format", "png", iconPath, "--out", outputPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  return outputPath;
}

const KNOWN_APPS = [
  // Editors / IDEs
  { id: "vscode", name: "Visual Studio Code", bundleId: "com.microsoft.VSCode" },
  { id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92" },
  { id: "zed", name: "Zed", bundleId: "dev.zed.Zed" },
  { id: "android-studio", name: "Android Studio", bundleId: "com.google.android.studio" },
  { id: "intellij", name: "IntelliJ IDEA", bundleId: "com.jetbrains.intellij" },
  { id: "webstorm", name: "WebStorm", bundleId: "com.jetbrains.WebStorm" },
  { id: "sublime", name: "Sublime Text", bundleId: "com.sublimetext.4" },
  { id: "xcode", name: "Xcode", bundleId: "com.apple.dt.Xcode" },
  { id: "fleet", name: "Fleet", bundleId: "fleet.backend" },
  { id: "nova", name: "Nova", bundleId: "com.panic.Nova" },
  // Terminals
  { id: "terminal", name: "Terminal", bundleId: "com.apple.Terminal" },
  { id: "iterm", name: "iTerm2", bundleId: "com.googlecode.iterm2" },
  { id: "warp", name: "Warp", bundleId: "dev.warp.Warp-Stable" },
  { id: "ghostty", name: "Ghostty", bundleId: "com.mitchellh.ghostty" },
];

const MACOS_SYSTEM_APPS: ExternalApp[] = [
  {
    id: "finder",
    name: "Finder",
    bundleId: "com.apple.finder",
    path: "/System/Library/CoreServices/Finder.app",
  },
];

export function createSystemService() {
  let cachedApps: ExternalApp[] | null = null;
  let cacheTimestamp = 0;
  const CACHE_TTL = 60_000; // 60 seconds

  async function openFileDefaultApp(targetPath: string): Promise<void> {
    const trimmedPath = targetPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error("File path is required");
    }

    try {
      if (process.platform === "darwin") {
        await execFile("open", [trimmedPath], { encoding: "utf8" });
        return;
      }

      if (process.platform === "linux") {
        await execFile("xdg-open", [trimmedPath], { encoding: "utf8" });
        return;
      }

      if (process.platform === "win32") {
        await execFile("cmd", ["/c", "start", "", trimmedPath], { encoding: "utf8" });
        return;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error("No default file opener command found on this system");
      }

      const message = error instanceof Error ? error.message : "Unable to open file";
      throw new Error(`Unable to open file with default app: ${message}`);
    }

    throw new Error(`Opening files is not supported on platform: ${process.platform}`);
  }

  async function getInstalledApps(): Promise<ExternalApp[]> {
    if (process.platform !== "darwin") {
      return [];
    }

    const now = Date.now();
    if (cachedApps && now - cacheTimestamp < CACHE_TTL) {
      return cachedApps;
    }

    const results: ExternalApp[] = [...MACOS_SYSTEM_APPS];

    await Promise.allSettled(
      KNOWN_APPS.map(async (app) => {
        try {
          const { stdout } = await execFile("mdfind", [
            `kMDItemCFBundleIdentifier == '${app.bundleId}'`,
          ], { encoding: "utf8", timeout: 5_000 });

          const appPath = stdout.trim().split("\n")[0];
          if (appPath) {
            results.push({
              id: app.id,
              name: app.name,
              bundleId: app.bundleId,
              path: appPath,
            });
          }
        } catch {
          // mdfind failed or timed out — skip this app
        }
      }),
    );

    const apps = results
      .map((app) => ({
        ...app,
        iconUrl: `/api/system/installed-apps/${app.id}/icon`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    cachedApps = apps;
    cacheTimestamp = Date.now();

    return apps;
  }

  async function getAppIcon(appPath: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (process.platform !== "darwin") {
      throw new Error("App icons are currently supported on macOS only");
    }

    const iconPath = await resolveBundleIconPath(appPath);
    const pngPath = await resolveCachedPngPath(iconPath);
    const buffer = await readFile(pngPath);

    return {
      buffer,
      contentType: "image/png",
    };
  }

  async function openInApp(appName: string, targetPath: string): Promise<void> {
    const trimmedPath = targetPath.trim();
    if (trimmedPath.length === 0) {
      throw new Error("Target path is required");
    }

    if (process.platform !== "darwin") {
      throw new Error("Opening in app is currently supported on macOS only");
    }

    try {
      await execFile("open", ["-a", appName, trimmedPath], {
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open in app";
      throw new Error(`Failed to open in ${appName}: ${message}`);
    }
  }

  return {
    async pickDirectory(): Promise<{ path: string }> {
      if (process.platform !== "darwin") {
        throw new Error("Directory picker is currently supported on macOS runtime only");
      }

      const script = 'POSIX path of (choose folder with prompt "Select repository directory")';
      const { stdout } = await execFile("osascript", ["-e", script], {
        encoding: "utf8",
      });

      const selectedPath = normalizeSelectedPath(stdout);
      if (!selectedPath) {
        throw new Error("No directory selected");
      }

      return { path: selectedPath };
    },
    openFileDefaultApp,
    getInstalledApps,
    getAppIcon,
    openInApp,
    readClipboard: readHostClipboard,
    writeClipboard: writeHostClipboard,
  };
}
