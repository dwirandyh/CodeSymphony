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

export function spawnPty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    return spawnBunPty(file, args, options);
}

export function isPtyIoError(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === "EBADF" || code === "EIO" || code === "EPIPE";
}
