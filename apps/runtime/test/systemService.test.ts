import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:util", () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from "node:child_process";
import { createSystemService } from "../src/services/systemService";

const mockExecFile = vi.mocked(execFile);

describe("systemService", () => {
  let service: ReturnType<typeof createSystemService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = createSystemService();
  });

  describe("pickDirectory", () => {
    it("returns selected path on macOS", async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: "/Users/test/project/\n", stderr: "" } as never);

      const result = await service.pickDirectory();
      expect(result.path).toBe("/Users/test/project");
    });

    it("strips trailing slash from path", async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: "/home/user/repo/\n", stderr: "" } as never);

      const result = await service.pickDirectory();
      expect(result.path).toBe("/home/user/repo");
    });

    it("throws when no directory selected", async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: "\n", stderr: "" } as never);

      await expect(service.pickDirectory()).rejects.toThrow("No directory selected");
    });
  });

  describe("openFileDefaultApp", () => {
    it("opens file on darwin", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" } as never);

      await service.openFileDefaultApp("/path/to/file.txt");
      expect(mockExecFile).toHaveBeenCalledWith("open", ["/path/to/file.txt"], expect.any(Object));
    });

    it("throws for empty path", async () => {
      await expect(service.openFileDefaultApp("  ")).rejects.toThrow("File path is required");
    });

    it("throws for ENOENT error", async () => {
      const enoentError = Object.assign(new Error("not found"), { code: "ENOENT" });
      mockExecFile.mockRejectedValueOnce(enoentError);

      await expect(service.openFileDefaultApp("/file")).rejects.toThrow("No default file opener");
    });

    it("wraps generic errors", async () => {
      mockExecFile.mockRejectedValueOnce(new Error("permission denied"));

      await expect(service.openFileDefaultApp("/file")).rejects.toThrow("Unable to open file");
    });
  });

  describe("getInstalledApps", () => {
    it("returns installed apps on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      mockExecFile.mockResolvedValue({ stdout: "/Applications/Cursor.app\n", stderr: "" } as never);

      const apps = await service.getInstalledApps();
      expect(apps.length).toBeGreaterThan(0);
      expect(apps[0]).toHaveProperty("id");
      expect(apps[0]).toHaveProperty("name");
      expect(apps[0]).toHaveProperty("path");
    });

    it("uses cache on subsequent calls", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockExecFile.mockResolvedValue({ stdout: "/Applications/VSCode.app\n", stderr: "" } as never);

      const first = await service.getInstalledApps();
      mockExecFile.mockClear();

      const second = await service.getInstalledApps();
      expect(second).toBe(first);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe("openInApp", () => {
    it("opens in specified app on darwin", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" } as never);

      await service.openInApp("Cursor", "/path/to/project");
      expect(mockExecFile).toHaveBeenCalledWith("open", ["-a", "Cursor", "/path/to/project"], expect.any(Object));
    });

    it("throws for empty target path", async () => {
      await expect(service.openInApp("Cursor", "  ")).rejects.toThrow("Target path is required");
    });

    it("wraps exec errors", async () => {
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      mockExecFile.mockRejectedValueOnce(new Error("app not found"));

      await expect(service.openInApp("Unknown", "/path")).rejects.toThrow("Failed to open in Unknown");
    });
  });
});
