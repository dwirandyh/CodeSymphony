import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { summarizeTerminalData, type TerminalTab } from "@codesymphony/shared-types";
import { buildClaudeRuntimeEnv } from "../claude/shellEnv.js";
import { appendRuntimeDebugLog } from "../routes/debug.js";
import { HeadlessEmulator, DEFAULT_MODES, type TerminalSnapshot } from "./headlessEmulator.js";
import { isPtyIoError, spawnPty, type PtyProcess } from "./ptyBackend.js";

const MAX_SCROLLBACK_BYTES = 50_000;
const TERMINAL_TYPING_DEBUG_PREFIX = "[DEBUG-terminal-typing]";

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
    emulator: HeadlessEmulator;
    lastResize: { cols: number; rows: number } | null;
    lastLoggedAlternateScreen: boolean;
    outputSeq: number;
}

interface SpawnOptions {
    mode?: "shell" | "exec";
    command?: string;
    replace?: boolean;
}

interface ListenerOptions {
    replay?: boolean;
}

type SessionViewerKind = "authoritative" | "remote";

interface SessionViewerCounts {
    authoritative: number;
    remote: number;
}

interface TerminalResizeOptions {
    authoritative?: boolean;
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
    "OPENCODE",
    "ZED_TERM",
]);

const TERMINAL_ENV_STRIP_PREFIXES = ["CURSOR_", "OPENCODE_"];

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
        // xterm.js emits kitty-compatible keyboard bytes; advertise kitty so
        // agent TUIs parse them and avoid inherited runtime terminal quirks.
        TERM_PROGRAM: "kitty",
    };
}

function normalizeCwd(cwd?: string): string | undefined {
    const trimmed = cwd?.trim();
    return trimmed ? trimmed : undefined;
}

function isWorkspaceTerminalSessionId(sessionId: string): boolean {
    return /(?:^|:)terminal(?:$|:)/u.test(sessionId) || /^default:\d+$/u.test(sessionId);
}

function resolveWorktreeId(sessionId: string): string | undefined {
    return sessionId.includes(":") ? sessionId.split(":", 1)[0] : undefined;
}

function appendTerminalInputDebugLog(
    message: string,
    sessionId: string,
    data: Record<string, unknown>,
): void {
    appendRuntimeDebugLog({
        source: "terminal.input",
        message: `${TERMINAL_TYPING_DEBUG_PREFIX} ${message}`,
        data: {
            sessionId,
            worktreeId: resolveWorktreeId(sessionId),
            ...data,
        },
    });
}

function appendTerminalOutputDebugLog(
    message: string,
    sessionId: string,
    data: Record<string, unknown>,
): void {
    appendRuntimeDebugLog({
        source: "terminal.output",
        message: `${TERMINAL_TYPING_DEBUG_PREFIX} ${message}`,
        data: {
            sessionId,
            worktreeId: resolveWorktreeId(sessionId),
            ...data,
        },
    });
}

// Detect terminal capability queries a full-screen TUI sends at startup and may
// block on. We log which queries appear (and whether the emulator answers them)
// so a stuck-launch issue report shows exactly which query went unanswered.
// We intentionally summarize — never log raw PTY bytes — so this stays out of
// the issue-report raw-payload redaction path.
const TERMINAL_QUERY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "DA1", pattern: /\x1b\[(?:\?|>|=)?[0-9;]*c/u },
    { name: "DA2", pattern: /\x1b\[>[0-9;]*c/u },
    { name: "DSR", pattern: /\x1b\[(?:\?)?[0-9;]*n/u },
    { name: "XTVERSION", pattern: /\x1b\[>[0-9;]*q/u },
    { name: "kittyKeyboard", pattern: /\x1b\[\?[0-9;]*u/u },
    { name: "DECRQM", pattern: /\x1b\[\?[0-9;]+\$p/u },
    { name: "OSC10_11", pattern: /\x1b\][0-9]{2};\?(?:\x07|\x1b\\)/u },
];

// Replies the emulator emits. Distinct from the query patterns because a reply
// often has a different shape than its query (e.g. OSC color replies carry an
// rgb spec rather than "?"), so we can confirm in a report that the emulator
// actually answered, not just that a query arrived.
const TERMINAL_REPLY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "kittyKeyboard", pattern: /\x1b\[\?[0-9;]*u/u },
    { name: "DA", pattern: /\x1b\[(?:\?|>)?[0-9;]*c/u },
    { name: "OSC10_11", pattern: /\x1b\][0-9]{2};rgb:/u },
];

function matchPatterns(
    chunk: string,
    patterns: Array<{ name: string; pattern: RegExp }>,
): string[] {
    const found: string[] = [];
    for (const { name, pattern } of patterns) {
        if (pattern.test(chunk)) {
            found.push(name);
        }
    }
    return found;
}

function detectTerminalQueries(chunk: string): string[] {
    return matchPatterns(chunk, TERMINAL_QUERY_PATTERNS);
}

function detectTerminalReplies(chunk: string): string[] {
    return matchPatterns(chunk, TERMINAL_REPLY_PATTERNS);
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

export function createTerminalService(prisma: PrismaClient) {
    const sessions = new Map<string, TerminalSession>();
    const sessionViewerCounts = new Map<string, SessionViewerCounts>();

    function registerSessionViewer(sessionId: string, kind: SessionViewerKind): () => void {
        const counts = sessionViewerCounts.get(sessionId) ?? { authoritative: 0, remote: 0 };
        counts[kind] += 1;
        sessionViewerCounts.set(sessionId, counts);

        return () => {
            const current = sessionViewerCounts.get(sessionId);
            if (!current) {
                return;
            }

            current[kind] = Math.max(0, current[kind] - 1);
            if (current.authoritative === 0 && current.remote === 0) {
                sessionViewerCounts.delete(sessionId);
            }
        };
    }

    function shouldApplySharedTerminalResize(sessionId: string, authoritative: boolean): boolean {
        if (authoritative) {
            return true;
        }

        const counts = sessionViewerCounts.get(sessionId);
        return !counts || counts.authoritative === 0;
    }

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
        existing?.emulator.dispose();

        const { ptyProcess, resolvedCwd } = spawnProcess(normalizedCwd, options);

        const sessionWorktreeId = resolveWorktreeId(sessionId);

        const emulator = new HeadlessEmulator({
            cols: existing?.lastResize?.cols ?? 80,
            rows: existing?.lastResize?.rows ?? 24,
            // Match the web client's XTERM_THEME so OSC 10/11 color queries (which
            // opencode sends at startup) get a reply consistent with the visible UI.
            foreground: "#d4d8e0",
            background: "#0f1218",
        });
        emulator.setCwd(resolvedCwd);

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
            emulator,
            lastResize: existing?.lastResize ?? null,
            lastLoggedAlternateScreen: false,
            outputSeq: 0,
        };

        // The headless emulator answers terminal capability queries (DA1/DSR,
        // kitty keyboard, etc.) that full-screen TUIs send on startup and then
        // block waiting for. Without a responder, opencode/vim stall until their
        // internal query timeout (the "stuck until refresh" bug). The reply is
        // written straight back to the PTY regardless of whether any client is
        // attached.
        emulator.onData((reply) => {
            if (!session.active) {
                return;
            }
            const answeredQueries = detectTerminalReplies(reply);
            if (answeredQueries.length > 0) {
                appendRuntimeDebugLog({
                    source: "terminal.render",
                    message: "emulator.queryReply",
                    data: {
                        sessionId,
                        worktreeId: sessionWorktreeId,
                        queries: answeredQueries,
                        replyLength: reply.length,
                    },
                });
            }
            try {
                session.ptyProcess.write(reply);
            } catch (error) {
                handlePtyIoFailure(sessionId, session, error);
            }
        });

        ptyProcess.onData((data) => {
            appendTerminalOutputDebugLog("service.pty.output", sessionId, {
                outputSeq: ++session.outputSeq,
                listenerCount: session.listeners.size,
                active: session.active,
                outputSummary: summarizeTerminalData(data),
            });

            // Buffer output for replay on reconnect
            session.scrollback.push(data);
            session.scrollbackSize += data.length;
            while (session.scrollbackSize > MAX_SCROLLBACK_BYTES && session.scrollback.length > 1) {
                const removed = session.scrollback.shift()!;
                session.scrollbackSize -= removed.length;
            }

            // Surface which capability queries the TUI emitted so a stuck-launch
            // issue report shows whether the emulator had a query to answer.
            const ptyQueries = detectTerminalQueries(data);
            if (ptyQueries.length > 0) {
                appendRuntimeDebugLog({
                    source: "terminal.render",
                    message: "pty.query",
                    data: {
                        sessionId,
                        worktreeId: sessionWorktreeId,
                        queries: ptyQueries,
                    },
                });
            }

            // Feed the headless emulator so it answers queries and keeps an
            // authoritative screen model for snapshot-based reattach.
            session.emulator.write(data);

            // Ground truth for stuck-TUI reports: does the PTY ever actually
            // enter the alternate screen? Log every flip of the emulator's
            // alt-screen mode (the "refresh fixes it" path relies on this state).
            const altNow = session.emulator.getModes().alternateScreen;
            if (altNow !== session.lastLoggedAlternateScreen) {
                session.lastLoggedAlternateScreen = altNow;
                appendRuntimeDebugLog({
                    source: "terminal.render",
                    message: "pty.alternateScreen",
                    data: {
                        sessionId,
                        worktreeId: sessionWorktreeId,
                        alternateScreen: altNow,
                    },
                });
            }

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
        const inputSummary = summarizeTerminalData(data);
        if (!session) {
            appendTerminalInputDebugLog("service.write.skippedNoSession", sessionId, {
                inputSummary,
            });
            return;
        }
        if (!session.active) {
            appendTerminalInputDebugLog("service.write.skippedInactive", sessionId, {
                inputSummary,
            });
            return;
        }

        try {
            session.ptyProcess.write(data);
            appendTerminalInputDebugLog("service.write.ptyWriteOk", sessionId, {
                active: session.active,
                inputSummary,
            });
        } catch (error) {
            appendTerminalInputDebugLog("service.write.ptyWriteError", sessionId, {
                active: session.active,
                inputSummary,
                message: error instanceof Error ? error.message : String(error),
            });
            handlePtyIoFailure(sessionId, session, error);
        }
    }

    function resize(sessionId: string, cols: number, rows: number, options?: TerminalResizeOptions): void {
        const authoritative = options?.authoritative !== false;
        if (!shouldApplySharedTerminalResize(sessionId, authoritative)) {
            return;
        }

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
        session.emulator.resize(cols, rows);
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
            session.emulator.dispose();
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

    // Structured snapshot for a freshly attaching client. The headless emulator
    // holds the authoritative screen state, so we flush pending writes then
    // serialize: screen contents, input-affecting modes (including whether the
    // session is on the alternate screen buffer for a full-screen TUI), and cwd.
    // The client restores deterministically from this instead of replaying raw
    // scrollback and guessing the alt-screen state.
    async function getAttachSnapshot(sessionId: string): Promise<TerminalSnapshot> {
        const session = sessions.get(sessionId);
        if (!session) {
            return {
                snapshotAnsi: "",
                rehydrateSequences: "",
                cwd: null,
                modes: { ...DEFAULT_MODES },
                cols: 80,
                rows: 24,
            };
        }

        await session.emulator.flush();
        const snapshot = session.emulator.getSnapshot();
        if (session.lastResize) {
            snapshot.cols = session.lastResize.cols;
            snapshot.rows = session.lastResize.rows;
        }
        return snapshot;
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
            session.emulator.dispose();
        }
        sessions.clear();
    }

    return {
        spawn,
        write,
        resize,
        registerSessionViewer,
        shouldApplySharedTerminalResize,
        addListener,
        addExitListener,
        kill,
        has,
        listResourceSessions,
        listSessions,
        getScrollback,
        getAttachSnapshot,
        getExitEvent,
        killAll,
        createTab,
        listTabs,
        renameTab,
        closeTab,
    };
}
