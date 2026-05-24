import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodePty from "node-pty";

export interface PtyProcess {
    pid: number;
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
}

export interface PtySpawnOptions {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
}

export function isBunRuntime(): boolean {
    return typeof Bun !== "undefined";
}

type BunPtySpawn = (
    file: string,
    args: string[],
    options: PtySpawnOptions,
) => PtyProcess;

let bunPtySpawn: BunPtySpawn | null = null;
let nodeSpawnHelperPermissionsFixed = false;

/**
 * Ensure node-pty's spawn-helper binary has executable permissions.
 * Tauri's resource copying can strip the +x bit, causing posix_spawnp to fail.
 */
function fixNodePtySpawnHelperPermissions(): void {
    if (nodeSpawnHelperPermissionsFixed) {
        return;
    }

    nodeSpawnHelperPermissionsFixed = true;

    try {
        const require = createRequire(import.meta.url);
        const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
        const platform = process.platform === "darwin" ? "darwin" : process.platform;
        const arch = process.arch;
        const spawnHelper = join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper");
        if (existsSync(spawnHelper)) {
            chmodSync(spawnHelper, 0o755);
        }
    } catch {
        // Best-effort; if we can't fix it, pty.spawn will throw with a clear error
    }
}

function getBunPtySpawn(): BunPtySpawn {
    if (!bunPtySpawn) {
        const require = createRequire(import.meta.url);
        bunPtySpawn = require("bun-pty").spawn as BunPtySpawn;
    }

    return bunPtySpawn;
}

export function spawnPty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    if (isBunRuntime()) {
        return getBunPtySpawn()(file, args, options);
    }

    fixNodePtySpawnHelperPermissions();
    return nodePty.spawn(file, args, options) as PtyProcess;
}

export function isPtyIoError(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === "EBADF" || code === "EIO" || code === "EPIPE";
}
