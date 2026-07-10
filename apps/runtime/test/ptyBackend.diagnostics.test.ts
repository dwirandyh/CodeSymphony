import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPtyHostForTests,
  setPtyDiagnosticsSink,
  spawnPty,
  type PtyDiagnosticsEvent,
} from "../src/services/ptyBackend";

// The packaged-app terminal "stuck" bug (missing dist/ptyHost.mjs) surfaced
// only in stderr/console, so user issue-reports never captured it. These tests
// lock in that the PTY host lifecycle + crash failures are emitted to the
// diagnostics sink the runtime feeds into its debug buffer.
describe("ptyBackend diagnostics sink", () => {
  const originalNodeOverride = process.env.CODESYMPHONY_NODE_EXECUTABLE;

  afterEach(() => {
    resetPtyHostForTests();
    setPtyDiagnosticsSink(null);
    if (originalNodeOverride === undefined) {
      delete process.env.CODESYMPHONY_NODE_EXECUTABLE;
    } else {
      process.env.CODESYMPHONY_NODE_EXECUTABLE = originalNodeOverride;
    }
  });

  it("emits spawn-request and host lifecycle events for a healthy spawn", async () => {
    const events: PtyDiagnosticsEvent[] = [];
    setPtyDiagnosticsSink((event) => events.push(event));

    const exited = await new Promise<{ exitCode: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 8000);
      const pty = spawnPty("/bin/sh", ["-c", "printf hi; exit 0"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      pty.onExit((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });

    expect(exited.exitCode).toBe(0);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("host-spawn");
    expect(kinds).toContain("spawn-request");
  });

  it("emits host-stderr and host-exit when the PTY host child crashes", async () => {
    // Reproduce the packaged-app failure: the host child cannot start (e.g.
    // ptyHost.mjs missing) so it writes an error to stderr and exits, which
    // previously never reached the debug buffer. Stub the node executable with
    // a script that mimics that crash so the sink path is exercised end-to-end.
    const stubDir = mkdtempSync(join(tmpdir(), "cs-pty-stub-"));
    const stubPath = join(stubDir, "fake-node");
    writeFileSync(
      stubPath,
      "#!/bin/sh\necho \"Cannot find module ptyHost.mjs\" >&2\nexit 1\n",
    );
    chmodSync(stubPath, 0o755);
    process.env.CODESYMPHONY_NODE_EXECUTABLE = stubPath;
    resetPtyHostForTests();

    const events: PtyDiagnosticsEvent[] = [];
    setPtyDiagnosticsSink((event) => events.push(event));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 8000);
      const pty = spawnPty("/bin/sh", ["-c", "echo hi"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
      pty.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // stderr 'data' can flush after the child 'exit' resolves the session, so
    // give the event loop a tick to drain captured diagnostics.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stderrEvent = events.find((event) => event.kind === "host-stderr");
    const exitEvent = events.find((event) => event.kind === "host-exit");
    expect(stderrEvent?.detail).toContain("Cannot find module");
    expect(exitEvent).toBeDefined();
  });
});
