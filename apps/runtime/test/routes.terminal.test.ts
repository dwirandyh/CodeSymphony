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
  addListener: vi.fn(() => vi.fn()),
  addExitListener: vi.fn(() => vi.fn()),
};

const mockLogService = {
  log: vi.fn(),
};

beforeAll(async () => {
  app = Fastify();
  await app.register(websocket);
  app.decorate("terminalService", mockTerminalService);
  app.decorate("logService", mockLogService);
  await registerTerminalRoutes(app);
  await app.ready();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockTerminalService.spawn.mockReturnValue({ resolvedCwd: "/tmp" });
  mockTerminalService.addListener.mockReturnValue(vi.fn());
  mockTerminalService.addExitListener.mockReturnValue(vi.fn());
});

afterAll(async () => {
  await app.close();
});

describe("terminal routes", () => {
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
  });
});
