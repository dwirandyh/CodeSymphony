import { afterEach, describe, expect, it } from "vitest";
import { createScriptStreamService } from "../src/services/scriptStreamService";

describe("scriptStreamService", () => {
  let service = createScriptStreamService();

  afterEach(() => {
    service = createScriptStreamService();
  });

  describe("isRunning", () => {
    it("returns false when no scripts are running", () => {
      expect(service.isRunning("wt-1")).toBe(false);
    });
  });

  describe("startSetupStream", () => {
    it("runs a simple echo command and emits data + end", async () => {
      const emitter = service.startSetupStream("wt-1", ['echo "hello"'], "/tmp", {});

      const chunks: string[] = [];
      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("data", (chunk: string) => chunks.push(chunk));
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(true);
      expect(chunks.join("")).toContain("hello");
    });

    it("reports isRunning during execution", () => {
      service.startSetupStream("wt-2", ["sleep 5"], "/tmp", {});
      expect(service.isRunning("wt-2")).toBe(true);
      service.stopScript("wt-2");
    });

    it("emits failure for non-zero exit code", async () => {
      const emitter = service.startSetupStream("wt-3", ["exit 1"], "/tmp", {});

      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(false);
    });

    it("runs multiple commands sequentially", async () => {
      const emitter = service.startSetupStream(
        "wt-4",
        ['echo "first"', 'echo "second"'],
        "/tmp",
        {},
      );

      const chunks: string[] = [];
      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("data", (chunk: string) => chunks.push(chunk));
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(true);
      const output = chunks.join("");
      expect(output).toContain("first");
      expect(output).toContain("second");
    });

    it("preserves shell state across multiple commands", async () => {
      const emitter = service.startSetupStream(
        "wt-shell-state",
        ["export MY_VAR=stream_value", 'echo "$MY_VAR"'],
        "/tmp",
        {},
      );

      const chunks: string[] = [];
      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("data", (chunk: string) => chunks.push(chunk));
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(true);
      expect(chunks.join("")).toContain("stream_value");
    });

    it("stops on first failure in multi-command sequence", async () => {
      const emitter = service.startSetupStream(
        "wt-5",
        ["exit 1", 'echo "should not run"'],
        "/tmp",
        {},
      );

      const chunks: string[] = [];
      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("data", (chunk: string) => chunks.push(chunk));
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(false);
      expect(chunks.join("")).not.toContain("should not run");
    });

    it("passes custom environment variables", async () => {
      const emitter = service.startSetupStream(
        "wt-6",
        ['echo "$MY_VAR"'],
        "/tmp",
        { MY_VAR: "custom_value" },
      );

      const chunks: string[] = [];
      const result = await new Promise<{ success: boolean }>((resolve) => {
        emitter.on("data", (chunk: string) => chunks.push(chunk));
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      expect(result.success).toBe(true);
      expect(chunks.join("")).toContain("custom_value");
    });
  });

  describe("stopScript", () => {
    it("stops a running script", async () => {
      const emitter = service.startSetupStream("wt-stop", ["sleep 30"], "/tmp", {});

      const endPromise = new Promise<{ success: boolean }>((resolve) => {
        emitter.on("end", (result: { success: boolean }) => resolve(result));
      });

      service.stopScript("wt-stop");
      const result = await endPromise;

      expect(result.success).toBe(false);
      expect(service.isRunning("wt-stop")).toBe(false);
    });

    it("does nothing for non-existent worktree", () => {
      expect(() => service.stopScript("non-existent")).not.toThrow();
    });
  });
});
