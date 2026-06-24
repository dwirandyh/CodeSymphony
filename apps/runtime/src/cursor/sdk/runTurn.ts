import type { AgentOptions, ModelSelection, Run } from "@cursor/sdk";
import path from "node:path";
import type { ChatAgentRunner, ChatAgentRunnerResult } from "../../types.js";
import { appendRuntimeDebugLog } from "../../routes/debug.js";
import { withCursorSdkSetupHint } from "./auth.js";
import { acquireCursorSdkAgent } from "./agentPool.js";
import { bridgeCursorSdkRunStream } from "./eventBridge.js";
import { shouldRunCursorSdkInNodeProcess } from "./nodeRuntime.js";
import { runCursorSdkTurnViaNodeProcess } from "./nodeTurnBridge.js";
import { buildCursorSdkQuestionTool, applyCursorSdkQuestionSteering, CURSOR_SDK_QUESTION_TOOL_NAME } from "./questionTool.js";
import {
  buildCursorSdkPermissionEndpointUrl,
  installCursorSdkWorktreeHook,
  registerCursorSdkPermissionBridge,
  type CursorSdkPermissionBridgeRegistration,
  type CursorSdkWorktreeHookInstallation,
} from "./permissionsBridge.js";
import { reconcileStaleCursorSdkRunsBeforeSend } from "./staleRunRecovery.js";
import { isCursorSdkHttp2TransportError } from "./transportErrors.js";

type RunnerArgs = Parameters<ChatAgentRunner>[0];

type CursorSdkTurnCallbacks = Pick<
  RunnerArgs,
  | "onText"
  | "onToolStarted"
  | "onToolOutput"
  | "onToolFinished"
  | "onQuestionRequest"
  | "onPermissionRequest"
  | "onPlanFileDetected"
  | "onTodoUpdate"
  | "onSubagentStarted"
  | "onSubagentStopped"
  | "onThinking"
>;

export type RunCursorSdkTurnParams = CursorSdkTurnCallbacks & {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  apiKey: string;
  abortController?: AbortController;
  permissionMode?: RunnerArgs["permissionMode"];
  threadPermissionMode?: RunnerArgs["threadPermissionMode"];
  model?: ModelSelection;
  mcpServers?: AgentOptions["mcpServers"];
  onSessionId?: RunnerArgs["onSessionId"];
};

type CursorSdkPermissionGate = {
  permissionBridge: CursorSdkPermissionBridgeRegistration | null;
  worktreeHook: CursorSdkWorktreeHookInstallation | null;
  dispose: () => Promise<void>;
};

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

const CURSOR_SDK_MAX_ATTEMPTS = 3;

function summarizeError(error: unknown): { message: string; name: string | null; code: string | null } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      code: typeof (error as { code?: unknown }).code === "string"
        ? ((error as { code?: string }).code ?? null)
        : null,
    };
  }
  return { message: String(error), name: null, code: null };
}

class CursorSdkNonRetryableStreamError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CursorSdkNonRetryableStreamError";
  }
}

function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof CursorSdkNonRetryableStreamError) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  return isCursorSdkHttp2TransportError(error);
}

function resolveCursorSdkMode(permissionMode: RunnerArgs["permissionMode"]): AgentOptions["mode"] {
  return permissionMode === "plan" ? "plan" : "agent";
}

function shouldUsePermissionHook(params: RunCursorSdkTurnParams): boolean {
  return params.permissionMode !== "plan" && params.threadPermissionMode !== "full_access";
}

async function setupCursorSdkPermissionGate(params: RunCursorSdkTurnParams): Promise<CursorSdkPermissionGate> {
  let permissionBridge: CursorSdkPermissionBridgeRegistration | null = null;
  let worktreeHook: CursorSdkWorktreeHookInstallation | null = null;

  if (shouldUsePermissionHook(params)) {
    permissionBridge = registerCursorSdkPermissionBridge({
      cwd: params.cwd,
      permissionMode: params.permissionMode,
      threadPermissionMode: params.threadPermissionMode,
      onPermissionRequest: params.onPermissionRequest,
    });
    worktreeHook = await installCursorSdkWorktreeHook(
      params.cwd,
      buildCursorSdkPermissionEndpointUrl(),
    );
  }

  return {
    permissionBridge,
    worktreeHook,
    dispose: async () => {
      permissionBridge?.dispose();
      await worktreeHook?.dispose();
    },
  };
}

export async function runCursorSdkTurn(params: RunCursorSdkTurnParams): Promise<ChatAgentRunnerResult> {
  const gate = await setupCursorSdkPermissionGate(params);

  appendRuntimeDebugLog({
    source: "cursor.sdk.turnStart",
    message: "turn.start",
    data: {
      sdkModel: params.model ?? null,
      mode: resolveCursorSdkMode(params.permissionMode),
      permissionMode: params.permissionMode ?? null,
      threadPermissionMode: params.threadPermissionMode ?? null,
      hasSessionId: params.sessionId != null,
      cwd: params.cwd,
      mcpServerCount: params.mcpServers ? Object.keys(params.mcpServers).length : 0,
      permissionHookEnabled: gate.worktreeHook != null,
      nodeDelegated: shouldRunCursorSdkInNodeProcess(),
    },
  });

  try {
    if (shouldRunCursorSdkInNodeProcess()) {
      return await runCursorSdkTurnViaNodeProcess({
        ...params,
        onSessionId: async (agentId) => {
          gate.permissionBridge?.bind(agentId);
          await params.onSessionId?.(agentId);
        },
      });
    }

    return await runCursorSdkTurnDirect(params, gate.permissionBridge);
  } finally {
    await gate.dispose();
  }
}

export async function runCursorSdkTurnDirect(
  params: RunCursorSdkTurnParams,
  permissionBridge: CursorSdkPermissionBridgeRegistration | null = null,
): Promise<ChatAgentRunnerResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CURSOR_SDK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await runCursorSdkTurnAttempt(params, permissionBridge);
      appendRuntimeDebugLog({
        source: "cursor.sdk.turnCompleted",
        message: "turn.completed",
        data: {
          sdkModel: params.model ?? null,
          attempts: attempt,
          outputLength: result.output.length,
          sessionId: result.sessionId,
        },
      });
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        appendRuntimeDebugLog({
          source: "cursor.sdk.turnAborted",
          message: "turn.aborted",
          data: { sdkModel: params.model ?? null, attempts: attempt },
        });
        throw createAbortError();
      }

      lastError = error;
      if (!isRetryableTransportError(error) || attempt === CURSOR_SDK_MAX_ATTEMPTS) {
        appendRuntimeDebugLog({
          source: "cursor.sdk.turnError",
          message: "turn.failed",
          data: {
            sdkModel: params.model ?? null,
            attempts: attempt,
            retryable: isRetryableTransportError(error),
            ...summarizeError(error),
            error: summarizeError(error).message,
          },
        });
        throw withCursorSdkSetupHint(error);
      }
      appendRuntimeDebugLog({
        source: "cursor.sdk.turnRetry",
        message: "turn.retry",
        data: {
          sdkModel: params.model ?? null,
          attempt,
          ...summarizeError(error),
        },
      });
    }
  }

  appendRuntimeDebugLog({
    source: "cursor.sdk.turnError",
    message: "turn.failed.exhausted",
    data: {
      sdkModel: params.model ?? null,
      attempts: CURSOR_SDK_MAX_ATTEMPTS,
      ...summarizeError(lastError),
      error: summarizeError(lastError).message,
    },
  });
  throw withCursorSdkSetupHint(lastError);
}

async function runCursorSdkTurnAttempt(
  params: RunCursorSdkTurnParams,
  permissionBridge: CursorSdkPermissionBridgeRegistration | null,
): Promise<ChatAgentRunnerResult> {
  appendRuntimeDebugLog({
    source: "cursor.sdk.acquireAgent.start",
    message: "acquire.start",
    data: {
      hasSessionId: params.sessionId != null,
      sdkModel: params.model ?? null,
    },
  });
  const lease = await acquireCursorSdkAgent({
    sessionId: params.sessionId,
    cwd: params.cwd,
    apiKey: params.apiKey,
    model: params.model,
    mcpServers: params.mcpServers,
    mode: resolveCursorSdkMode(params.permissionMode),
    settingSources: ["project", "user"],
    onSessionId: params.onSessionId,
  });
  permissionBridge?.bind(lease.agentId);
  appendRuntimeDebugLog({
    source: "cursor.sdk.acquireAgent.done",
    message: "acquire.done",
    data: { agentId: lease.agentId },
  });
  let run: Run | null = null;
  let removeAbortListener: (() => void) | null = null;
  let streamingStarted = false;
  let cancelPromise: Promise<void> | null = null;

  try {
    await reconcileStaleCursorSdkRunsBeforeSend({
      agentId: lease.agentId,
      cwd: params.cwd,
    });
    appendRuntimeDebugLog({
      source: "cursor.sdk.send.start",
      message: "send.start",
      data: {
        agentId: lease.agentId,
        promptLength: params.prompt.length,
        sdkModel: params.model ?? null,
        reusedPooledAgent: params.sessionId != null,
      },
    });
    run = await lease.agent.send(applyCursorSdkQuestionSteering(params.prompt), {
      ...(params.model ? { model: params.model } : {}),
      ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      mode: resolveCursorSdkMode(params.permissionMode),
      local: {
        customTools: {
          [CURSOR_SDK_QUESTION_TOOL_NAME]: buildCursorSdkQuestionTool({
            onQuestionRequest: params.onQuestionRequest,
          }),
        },
      },
    });
    appendRuntimeDebugLog({
      source: "cursor.sdk.send.done",
      message: "send.done",
      data: { agentId: lease.agentId, runId: run?.id ?? null },
    });

    if (params.abortController?.signal.aborted) {
      await run.cancel();
      throw createAbortError();
    }

    const abortHandler = () => {
      if (run) {
        cancelPromise = run.cancel().catch(() => undefined);
      }
    };
    params.abortController?.signal.addEventListener("abort", abortHandler, { once: true });
    removeAbortListener = () => params.abortController?.signal.removeEventListener("abort", abortHandler);

    appendRuntimeDebugLog({
      source: "cursor.sdk.stream.start",
      message: "stream.start",
      data: { agentId: lease.agentId, runId: run.id },
    });
    const { output, planEmitted } = await bridgeCursorSdkRunStream({
      stream: run.stream(),
      cwd: params.cwd,
      onText: (text) => {
        streamingStarted = true;
        return params.onText(text);
      },
      onToolStarted: (payload) => {
        streamingStarted = true;
        return params.onToolStarted(payload);
      },
      onToolOutput: params.onToolOutput,
      onToolFinished: params.onToolFinished,
      onThinking: params.onThinking,
      onTodoUpdate: params.onTodoUpdate,
      onPlanFileDetected: params.onPlanFileDetected,
    });
    appendRuntimeDebugLog({
      source: "cursor.sdk.stream.done",
      message: "stream.done",
      data: { agentId: lease.agentId, runId: run.id, outputLength: output.length, streamingStarted, planEmitted },
    });
    const result = await run.wait();
    appendRuntimeDebugLog({
      source: "cursor.sdk.wait.done",
      message: "wait.done",
      data: { agentId: lease.agentId, runId: run.id, status: result.status },
    });
    if (params.abortController?.signal.aborted || result.status === "cancelled") {
      throw createAbortError();
    }

    if (params.permissionMode === "plan" && !planEmitted && output.trim().length > 0) {
      await params.onPlanFileDetected?.({
        filePath: path.join(params.cwd, ".cursor", "plans", "cursor-plan.md"),
        content: output.trim(),
        source: "streaming_fallback",
      });
    }

    return { output, sessionId: lease.agentId };
  } catch (error) {
    if (streamingStarted && isRetryableTransportError(error)) {
      throw new CursorSdkNonRetryableStreamError(error);
    }
    throw error;
  } finally {
    removeAbortListener?.();
    if (cancelPromise) {
      try {
        await cancelPromise;
        await run?.wait();
      } catch {
        // Best-effort cleanup so the SDK local store does not keep a stale active run.
      }
    }
    lease.release();
  }
}