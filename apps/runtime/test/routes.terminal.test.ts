import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTerminalWebSocket, registerTerminalRoutes } from "../src/routes/terminal";

let app: FastifyInstance;

const mockTerminalService = {
  spawn: vi.fn(),
  write: vi.fn(),
  has: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  listSessions: vi.fn(),
  getScrollback: vi.fn(),
  getExitEvent: vi.fn(),
  addListener: vi.fn(() => vi.fn()),
  addExitListener: vi.fn(() => vi.fn()),
};

const mockLogService = {
  log: vi.fn(),
};

const mockFilesystemService = {
  cleanupTerminalDropFiles: vi.fn(),
};

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  app.decorate("terminalService", mockTerminalService);
  app.decorate("logService", mockLogService);
  app.decorate("filesystemService", mockFilesystemService);
  await registerTerminalRoutes(app);
  await app.ready();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTerminalService.spawn.mockReturnValue({ resolvedCwd: "/tmp" });
  mockTerminalService.listSessions.mockReturnValue([]);
  mockTerminalService.getScrollback.mockReturnValue("");
  mockTerminalService.getExitEvent.mockReturnValue(null);
  mockTerminalService.addListener.mockReturnValue(vi.fn());
  mockTerminalService.addExitListener.mockReturnValue(vi.fn());
  mockFilesystemService.cleanupTerminalDropFiles.mockResolvedValue(undefined);
});

afterAll(async () => {
  await app.close();
});

describe("terminal routes", () => {
  describe("GET /terminal/sessions", () => {
    it("lists live and exited terminal sessions", async () => {
      mockTerminalService.listSessions.mockReturnValue([
        {
          sessionId: "wt1:terminal:1",
          requestedCwd: "/tmp/wt1",
          resolvedCwd: "/tmp/wt1",
          active: true,
          exitCode: null,
          signal: null,
        },
      ]);

      const response = await app.inject({
        method: "GET",
        url: "/terminal/sessions",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: [
          {
            sessionId: "wt1:terminal:1",
            requestedCwd: "/tmp/wt1",
            resolvedCwd: "/tmp/wt1",
            active: true,
            exitCode: null,
            signal: null,
          },
        ],
      });
    });
  });

  describe("POST /terminal/run", () => {
    it("runs command in stdin mode by default", async () => {
      mockTerminalService.spawn.mockReturnValue(undefined);
      mockTerminalService.write.mockReturnValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { sessionId: "s1", command: "ls -la" },
      });

      expect(response.statusCode).toBe(204);
      expect(mockTerminalService.spawn).toHaveBeenCalledWith("s1", undefined);
      expect(mockTerminalService.write).toHaveBeenCalledWith("s1", "ls -la\r");
    });

    it("runs command in exec mode", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { sessionId: "s2", command: "npm test", mode: "exec" },
      });

      expect(response.statusCode).toBe(204);
      expect(mockTerminalService.spawn).toHaveBeenCalledWith("s2", undefined, {
        mode: "exec",
        command: "npm test",
        replace: true,
      });
    });

    it("passes cwd when provided", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { sessionId: "s3", command: "pwd", cwd: "/tmp" },
      });

      expect(response.statusCode).toBe(204);
      expect(mockTerminalService.spawn).toHaveBeenCalledWith("s3", "/tmp");
    });

    it("returns 400 for missing sessionId", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { command: "ls" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 for missing command", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { sessionId: "s1" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 when spawn throws", async () => {
      mockTerminalService.spawn.mockImplementationOnce(() => {
        throw new Error("PTY failed");
      });

      const response = await app.inject({
        method: "POST",
        url: "/terminal/run",
        payload: { sessionId: "s1", command: "ls" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("PTY failed");
    });
  });

  describe("POST /terminal/interrupt", () => {
    it("interrupts an existing session", async () => {
      mockTerminalService.has.mockReturnValue(true);

      const response = await app.inject({
        method: "POST",
        url: "/terminal/interrupt",
        payload: { sessionId: "s1" },
      });

      expect(response.statusCode).toBe(204);
      expect(mockTerminalService.write).toHaveBeenCalledWith("s1", "\u0003");
    });

    it("returns 404 for non-existent session", async () => {
      mockTerminalService.has.mockReturnValue(false);

      const response = await app.inject({
        method: "POST",
        url: "/terminal/interrupt",
        payload: { sessionId: "nonexistent" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("Terminal session not found");
    });

    it("returns 400 for missing sessionId", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/terminal/interrupt",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /terminal/kill", () => {
    it("kills the terminal session and cleans up dropped files", async () => {
      mockTerminalService.has.mockReturnValue(true);

      const response = await app.inject({
        method: "POST",
        url: "/terminal/kill",
        payload: { sessionId: "s1" },
      });

      expect(response.statusCode).toBe(204);
      expect(mockTerminalService.kill).toHaveBeenCalledWith("s1");
      expect(mockFilesystemService.cleanupTerminalDropFiles).toHaveBeenCalledWith("s1");
    });
  });

  describe("GET /terminal/ws", () => {
    it("forwards cwd to terminal spawn", () => {
      const socket = {
        close: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      handleTerminalWebSocket(app, socket, {
        query: { sessionId: "wt1:terminal", cwd: "/tmp/wt1" },
      });

      expect(mockTerminalService.spawn).toHaveBeenCalledWith("wt1:terminal", "/tmp/wt1");
      expect(mockLogService.log).toHaveBeenCalledWith(
        "info",
        "terminal",
        "Terminal session connected: wt1:terminal",
        {
          cwd: "/tmp/wt1",
          resolvedCwd: "/tmp",
          sessionId: "wt1:terminal",
          worktreeId: "wt1",
        },
        { worktreeId: "wt1" },
      );
    });

    it("closes the socket when spawn fails for the requested cwd", () => {
      mockTerminalService.spawn.mockImplementationOnce(() => {
        throw new Error("ENOENT: missing cwd");
      });

      const socket = {
        close: vi.fn(),
        on: vi.fn(),
        send: vi.fn(),
        readyState: 1,
      };

      handleTerminalWebSocket(app, socket, {
        query: { sessionId: "wt1:terminal", cwd: "/missing" },
      });

      expect(socket.close).toHaveBeenCalledWith(1011, "ENOENT: missing cwd");
      expect(mockLogService.log).toHaveBeenCalledWith(
        "error",
        "terminal",
        "Failed to spawn PTY: ENOENT: missing cwd",
        { cwd: "/missing", sessionId: "wt1:terminal" },
      );
    });

    it("waits for the first resize before replaying scrollback and exit state", () => {
      let messageHandler: ((raw: Buffer | ArrayBuffer | Buffer[]) => void) | null = null;
      mockTerminalService.getScrollback.mockReturnValue("ready\n");
      mockTerminalService.getExitEvent.mockReturnValue({ exitCode: 0, signal: 0 });

      const socket = {
        close: vi.fn(),
        on: vi.fn((event: string, listener: (...args: any[]) => void) => {
          if (event === "message") {
            messageHandler = listener as (raw: Buffer | ArrayBuffer | Buffer[]) => void;
          }
        }),
        send: vi.fn(),
        readyState: 1,
      };

      handleTerminalWebSocket(app, socket, {
        query: { sessionId: "wt1:script-runner:1", cwd: "/tmp/wt1" },
      });

      expect(socket.send).not.toHaveBeenCalled();

      messageHandler?.(Buffer.from(JSON.stringify({
        type: "resize",
        cols: 120,
        rows: 32,
      })));

      expect(mockTerminalService.resize).toHaveBeenCalledWith("wt1:script-runner:1", 120, 32);
      expect(socket.send).toHaveBeenNthCalledWith(1, "ready\n");
      expect(socket.send).toHaveBeenNthCalledWith(2, JSON.stringify({
        kind: "cs-terminal-event",
        type: "exit",
        exitCode: 0,
        signal: 0,
      }));

      messageHandler?.(Buffer.from(JSON.stringify({
        type: "resize",
        cols: 121,
        rows: 33,
      })));

      expect(socket.send).toHaveBeenCalledTimes(2);
    });
  });
});
