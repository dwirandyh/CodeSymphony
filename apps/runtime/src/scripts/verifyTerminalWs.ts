/**
 * End-to-end terminal verification against a running runtime.
 * Usage: RUNTIME_PORT=4322 bun apps/runtime/src/scripts/verifyTerminalWs.ts
 */

export {};

const port = Number(process.env.RUNTIME_PORT ?? "4322");
const host = process.env.RUNTIME_HOST?.trim() || "127.0.0.1";
const sessionId = `verify-terminal-${Date.now()}`;
const cwd = process.env.HOME || "/tmp";
const wsUrl = `ws://${host}:${port}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}`;

const FAIL_PATTERNS = [
  /script:\s*tcgetattr/i,
  /Operation not supported on socket/i,
  /Bun PTY terminal handle is unavailable/i,
];

function fail(message: string, detail?: string): never {
  console.error(`FAIL: ${message}`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const healthUrl = `http://${host}:${port}/health`;
  const health = await fetch(healthUrl).catch(() => null);
  if (!health?.ok) {
    fail(`Runtime not reachable at ${healthUrl}`);
  }

  const output: string[] = [];
  let sawPrompt = false;
  type TerminalExitEvent = { exitCode: number; signal: number };
  const sessionState: { exitEvent: TerminalExitEvent | null } = { exitEvent: null };

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for terminal verification"));
    }, 12_000);

    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      setTimeout(() => {
        ws.send("echo CODESYMPHONY_TERMINAL_VERIFY_OK\r");
      }, 600);
      setTimeout(() => {
        ws.send("\u007f");
      }, 900);
      setTimeout(() => {
        ws.send("echo CODESYMPHONY_BACKSPACE_LINE\r");
      }, 1200);
    });

    ws.addEventListener("message", (event) => {
      const chunk = String(event.data);
      try {
        const parsed = JSON.parse(chunk) as {
          kind?: string;
          type?: string;
          exitCode?: number;
          signal?: number;
        };
        if (parsed.kind === "cs-terminal-event" && parsed.type === "exit") {
          sessionState.exitEvent = {
            exitCode: parsed.exitCode ?? 0,
            signal: parsed.signal ?? 0,
          };
          return;
        }
      } catch {
        // raw terminal output
      }

      output.push(chunk);
      const joined = output.join("");
      for (const pattern of FAIL_PATTERNS) {
        if (pattern.test(joined)) {
          finish(new Error(`Matched failure pattern: ${pattern}`));
          ws.close();
          return;
        }
      }

      if (joined.includes("CODESYMPHONY_TERMINAL_VERIFY_OK")) {
        sawPrompt = true;
      }

      if (joined.includes("CODESYMPHONY_BACKSPACE_LINE")) {
        finish();
        ws.close();
      }
    });

    ws.addEventListener("error", () => {
      finish(new Error("WebSocket error"));
    });

    ws.addEventListener("close", (event) => {
      if (event.code === 1005 && !sawPrompt) {
        finish(new Error(`WebSocket closed early (code=${event.code})`));
        return;
      }
      if (!sawPrompt) {
        finish(new Error(`WebSocket closed before verification output (code=${event.code})`));
      }
    });
  }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error), output.join("").slice(0, 800));
  });

  const joined = output.join("");
  if (!joined.includes("CODESYMPHONY_TERMINAL_VERIFY_OK")) {
    fail("Missing expected echo output", joined.slice(0, 800));
  }
  if (!joined.includes("CODESYMPHONY_BACKSPACE_LINE")) {
    fail("Missing backspace follow-up echo", joined.slice(0, 800));
  }
  const exitEvent = sessionState.exitEvent;
  if (exitEvent !== null && exitEvent.exitCode !== 0) {
    fail(`Terminal exited early: code=${exitEvent.exitCode} signal=${exitEvent.signal}`);
  }

  console.log("PASS: terminal WebSocket verification");
  console.log(JSON.stringify({ port, sessionId, cwd, outputBytes: joined.length }, null, 2));
}

await main();
