import { type ChildProcessWithoutNullStreams, spawn as spawnChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

type HostOutboundMessage =
    | { type: "ready" }
    | { type: "spawned"; id: string; pid: number }
    | { type: "error"; id: string; message: string }
    | { type: "data"; id: string; data: string }
    | { type: "exit"; id: string; exitCode: number; signal: number };

/**
 * Bun's built-in PTY (`Bun.spawn({ terminal })`) stalls full-screen TUI apps
 * such as opencode/opentui. node-pty renders them correctly but cannot be
 * loaded inside Bun (`posix_spawnp failed`). To get the best of both, the PTY
 * work is delegated to a small Node sidecar (`ptyHost.mjs`) that the Bun
 * runtime drives over stdin/stdout with newline-delimited JSON. Raw PTY bytes
 * are base64-encoded on the wire to stay newline-safe.
 */
class PtyHost {
    private child: ChildProcessWithoutNullStreams | null = null;
    private stdoutBuffer = "";
    private nextId = 0;
    private readonly sessions = new Map<string, HostPtyProcess>();
    private readonly pendingSpawns = new Map<string, HostPtyProcess>();

    private ensureChild(): ChildProcessWithoutNullStreams {
        if (this.child && !this.child.killed) {
            return this.child;
        }

        const hostScript = resolveHostScript();
        const nodeExecutable = resolveNodeExecutable();
        const child = spawnChildProcess(nodeExecutable, [hostScript], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                // Electron's bundled binary runs as Node when this is set, so a
                // packaged app does not need a separate Node binary on PATH.
                ELECTRON_RUN_AS_NODE: "1",
            },
        }) as ChildProcessWithoutNullStreams;

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            console.warn(`[pty-host] ${chunk.toString().trimEnd()}`);
        });
        child.on("exit", () => this.handleHostExit());

        this.child = child;
        return child;
    }

    private handleHostExit(): void {
        const affected = [...this.sessions.values(), ...this.pendingSpawns.values()];
        this.sessions.clear();
        this.pendingSpawns.clear();
        this.child = null;
        this.stdoutBuffer = "";
        for (const session of affected) {
            session.emitExit({ exitCode: 1, signal: 0 });
        }
    }

    private handleStdout(chunk: string): void {
        this.stdoutBuffer += chunk;
        let newlineIndex = this.stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
            const line = this.stdoutBuffer.slice(0, newlineIndex);
            this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
            if (line.trim().length > 0) {
                this.dispatch(line);
            }
            newlineIndex = this.stdoutBuffer.indexOf("\n");
        }
    }

    private dispatch(line: string): void {
        let message: HostOutboundMessage;
        try {
            message = JSON.parse(line) as HostOutboundMessage;
        } catch {
            return;
        }

        switch (message.type) {
            case "ready":
                return;
            case "spawned": {
                const session = this.pendingSpawns.get(message.id);
                if (session) {
                    this.pendingSpawns.delete(message.id);
                    this.sessions.set(message.id, session);
                    session.setPid(message.pid);
                }
                return;
            }
            case "error": {
                const session = this.pendingSpawns.get(message.id) ?? this.sessions.get(message.id);
                this.pendingSpawns.delete(message.id);
                this.sessions.delete(message.id);
                session?.emitExit({ exitCode: 1, signal: 0 });
                console.warn(`[pty-host] spawn error: ${message.message}`);
                return;
            }
            case "data": {
                const session = this.sessions.get(message.id);
                session?.emitData(Buffer.from(message.data, "base64"));
                return;
            }
            case "exit": {
                const session = this.sessions.get(message.id);
                this.sessions.delete(message.id);
                session?.emitExit({ exitCode: message.exitCode, signal: message.signal });
                return;
            }
        }
    }

    private writeCommand(command: Record<string, unknown>): void {
        const child = this.child;
        if (!child || child.killed) {
            return;
        }
        child.stdin.write(`${JSON.stringify(command)}\n`);
    }

    spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess {
        this.ensureChild();
        const id = `pty-${this.nextId++}`;
        const session = new HostPtyProcess(id, this);
        this.pendingSpawns.set(id, session);
        this.writeCommand({
            type: "spawn",
            id,
            file,
            args,
            name: options.name,
            cols: options.cols,
            rows: options.rows,
            cwd: options.cwd,
            env: options.env,
        });
        return session;
    }

    write(id: string, data: string): void {
        this.writeCommand({ type: "write", id, data: Buffer.from(data, "utf8").toString("base64") });
    }

    resize(id: string, cols: number, rows: number): void {
        this.writeCommand({ type: "resize", id, cols, rows });
    }

    kill(id: string, signal?: string): void {
        this.writeCommand({ type: "kill", id, signal });
    }
}

class HostPtyProcess implements PtyProcess {
    private readonly dataListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    private readonly decoder = new TextDecoder();
    private resolvedPid = -1;
    private didExit = false;

    constructor(private readonly id: string, private readonly host: PtyHost) {}

    get pid(): number {
        return this.resolvedPid;
    }

    setPid(pid: number): void {
        this.resolvedPid = pid;
    }

    write(data: string): void {
        this.host.write(this.id, data);
    }

    resize(cols: number, rows: number): void {
        this.host.resize(this.id, cols, rows);
    }

    kill(signal?: string): void {
        this.host.kill(this.id, signal);
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

    emitExit(event: { exitCode: number; signal?: number }): void {
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

function resolveHostScript(): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDir, "ptyHost.mjs"),
        join(moduleDir, "../../src/services/ptyHost.mjs"),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

function resolveNodeExecutable(): string {
    // Allow explicit override (set by the desktop shell when it knows where
    // Node lives).
    const override = process.env.CODESYMPHONY_NODE_EXECUTABLE?.trim();
    if (override && existsSync(override)) {
        return override;
    }

    // Under Node (e.g. Vitest, or Electron launched with ELECTRON_RUN_AS_NODE=1)
    // process.execPath is already a Node-capable binary.
    if (!isBunRuntime()) {
        return process.execPath;
    }

    // Under Bun, process.execPath is Bun itself, which cannot host node-pty.
    // Probe common Node install locations before falling back to PATH lookup.
    const home = homedir();
    const candidates = [
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        home ? join(home, ".local", "bin", "node") : "",
        home ? join(home, ".nvm", "current", "bin", "node") : "",
    ].filter((candidate) => candidate.length > 0);
    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return "node";
}

function isBunRuntime(): boolean {
    return "Bun" in globalThis;
}

const ptyHost = new PtyHost();

export function spawnPty(
    file: string,
    args: string[],
    options: PtySpawnOptions,
): PtyProcess {
    return ptyHost.spawn(file, args, options);
}

export function isPtyIoError(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return false;
    }

    const code = (error as { code?: unknown }).code;
    return code === "EBADF" || code === "EIO" || code === "EPIPE";
}
