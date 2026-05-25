import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as nodePty from "node-pty";

interface BunTerminalHandle {
    write(data: string): void;
    resize?(cols: number, rows: number): void;
}

interface BunSubprocess {
    pid: number;
    terminal?: BunTerminalHandle;
    signalCode?: string | number | null;
    exited: Promise<number>;
    kill(signal?: string): void;
}

type BunSpawn = (
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string>;
        terminal: {
            cols: number;
            rows: number;
            data: (terminal: unknown, data: Uint8Array) => void;
        };
    },
) => BunSubprocess;

function getBunSpawn(): BunSpawn {
    const bun = (globalThis as { Bun?: { spawn: BunSpawn } }).Bun;
    if (!bun) {
        throw new Error("Bun runtime is unavailable");
    }
    return bun.spawn.bind(bun);
}

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

let nodeSpawnHelperPermissionsFixed = false;
const require = createRequire(import.meta.url);

function isBunRuntime(): boolean {
    return "Bun" in globalThis;
}

class BunPtyProcess implements PtyProcess {
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    private readonly decoder = new TextDecoder();
    private didExit = false;

    constructor(private readonly process: BunSubprocess) {
        void this.process.exited
            .then((exitCode: number) => {
                this.emitExit({
                    exitCode: Number.isInteger(exitCode) ? exitCode : 0,
                    signal: typeof this.process.signalCode === "number" ? this.process.signalCode : 0,
                });
            })
            .catch(() => {
                this.emitExit({ exitCode: 1, signal: 0 });
            });
    }

    get pid(): number {
        return this.process.pid;
    }

    write(data: string): void {
        if (!this.process.terminal) {
            throw new Error("Bun PTY terminal handle is unavailable");
        }
        this.process.terminal.write(data);
    }

    resize(cols: number, rows: number): void {
        if (!this.process.terminal?.resize) {
            throw new Error("Bun PTY resize is unavailable");
        }
        this.process.terminal.resize(cols, rows);
    }

    kill(signal?: string): void {
        if (!signal) {
            this.process.kill();
            return;
        }
        this.process.kill(signal as NodeJS.Signals);
    }

    onData(callback: (data: string) => void): void {
        this.dataListeners.add(callback);
    }

    onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
        this.exitListeners.add(callback);
    }

    emitData(data: Uint8Array): void {
        if (this.didExit) {
            return;
        }

        const text = this.decoder.decode(data, { stream: true });
        if (text.length === 0) {
            return;
        }

        for (const callback of this.dataListeners) {
            callback(text);
        }
    }

    private emitExit(event: { exitCode: number; signal?: number }): void {
        if (this.didExit) {
            return;
        }
        this.didExit = true;

        const remainder = this.decoder.decode();
        if (remainder.length > 0) {
            for (const callback of this.dataListeners) {
                callback(remainder);
            }
        }

        for (const callback of this.exitListeners) {
            callback(event);
        }
    }
}

function spawnBunPty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    if (process.platform === "win32") {
        throw new Error("Bun PTY terminal support is unavailable on Windows");
    }

    let processHandle: BunPtyProcess | null = null;
    const subprocess = getBunSpawn()([file, ...args], {
        cwd: options.cwd,
        env: options.env,
        terminal: {
            cols: options.cols,
            rows: options.rows,
            data(_terminal, data) {
                processHandle?.emitData(data);
            },
        },
    });
    processHandle = new BunPtyProcess(subprocess);
    return processHandle;
}

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
        const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
        const platform = process.platform === "darwin" ? "darwin" : process.platform;
        const arch = process.arch;
        const candidates = [
            join(nodePtyRoot, "build", "Release", "spawn-helper"),
            join(nodePtyRoot, "build", "Debug", "spawn-helper"),
            join(nodePtyRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
        ];

        for (const spawnHelper of candidates) {
            if (existsSync(spawnHelper)) {
                chmodSync(spawnHelper, 0o755);
                return;
            }
        }
    } catch {
        // Best-effort; if we can't fix it, pty.spawn will throw with a clear error
    }
}

function spawnNodePty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    fixNodePtySpawnHelperPermissions();
    const name = process.platform === "win32" ? "xterm-color" : options.name;
    return nodePty.spawn(file, args, {
        ...options,
        name,
    }) as PtyProcess;
}

export function spawnPty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    if (isBunRuntime()) {
        return spawnBunPty(file, args, options);
    }

    return spawnNodePty(file, args, options);
}

export function isPtyIoError(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === "EBADF" || code === "EIO" || code === "EPIPE";
}
