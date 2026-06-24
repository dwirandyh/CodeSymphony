import { createInterface } from "node:readline";
import { loadCursorSdkMcpServers } from "./mcpServers.js";
import type {
  CursorSdkNodeTurnInboundMessage,
  CursorSdkNodeTurnOutboundMessage,
} from "./nodeTurnProtocol.js";
import { runCursorSdkTurnDirect, type RunCursorSdkTurnParams } from "./runTurn.js";

function writeOutbound(message: CursorSdkNodeTurnOutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function pickMcpServers(names: string[]): RunCursorSdkTurnParams["mcpServers"] {
  if (names.length === 0) {
    return undefined;
  }

  const all = loadCursorSdkMcpServers();
  const picked = Object.fromEntries(
    names.flatMap((name) => {
      const config = all[name];
      return config ? [[name, config]] : [];
    }),
  );
  return Object.keys(picked).length > 0 ? picked : undefined;
}

const pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();
let activeTurnAbortController: AbortController | null = null;

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

function writeCancelledDone(sessionId: string | null): void {
  writeOutbound({
    type: "done",
    result: {
      output: "",
      sessionId: sessionId ?? "",
    },
  });
}

async function handleRun(request: CursorSdkNodeTurnInboundMessage & { type: "run" }): Promise<void> {
  const { request: turn } = request;
  const abortController = new AbortController();
  activeTurnAbortController = abortController;

  try {
    const result = await runCursorSdkTurnDirect({
      prompt: turn.prompt,
      sessionId: turn.sessionId,
      cwd: turn.cwd,
      apiKey: turn.apiKey,
      permissionMode: turn.permissionMode,
      threadPermissionMode: turn.threadPermissionMode,
      model: turn.model,
      mcpServers: pickMcpServers(turn.mcpServerNames),
      abortController,
      onSessionId: async (agentId) => {
        writeOutbound({ type: "agent_id", agentId });
      },
      onText: async (text) => {
        writeOutbound({ type: "onText", text });
      },
      onToolStarted: async (payload) => {
        writeOutbound({ type: "onToolStarted", payload });
      },
      onToolOutput: async (payload) => {
        writeOutbound({ type: "onToolOutput", payload });
      },
      onToolFinished: async (payload) => {
        writeOutbound({ type: "onToolFinished", payload });
      },
      onThinking: async (thinking) => {
        writeOutbound({ type: "onThinking", thinking });
      },
      onTodoUpdate: async (payload) => {
        writeOutbound({ type: "onTodoUpdate", payload });
      },
      onPlanFileDetected: async (payload) => {
        writeOutbound({ type: "onPlanFileDetected", payload });
      },
      onQuestionRequest: async ({ requestId, questions }) => {
        writeOutbound({ type: "question_request", requestId, questions });
        const answers = await new Promise<Record<string, string>>((resolve) => {
          pendingQuestions.set(requestId, resolve);
        });
        return { answers };
      },
      onPermissionRequest: async () => ({ decision: "allow" as const }),
      onSubagentStarted: async () => {},
      onSubagentStopped: async () => {},
    });

    if (!abortController.signal.aborted) {
      writeOutbound({ type: "done", result });
    }
  } catch (error) {
    if (abortController.signal.aborted || isAbortLikeError(error)) {
      writeCancelledDone(turn.sessionId);
      return;
    }

    const summary = error instanceof Error
      ? {
        message: error.message,
        name: error.name,
        code: typeof (error as { code?: unknown }).code === "string"
          ? (error as { code?: string }).code
          : null,
      }
      : { message: String(error), name: null, code: null };
    writeOutbound({ type: "error", ...summary });
  } finally {
    if (activeTurnAbortController === abortController) {
      activeTurnAbortController = null;
    }
  }
}

export async function runCursorSdkNodeTurnHost(): Promise<void> {
  writeOutbound({ type: "ready" });

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    let message: CursorSdkNodeTurnInboundMessage;
    try {
      message = JSON.parse(line) as CursorSdkNodeTurnInboundMessage;
    } catch {
      writeOutbound({ type: "error", message: "Invalid host control message." });
      continue;
    }

    if (message.type === "question_response") {
      const resolve = pendingQuestions.get(message.requestId);
      if (resolve) {
        pendingQuestions.delete(message.requestId);
        resolve(message.answers);
      }
      continue;
    }

    if (message.type === "cancel") {
      activeTurnAbortController?.abort();
      continue;
    }

    if (message.type !== "run") {
      continue;
    }

    await handleRun(message);
  }
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.includes("nodeTurnHost")) {
  runCursorSdkNodeTurnHost().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeOutbound({ type: "error", message });
    process.exit(1);
  });
}