import { describe, expect, it } from "vitest";
import { spawnPty } from "../src/services/ptyBackend";

// These tests exercise the real Node PTY sidecar end-to-end. Vitest runs under
// Node, so spawnPty drives the ptyHost.mjs child and node-pty for real.
describe("ptyBackend sidecar (integration)", () => {
  it("spawns a shell, streams output, and reports exit", async () => {
    const output: string[] = [];
    const exitEvent = await new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for PTY exit")), 8000);
      const pty = spawnPty("/bin/sh", ["-c", "printf hello-pty; exit 0"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      pty.onData((data) => output.push(data));
      pty.onExit((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });

    expect(output.join("")).toContain("hello-pty");
    expect(exitEvent.exitCode).toBe(0);
  });

  it("delivers written input back through the PTY echo", async () => {
    const output: string[] = [];
    const pty = spawnPty("/bin/cat", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    const received = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for echo")), 8000);
      pty.onData((data) => {
        output.push(data);
        if (output.join("").includes("ping-pong")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    pty.write("ping-pong\n");
    await received;
    pty.kill();
    expect(output.join("")).toContain("ping-pong");
  });
});
