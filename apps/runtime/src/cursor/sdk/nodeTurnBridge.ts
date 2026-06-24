import { type ChildProcessWithoutNullStreams, spawn as spawnChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRuntimeDebugLog } from "../../routes/debug.js";
import { resolveNodeExecutable } from "./nodeRuntime.js";
import type {
  CursorSdkNodeTurnInboundMessage,
  CursorSdkNodeTurnOutboundMessage,
  CursorSdkNodeTurnRequest,
} from "./nodeTurnProtocol.js";

const CURSOR_SDK_NODE_TURN_OUTBOUND_TYPES = new Set<CursorSdkNodeTurnOutboundMessage["type"]>([
  "ready",
  "agent_id",
  "onText",
  "onToolStarted",
  "onToolOutput",
  "onToolFinished",
  "onThinking",
  "onTodoUpdate",
  "onPlanFileDetected",
  "question_request",
  "done",
  "error",
]);

export function parseCursorSdkNodeTurnOutboundLine(line: string): CursorSdkNodeTurnOutboundMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (typeof parsed.type === "string" && CURSOR_SDK_NODE_TURN_OUTBOUND_TYPES.has(parsed.type as CursorSdkNodeTurnOutboundMessage["type"])) {
      return parsed as CursorSdkNodeTurnOutboundMessage;
    }
  } catch {
    // Cursor SDK may print non-protocol lines to the Node host stdout.
  }

  return null;
}
import type { ChatAgentRunnerResult } from "../../types.js";
import type { RunCursorSdkTurnParams } from "./runTurn.js";
import { withCursorSdkSetupHint } from "./auth.js";

function resolveNodeTurnHostScript(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "nodeTurnHost.js"),
    join(moduleDir, "../../../dist/cursor/sdk/nodeTurnHost.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[1];
}

function serializeTurnRequest(params: RunCursorSdkTurnParams): CursorSdkNodeTurnRequest {
  return {
    prompt: params.prompt,
    sessionId: params.sessionId,
    cwd: params.cwd,
    apiKey: params.apiKey,
    permissionMode: params.permissionMode,
    threadPermissionMode: params.threadPermissionMode,
    model: params.model,
    mcpServerNames: params.mcpServers ? Object.keys(params.mcpServers) : [],
  };
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

export async function runCursorSdkTurnViaNodeProcess(
  params: RunCursorSdkTurnParams,
): Promise<ChatAgentRunnerResult> {
  const hostScript = resolveNodeTurnHostScript();
  if (!existsSync(hostScript)) {
    throw new Error(
      `Cursor SDK Node host is missing at ${hostScript}. Run "bun run build" in apps/runtime before using CURSOR_TRANSPORT=sdk under Bun.`,
    );
  }
  const nodeExecutable = resolveNodeExecutable();

  appendRuntimeDebugLog({
    source: "cursor.sdk.nodeBridge",
    message: "spawn.start",
    data: { hostScript, nodeExecutable },
  });

  const child = spawnChildProcess(nodeExecutable, [hostScript], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  }) as ChildProcessWithoutNullStreams;

  let sawReady = false;
  let result: ChatAgentRunnerResult | null = null;
  let failure: unknown = null;

  let resolveTurnDone: (() => void) | null = null;
  const turnDonePromise = new Promise<void>((resolve) => {
    resolveTurnDone = resolve;
  });

  const finishTurn = () => {
    resolveTurnDone?.();
  };

  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const abortHandler = () => {
    if (child.killed) {
      return;
    }

    child.stdin.write(`${JSON.stringify({ type: "cancel" } satisfies CursorSdkNodeTurnInboundMessage)}\n`);
    forceKillTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }, 5_000);
  };
  params.abortController?.signal.addEventListener("abort", abortHandler, { once: true });

  const rl = createInterface({ input: child.stdout });

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Cursor SDK Node host did not become ready."));
    }, 10_000);

    const onLine = async (line: string) => {
      const message = parseCursorSdkNodeTurnOutboundLine(line);
      if (!message) {
        if (line.trim().length > 0) {
          appendRuntimeDebugLog({
            source: "cursor.sdk.nodeBridge",
            message: "host.stdout.skipped",
            data: { line: line.slice(0, 500) },
          });
        }
        return;
      }

      if (message.type === "ready") {
        sawReady = true;
        clearTimeout(timeout);
        resolve();
        return;
      }

      if (!sawReady) {
        return;
      }

      try {
        switch (message.type) {
          case "agent_id":
            await params.onSessionId?.(message.agentId);
            break;
          case "onText":
            await params.onText(message.text);
            break;
          case "onToolStarted":
            await params.onToolStarted(message.payload as Parameters<RunCursorSdkTurnParams["onToolStarted"]>[0]);
            break;
          case "onToolOutput":
            await params.onToolOutput(message.payload as Parameters<RunCursorSdkTurnParams["onToolOutput"]>[0]);
            break;
          case "onToolFinished":
            await params.onToolFinished(message.payload as Parameters<RunCursorSdkTurnParams["onToolFinished"]>[0]);
            break;
          case "onThinking":
            await params.onThinking?.(message.thinking);
            break;
          case "onTodoUpdate":
            await params.onTodoUpdate?.(message.payload as Parameters<NonNullable<RunCursorSdkTurnParams["onTodoUpdate"]>>[0]);
            break;
          case "onPlanFileDetected":
            await params.onPlanFileDetected?.(message.payload as Parameters<NonNullable<RunCursorSdkTurnParams["onPlanFileDetected"]>>[0]);
            break;
          case "question_request": {
            const { answers } = await params.onQuestionRequest({
              requestId: message.requestId,
              questions: message.questions as Parameters<RunCursorSdkTurnParams["onQuestionRequest"]>[0]["questions"],
            });
            child.stdin.write(`${JSON.stringify({
              type: "question_response",
              requestId: message.requestId,
              answers,
            } satisfies CursorSdkNodeTurnInboundMessage)}\n`);
            break;
          }
          case "done":
            result = message.result;
            finishTurn();
            break;
          case "error":
            failure = Object.assign(new Error(message.message), {
              name: message.name ?? "Error",
              code: message.code ?? undefined,
            });
            finishTurn();
            break;
        }
      } catch (error) {
        failure = error;
        finishTurn();
      }
    };

    rl.on("line", (line) => {
      void onLine(line);
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const text = chunk.toString().trimEnd();
    if (text.length > 0) {
      appendRuntimeDebugLog({
        source: "cursor.sdk.nodeBridge",
        message: "host.stderr",
        data: { text: text.slice(0, 500) },
      });
    }
  });

  const turnCompletionPromise = Promise.race([
    turnDonePromise,
    new Promise<void>((_, reject) => {
      child.on("exit", (code) => {
        if (!result && !failure) {
          reject(new Error(`Cursor SDK Node host exited before completing the turn (code ${code ?? "null"}).`));
        }
      });
    }),
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Cursor SDK Node host timed out waiting for turn completion."));
      }, 30 * 60_000);
    }),
  ]);

  try {
    await readyPromise;
    child.stdin.write(`${JSON.stringify({
      type: "run",
      request: serializeTurnRequest(params),
    } satisfies CursorSdkNodeTurnInboundMessage)}\n`);
    await turnCompletionPromise;

    if (failure) {
      throw failure;
    }

    const completedResult: ChatAgentRunnerResult = result ?? (() => {
      throw new Error("Cursor SDK Node host returned no turn result.");
    })();

    appendRuntimeDebugLog({
      source: "cursor.sdk.nodeBridge",
      message: "spawn.done",
      data: { sessionId: completedResult.sessionId, outputLength: completedResult.output.length },
    });

    return completedResult;
  } catch (error) {
    if (params.abortController?.signal.aborted) {
      throw createAbortError();
    }
    throw withCursorSdkSetupHint(error);
  } finally {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
    params.abortController?.signal.removeEventListener("abort", abortHandler);
    rl.close();
    if (!child.killed && !params.abortController?.signal.aborted) {
      child.kill("SIGTERM");
    }
  }
}