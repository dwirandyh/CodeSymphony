import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClaudeRunner } from "../types.js";

import { extractBashToolResult } from "./bashResult.js";
import { sanitizeForLog } from "./sanitize.js";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
  selectExecutableForCurrentProcess,
  captureStderrLine,
  withClaudeSetupHint,
} from "./executableResolver.js";
import type { SessionMaps } from "./sessionInstrumentation.js";
import { createEmitInstrumentation, createEmitDecision, createMarkStarted } from "./sessionInstrumentation.js";
import {
  createCanUseTool,
  createPreToolUseHook,
  createPostToolUseHook,
  createPostToolUseFailureHook,
  createSubagentStartHook,
  createSubagentStopHook,
} from "./sessionHooks.js";
import type { HookCallbacks, SessionState } from "./sessionHooks.js";
import {
  processStreamMessages,
  runPostStreamPlanDetection,
  runSyntheticToolFinish,
  runAnomalyDetection,
} from "./sessionStreamProcessor.js";

// Re-export for backward-compatible __testing API used by existing tests
export const __testing = {
  extractBashToolResult,
  sanitizeForLog,
};

export const runClaudeWithStreaming: ClaudeRunner = async ({
  prompt,
  sessionId,
  cwd,
  abortController,
  permissionMode,
  autoAcceptTools,
  model,
  providerApiKey,
  providerBaseUrl,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
  onSubagentStarted,
  onSubagentStopped,
  onThinking,
  onToolInstrumentation,
}) => {
  const recentStderr: string[] = [];
  const queryStartTimestamp = Date.now();

  const maps: SessionMaps = {
    startedToolUseIds: new Set<string>(),
    finishedToolUseIds: new Set<string>(),
    toolMetadataByUseId: new Map(),
    bashResultByToolUseId: new Map(),
    requestedToolByUseId: new Map(),
    agentIdToToolUseId: new Map(),
    decisionByToolUseId: new Map(),
    startedAtMsByToolUseId: new Map(),
    progressByToolUseId: new Map(),
    summaryUnknownToolUseIds: new Set<string>(),
    subagentToolInputByUseId: new Map(),
    pendingSubagentTaskToolUseIds: [],
    subagentTaskToolUseIdBySubagentToolUseId: new Map(),
    subagentResponseByUseId: new Map(),
    sessionPersistedPlanFiles: new Set<string>(),
  };

  const instrumentContext = {
    cwd,
    sessionId,
    permissionMode: permissionMode ?? "default",
    autoAcceptTools: Boolean(autoAcceptTools),
  };

  const state: SessionState = {
    finalOutput: "",
    planFileDetected: false,
    queryStartTimestamp,
  };

  const callbacks: HookCallbacks = {
    onToolStarted,
    onToolFinished,
    onQuestionRequest,
    onPermissionRequest,
    onPlanFileDetected,
    onSubagentStarted,
    onSubagentStopped,
  };

  const emitInstrumentation = createEmitInstrumentation(onToolInstrumentation);
  const emitDecision = createEmitDecision(emitInstrumentation, maps, instrumentContext);
  const markStarted = createMarkStarted(onToolStarted, emitInstrumentation, maps, instrumentContext);

  const canUseTool = createCanUseTool(
    callbacks,
    emitInstrumentation,
    emitDecision,
    maps,
    instrumentContext,
    state,
    permissionMode,
    autoAcceptTools,
  );

  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;

  const baseEnv = {
    ...process.env,
  } as NodeJS.ProcessEnv;
  delete baseEnv.CLAUDECODE;
  delete baseEnv.ANTHROPIC_API_KEY;
  delete baseEnv.ANTHROPIC_BASE_URL;
  delete baseEnv.ANTHROPIC_AUTH_TOKEN;
  delete baseEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;

  const candidateExecutables = buildExecutableCandidates(configuredExecutable);
  const claudeExecutable = selectExecutableForCurrentProcess(candidateExecutables, baseEnv);

  const runtimeEnv = { ...baseEnv };
  let effectiveModel = model || undefined;
  if (providerApiKey && providerBaseUrl) {
    const providerConfigDir = join(tmpdir(), "codesymphony-claude-provider");
    if (!existsSync(providerConfigDir)) {
      mkdirSync(providerConfigDir, { recursive: true });
      writeFileSync(join(providerConfigDir, "settings.json"), "{}", "utf-8");
    }
    runtimeEnv.CLAUDE_CONFIG_DIR = providerConfigDir;

    runtimeEnv.ANTHROPIC_API_KEY = providerApiKey;
    runtimeEnv.ANTHROPIC_AUTH_TOKEN = providerApiKey;
    runtimeEnv.ANTHROPIC_BASE_URL = providerBaseUrl;
    if (model) {
      runtimeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      runtimeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      effectiveModel = "opus";
    }
  }

  try {
    const stream = query({
      prompt,
      options: {
        model: effectiveModel,
        abortController,
        includePartialMessages: true,
        resume: sessionId ?? undefined,
        permissionMode: permissionMode ?? "default",
        canUseTool,
        tools: {
          type: "preset",
          preset: "claude_code",
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [createPreToolUseHook(markStarted, maps)],
            },
          ],
          PostToolUse: [
            {
              hooks: [createPostToolUseHook(callbacks, emitInstrumentation, maps, instrumentContext)],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [createPostToolUseFailureHook(callbacks, emitInstrumentation, maps, instrumentContext)],
            },
          ],
          SubagentStart: [
            {
              hooks: [createSubagentStartHook(callbacks, maps)],
            },
          ],
          SubagentStop: [
            {
              hooks: [createSubagentStopHook(callbacks, maps)],
            },
          ],
        },
        pathToClaudeCodeExecutable: claudeExecutable,
        settingSources: ["local", "project", "user"],
        cwd,
        env: runtimeEnv,
        stderr: (data: string) => {
          captureStderrLine(recentStderr, data);
        },
      },
    });

    const latestSessionId = await processStreamMessages(
      stream as AsyncIterable<Record<string, unknown>>,
      {
        callbacks,
        emitInstrumentation,
        markStarted,
        maps,
        instrumentContext,
        state,
        permissionMode,
        onText,
        onThinking,
        onToolOutput,
      },
    );

    await runPostStreamPlanDetection(state, maps, callbacks, permissionMode);
    await runSyntheticToolFinish(emitInstrumentation, callbacks, maps, instrumentContext);
    await runAnomalyDetection(emitInstrumentation, maps, instrumentContext);

    return {
      output: state.finalOutput.trim(),
      sessionId: latestSessionId ?? sessionId,
    };
  } catch (error) {
    throw withClaudeSetupHint(error, recentStderr, claudeExecutable);
  }
};
