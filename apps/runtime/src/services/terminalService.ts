import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { TerminalTab } from "@codesymphony/shared-types";
import { buildClaudeRuntimeEnv } from "../claude/shellEnv.js";
import { isPtyIoError, spawnPty, type PtyProcess } from "./ptyBackend.js";

const MAX_SCROLLBACK_BYTES = 50_000;

// Entering/leaving the alternate screen buffer is how full-screen TUIs
// (opencode, vim, etc.) start and stop. We track this server-side so a
// reattaching client can be told to switch to the alternate buffer before the
// scrollback replay (the alt-enter byte itself may have been evicted from the
// scrollback ring buffer), and so we only force a redraw SIGWINCH for sessions
// that are actually running a TUI.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
// The alt-screen sequences can be split across PTY data chunks; keep a short
// tail of recent output so a sequence straddling two chunks is still detected.
const ALT_SCREEN_SCAN_TAIL = ALT_SCREEN_ENTER.length - 1;
// Full SIGWINCH redraw nudge: shrink by one column (a real size change so the
// TUI cannot debounce it away), hold past the TUI's resize debounce window,
// then restore. Mirrors the client reconnect nudge but is immune to browser
// fit-burst timing races.
const REATTACH_REDRAW_RESTORE_DELAY_MS = 120;

interface TerminalSession {
    id: string;
    ptyProcess: PtyProcess;
    requestedCwd?: string;
    resolvedCwd: string;
    listeners: Set<(data: string) => void>;
    exitListeners: Set<(event: { exitCode: number; signal: number }) => void>;
    scrollback: string[];
    scrollbackSize: number;
    active: boolean;
    exitEvent: { exitCode: number; signal: number } | null;
    onAlternateScreen: boolean;
    altScreenScanTail: string;
    lastResize: { cols: number; rows: number } | null;
}

interface SpawnOptions {
    mode?: "shell" | "exec";
    command?: string;
    replace?: boolean;
}

interface ListenerOptions {
    replay?: boolean;
}

function buildShellArgs(shell: string | undefined, options?: SpawnOptions): string[] {
    const mode = options?.mode ?? "shell";
    if (mode === "exec") {
        return buildExecShellArgs(shell, options?.command ?? "");
    }

    const shellName = shell ? basename(shell) : "";
    if (process.platform !== "win32" && shellName === "zsh") {
        return ["-o", "nopromptsp"];
    }

    return [];
}

const TERMINAL_ENV_STRIP_EXACT = new Set([
    "NO_COLOR",
    "FORCE_COLOR",
    "CURSOR_AGENT",
    "CURSOR_INVOKED_AS",
    "CURSOR_ASKPASS_SECRET",
    "CURSOR_ASKPASS_SOCKET",
    "ZED_TERM",
]);

const TERMINAL_ENV_STRIP_PREFIXES = ["CURSOR_"];

function stripAgentEnvForTerminal(env: Record<string, string>): void {
    for (const key of Object.keys(env)) {
        if (
            TERMINAL_ENV_STRIP_EXACT.has(key)
            || TERMINAL_ENV_STRIP_PREFIXES.some((prefix) => key.startsWith(prefix))
        ) {
            delete env[key];
        }
    }
}

function resolveTerminalZdotdir(): string | undefined {
    if (process.platform === "win32") {
        return undefined;
    }

    const configuredZdotdir = process.env.CODESYMPHONY_TERMINAL_ZDOTDIR?.trim();
    if (configuredZdotdir) {
        const templateZshrc = process.env.CODESYMPHONY_TERMINAL_ZSHRC_TEMPLATE?.trim();
        const targetZshrc = join(configuredZdotdir, ".zshrc");

        try {
            mkdirSync(configuredZdotdir, { recursive: true });
            if (templateZshrc && existsSync(templateZshrc)) {
                copyFileSync(templateZshrc, targetZshrc);
            }
            if (existsSync(targetZshrc)) {
                return configuredZdotdir;
            }
        } catch (error) {
            console.warn(`Unable to prepare terminal ZDOTDIR at ${configuredZdotdir}:`, error);
        }
    }

    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(moduleDir, "../../terminal-zsh"),
        join(moduleDir, "../../assets/terminal-zsh"),
        join(process.cwd(), "terminal-zsh"),
        join(process.cwd(), "assets/terminal-zsh"),
    ];

    for (const candidate of candidates) {
        if (existsSync(join(candidate, ".zshrc"))) {
            return candidate;
        }
    }

    return undefined;
}

function buildTerminalEnv(): Record<string, string> {
    const merged = buildClaudeRuntimeEnv(process.env) as Record<string, string>;
    // Cursor/Zed/agent parents set NO_COLOR=1; shell rc often re-applies when CURSOR_AGENT leaks in.
    stripAgentEnvForTerminal(merged);

    const terminalZdotdir = resolveTerminalZdotdir();
    if (terminalZdotdir) {
        merged.ZDOTDIR = terminalZdotdir;
    }

    return {
        ...merged,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        CLICOLOR_FORCE: "1",
        TERM_PROGRAM: "CodeSymphony",
    };
}

function normalizeCwd(cwd?: string): string | undefined {
    const trimmed = cwd?.trim();
    return trimmed ? trimmed : undefined;
}

function isWorkspaceTerminalSessionId(sessionId: string): boolean {
    return /(?:^|:)terminal(?:$|:)/u.test(sessionId) || /^default:\d+$/u.test(sessionId);
}

export function resolveShellCandidates(): string[] {
    const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]
        .filter((value): value is string => Boolean(value));
    return Array.from(new Set(candidates));
}

export function buildExecShellArgs(shell: string | undefined, command: string): string[] {
    const shellName = shell ? basename(shell) : "";
    if (shellName === "zsh" || shellName === "bash") {
        return ["-lic", command];
    }

    return ["-lc", command];
}

// Update alternate-screen tracking from a fresh PTY data chunk. The alt
// enter/exit sequences can be split across chunks, so we prepend a short tail
// of the previous chunk before scanning and remember the last alt transition
// that appears in the combined window.
function updateAlternateScreenState(session: TerminalSession, chunk: string): void {
    const scanWindow = session.altScreenScanTail + chunk;
    const lastEnter = scanWindow.lastIndexOf(ALT_SCREEN_ENTER);
    const lastExit = scanWindow.lastIndexOf(ALT_SCREEN_EXIT);

    if (lastEnter !== -1 || lastExit !== -1) {
        session.onAlternateScreen = lastEnter > lastExit;
    }

    session.altScreenScanTail = scanWindow.slice(-ALT_SCREEN_SCAN_TAIL);
}

export function createTerminalService(prisma: PrismaClient) {
    const sessions = new Map<string, TerminalSession>();

    function resolveCwdCandidates(cwd?: string): string[] {
        const normalizedCwd = normalizeCwd(cwd);
        if (normalizedCwd) {
            return [normalizedCwd];
        }

        const candidates = [process.env.HOME, "/"]
            .filter((value): value is string => Boolean(value));
        return Array.from(new Set(candidates));
    }

    function spawnProcess(cwd?: string, options?: SpawnOptions): { ptyProcess: PtyProcess; resolvedCwd: string } {
        const shellCandidates = resolveShellCandidates();
        const cwdCandidates = resolveCwdCandidates(cwd);
        let lastError: unknown = new Error("Unable to spawn terminal process");

        for (const shell of shellCandidates) {
            if (!existsSync(shell)) {
                continue;
            }

            const args = buildShellArgs(shell, options);

            for (const candidateCwd of cwdCandidates) {
                try {
                    return {
                        ptyProcess: spawnPty(shell, args, {
                            name: "xterm-256color",
                            cols: 80,
                            rows: 24,
                            cwd: candidateCwd,
                            env: buildTerminalEnv(),
                        }),
                        resolvedCwd: candidateCwd,
                    };
                } catch (error) {
                    lastError = error;
                }
            }
        }

        throw lastError;
    }

    function spawn(
        sessionId: string,
        cwd?: string,
        options?: SpawnOptions,
    ): TerminalSession {
        const normalizedCwd = normalizeCwd(cwd);
        const existing = sessions.get(sessionId);
        const shouldReuseExisting = existing
            && !options?.replace
            && existing.requestedCwd === normalizedCwd
            && (existing.active || !isWorkspaceTerminalSessionId(sessionId));
        if (shouldReuseExisting) {
            return existing;
        }

        const inheritedListeners = existing?.listeners ?? new Set<(data: string) => void>();
        const inheritedExitListeners = existing?.exitListeners ?? new Set<(event: { exitCode: number; signal: number }) => void>();

        if (existing?.active) {
            existing.active = false;
            existing.ptyProcess.kill();
        }

        const { ptyProcess, resolvedCwd } = spawnProcess(normalizedCwd, options);

        const session: TerminalSession = {
            id: sessionId,
            ptyProcess,
            requestedCwd: normalizedCwd,
            resolvedCwd,
            listeners: inheritedListeners,
            exitListeners: inheritedExitListeners,
            scrollback: [],
            scrollbackSize: 0,
            active: true,
            exitEvent: null,
            onAlternateScreen: false,
            altScreenScanTail: "",
            lastResize: existing?.lastResize ?? null,
        };

        ptyProcess.onData((data) => {
            // Buffer output for replay on reconnect
            session.scrollback.push(data);
            session.scrollbackSize += data.length;
            while (session.scrollbackSize > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
                const removed = session.scrollback.shift()!;
                session.scrollbackSize -= removed.length;
            }

            // Track whether the session is sitting on the alternate screen
            // buffer (a full-screen TUI) so reattach can restore it cleanly even
            // after the alt-enter byte is evicted from the scrollback ring.
            updateAlternateScreenState(session, data);

            for (const listener of session.listeners) {
                listener(data);
            }
        });

        ptyProcess.onExit((event) => {
            const isCurrentSession = sessions.get(sessionId) === session;
            if (!isCurrentSession) {
                return;
            }

            session.active = false;
            session.exitEvent = {
                exitCode: event.exitCode,
                signal: event.signal ?? 0,
            };

            for (const listener of session.exitListeners) {
                listener(session.exitEvent);
            }
        });

        sessions.set(sessionId, session);
        return session;
    }

    function deactivateSession(session: TerminalSession): void {
        if (!session.active) {
            return;
        }

        session.active = false;
    }

    function handlePtyIoFailure(sessionId: string, session: TerminalSession, error: unknown): void {
        if (!isPtyIoError(error)) {
            throw error;
        }

        deactivateSession(session);
    }

    function write(sessionId: string, data: string): void {
        const session = sessions.get(sessionId);
        if (!session?.active) {
            return;
        }

        try {
            session.ptyProcess.write(data);
        } catch (error) {
            handlePtyIoFailure(sessionId, session, error);
        }
    }

    function resize(sessionId: string, cols: number, rows: number): void {
        const session = sessions.get(sessionId);
        if (!session?.active) {
            return;
        }

        session.lastResize = { cols, rows };

        try {
            session.ptyProcess.resize(cols, rows);
        } catch (error) {
            handlePtyIoFailure(sessionId, session, error);
        }
    }

    function addListener(
        sessionId: string,
        callback: (data: string) => void,
        options?: ListenerOptions,
    ): () => void {
        const session = sessions.get(sessionId);
        if (!session) {
            return () => { };
        }

        // Replay buffered output so reconnected clients see the prompt
        if (options?.replay !== false && session.scrollback.length > 0) {
            const replay = session.scrollback.join("");
            callback(replay);
        }

        if (!session.active) {
            return () => { };
        }

        session.listeners.add(callback);
        return () => {
            session.listeners.delete(callback);
        };
    }

    function addExitListener(
        sessionId: string,
        callback: (event: { exitCode: number; signal: number }) => void,
        options?: ListenerOptions,
    ): () => void {
        const session = sessions.get(sessionId);
        if (!session) {
            return () => { };
        }

        if (options?.replay !== false && session.exitEvent) {
            callback(session.exitEvent);
            return () => { };
        }

        session.exitListeners.add(callback);
        return () => {
            session.exitListeners.delete(callback);
        };
    }

    function kill(sessionId: string): void {
        const session = sessions.get(sessionId);
        if (session) {
            if (session.active) {
                session.ptyProcess.kill();
            }
            sessions.delete(sessionId);
        }
    }

    function has(sessionId: string): boolean {
        return sessions.has(sessionId);
    }

    function listResourceSessions(): Array<{
        sessionId: string;
        pid: number;
        requestedCwd?: string;
        resolvedCwd: string;
    }> {
        return [...sessions.values()]
            .filter((session) => session.active)
            .map((session) => ({
            sessionId: session.id,
            pid: session.ptyProcess.pid,
            requestedCwd: session.requestedCwd,
            resolvedCwd: session.resolvedCwd,
        }));
    }

    function listSessions(): Array<{
        sessionId: string;
        requestedCwd?: string;
        resolvedCwd: string;
        active: boolean;
        exitCode: number | null;
        signal: number | null;
    }> {
        return [...sessions.values()].map((session) => ({
            sessionId: session.id,
            requestedCwd: session.requestedCwd,
            resolvedCwd: session.resolvedCwd,
            active: session.active,
            exitCode: session.exitEvent?.exitCode ?? null,
            signal: session.exitEvent?.signal ?? null,
        }));
    }

    function getScrollback(sessionId: string): string {
        const session = sessions.get(sessionId);
        if (!session || session.scrollback.length === 0) {
            return "";
        }

        return session.scrollback.join("");
    }

    // Scrollback to send to a freshly attached client. If the session is on the
    // alternate screen buffer (a full-screen TUI), prepend the alt-enter
    // sequence so the new xterm switches to the alternate buffer before the
    // replay paints — the original alt-enter byte may have been evicted from
    // the scrollback ring by a long-running TUI.
    function getReattachReplay(sessionId: string): string {
        const session = sessions.get(sessionId);
        if (!session || session.scrollback.length === 0) {
            return "";
        }

        const replay = session.scrollback.join("");
        return session.onAlternateScreen ? `${ALT_SCREEN_ENTER}${replay}` : replay;
    }

    // Force a full repaint of a reattached full-screen TUI by briefly resizing
    // the PTY (a genuine size change the TUI cannot debounce away) and then
    // restoring it. This is the server-side equivalent of the client reconnect
    // nudge, but immune to browser fit-burst timing races. No-op for sessions
    // that are not on the alternate screen buffer.
    function scheduleReattachRedraw(sessionId: string): void {
        const session = sessions.get(sessionId);
        if (!session?.active || !session.onAlternateScreen) {
            return;
        }

        const current = session.lastResize;
        if (!current) {
            return;
        }

        const nudged = current.cols > 2
            ? { cols: current.cols - 1, rows: current.rows }
            : current.rows > 2
                ? { cols: current.cols, rows: current.rows - 1 }
                : null;
        if (!nudged) {
            return;
        }

        try {
            session.ptyProcess.resize(nudged.cols, nudged.rows);
        } catch (error) {
            handlePtyIoFailure(sessionId, session, error);
            return;
        }

        setTimeout(() => {
            const latest = sessions.get(sessionId);
            if (latest !== session || !session.active) {
                return;
            }
            try {
                session.ptyProcess.resize(current.cols, current.rows);
            } catch (error) {
                handlePtyIoFailure(sessionId, session, error);
            }
        }, REATTACH_REDRAW_RESTORE_DELAY_MS);
    }

    function getExitEvent(sessionId: string): { exitCode: number; signal: number } | null {
        return sessions.get(sessionId)?.exitEvent ?? null;
    }

    function toTerminalTab(row: {
        id: string;
        worktreeId: string;
        sessionId: string;
        title: string;
        ordinal: number;
    }): TerminalTab {
        return {
            id: row.id,
            worktreeId: row.worktreeId,
            sessionId: row.sessionId,
            title: row.title,
            ordinal: row.ordinal,
        };
    }

    async function createTab(worktreeId: string): Promise<TerminalTab> {
        // Compute the next ordinal and insert atomically so concurrent creates
        // can't collide on the @@unique([worktreeId, ordinal]) constraint.
        const row = await prisma.$transaction(async (tx) => {
            const latest = await tx.terminalTab.findFirst({
                where: { worktreeId },
                orderBy: { ordinal: "desc" },
            });
            const ordinal = (latest?.ordinal ?? 0) + 1;
            const id = randomUUID();

            return tx.terminalTab.create({
                data: {
                    id,
                    worktreeId,
                    sessionId: `${worktreeId}:terminal:${id}`,
                    // New tabs are always just "Terminal"; users can rename them.
                    title: "Terminal",
                    ordinal,
                },
            });
        });

        return toTerminalTab(row);
    }

    async function listTabs(worktreeId?: string): Promise<TerminalTab[]> {
        const rows = await prisma.terminalTab.findMany({
            where: worktreeId ? { worktreeId } : undefined,
            orderBy: { ordinal: "asc" },
        });
        return rows.map(toTerminalTab);
    }

    async function renameTab(tabId: string, title: string): Promise<TerminalTab | null> {
        const existing = await prisma.terminalTab.findUnique({ where: { id: tabId } });
        if (!existing) {
            return null;
        }

        const updated = await prisma.terminalTab.update({
            where: { id: tabId },
            data: { title },
        });
        return toTerminalTab(updated);
    }

    async function closeTab(tabId: string): Promise<TerminalTab | null> {
        const tab = await prisma.terminalTab.findUnique({ where: { id: tabId } });
        if (!tab) {
            return null;
        }

        kill(tab.sessionId);
        await prisma.terminalTab.delete({ where: { id: tabId } });
        return toTerminalTab(tab);
    }

    function killAll(): void {
        for (const session of sessions.values()) {
            if (session.active) {
                session.ptyProcess.kill();
            }
        }
        sessions.clear();
    }

    return { spawn, write, resize, addListener, addExitListener, kill, has, listResourceSessions, listSessions, getScrollback, getReattachReplay, scheduleReattachRedraw, getExitEvent, killAll, createTab, listTabs, renameTab, closeTab };
}
