import { spawn as spawnChildProcess } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand as SdkSlashCommand,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatMode, ChatThreadPermissionMode, SlashCommand } from "@codesymphony/shared-types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeRunner, ClaudeSessionPermissionMode } from "../types.js";
import { areLikelySameFsPath } from "../services/repositoryService.js";

import { extractBashToolResult } from "./bashResult.js";
import { sanitizeForLog } from "./sanitize.js";
import {
  DEFAULT_CLAUDE_EXECUTABLE,
  buildExecutableCandidates,
  selectExecutableForCurrentProcess,
  captureStderrLine,
  withClaudeSetupHint,
} from "./executableResolver.js";
import { buildClaudeRuntimeEnv } from "./shellEnv.js";
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
import { isImageAttachment, readAttachmentBase64 } from "../agentAttachments.js";

// Re-export for backward-compatible __testing API used by existing tests
export const __testing = {
  extractBashToolResult,
  sanitizeForLog,
  buildClaudeRuntimeEnv,
  resolveNativeClaudeCliModel,
  shouldUseNativeClaudeCliAlias,
  resolveRequestedNativeClaudeCliModel,
  shouldRetryWithNativeClaudeCliModel,
};

const NATIVE_CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-6": "sonnet",
  "claude-opus-4-6": "opus",
  "claude-haiku-4-5": "haiku",
};

function resolveNativeClaudeCliModel(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  return NATIVE_CLAUDE_CLI_MODEL_ALIASES[model] ?? model;
}

function isFirstPartyAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function shouldUseNativeClaudeCliAlias(baseUrl: string | undefined): boolean {
  if (!baseUrl || baseUrl.trim().length === 0) {
    return false;
  }

  return !isFirstPartyAnthropicBaseUrl(baseUrl.trim());
}

function readClaudeSettingsEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { env?: Record<string, unknown> };
    if (!parsed || typeof parsed !== "object" || !parsed.env || typeof parsed.env !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function resolveConfiguredClaudeBaseUrl(cwd: string, runtimeEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const homeDir = process.env.HOME?.trim();
  const candidateSettingsPaths = [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    homeDir ? join(homeDir, ".claude", "settings.json") : null,
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ].filter((path): path is string => Boolean(path));

  const mergedEnv = candidateSettingsPaths.reduce<Record<string, string>>((acc, settingsPath) => {
    Object.assign(acc, readClaudeSettingsEnv(settingsPath));
    return acc;
  }, {});

  const candidateBaseUrls = [
    runtimeEnv.ANTHROPIC_BASE_URL?.trim(),
    mergedEnv.ANTHROPIC_BASE_URL?.trim(),
  ].filter((baseUrl): baseUrl is string => Boolean(baseUrl && baseUrl.length > 0));

  return candidateBaseUrls.find((baseUrl) => shouldUseNativeClaudeCliAlias(baseUrl)) ?? candidateBaseUrls[0];
}

function resolveRequestedNativeClaudeCliModel(
  model: string | undefined,
  cwd: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!model) {
    return undefined;
  }

  const configuredBaseUrl = resolveConfiguredClaudeBaseUrl(cwd, runtimeEnv);
  if (!shouldUseNativeClaudeCliAlias(configuredBaseUrl)) {
    return model;
  }

  return resolveNativeClaudeCliModel(model);
}

function shouldRetryWithNativeClaudeCliModel(params: {
  model: string | undefined;
  providerApiKey?: string;
  providerBaseUrl?: string;
  recentDiagnostics: string[];
  finalOutput: string;
  startedToolCount: number;
}): boolean {
  if (params.providerApiKey || params.providerBaseUrl) {
    return false;
  }

  if (params.finalOutput.trim().length > 0 || params.startedToolCount > 0) {
    return false;
  }

  const fallbackModel = resolveNativeClaudeCliModel(params.model);
  if (!params.model || !fallbackModel || fallbackModel === params.model) {
    return false;
  }

  return params.recentDiagnostics.some((diagnostic) => /unknown provider for model/i.test(diagnostic));
}

function shouldResumeSession(sessionId: string | null, sessionWorktreePath: string | null | undefined, cwd: string): boolean {
  if (!sessionId || !sessionWorktreePath) {
    return false;
  }

  return areLikelySameFsPath(sessionWorktreePath, cwd);
}

function resolveClaudeQueryProcessPid(stream: Query | null): number | null {
  const pid = (stream as {
    transport?: {
      process?: {
        pid?: unknown;
      };
    };
  } | null)?.transport?.process?.pid;

  return Number.isInteger(pid) && Number(pid) > 0 ? Number(pid) : null;
}

function createClaudeProcessSpawner(params: {
  onProcessSpawned?: (pid: number) => void;
  onStderr: (data: string) => void;
}): (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess {
  return ({ command, args, cwd, env, signal }: ClaudeSpawnOptions) => {
    const child = spawnChildProcess(command, args, {
      cwd,
      env,
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      params.onStderr(chunk.toString());
    });

    if (Number.isInteger(child.pid) && Number(child.pid) > 0) {
      params.onProcessSpawned?.(Number(child.pid));
    }

    const wrappedProcess: ClaudeSpawnedProcess & { pid: number } = {
      pid: child.pid ?? -1,
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      kill(signal: NodeJS.Signals) {
        return child.kill(signal);
      },
      on(event, listener) {
        child.on(event, listener);
      },
      once(event, listener) {
        child.once(event, listener);
      },
      off(event, listener) {
        child.off(event, listener);
      },
    };

    return wrappedProcess;
  };
}

function normalizeSlashCommands(commands: SdkSlashCommand[] | undefined | null): SlashCommand[] {
  return (commands ?? [])
    .map((command) => ({
      name: typeof command.name === "string" ? command.name.trim() : "",
      description: typeof command.description === "string" ? command.description : "",
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : "",
    }))
    .filter((command) => command.name.length > 0);
}

async function buildClaudePromptInput(params: {
  prompt: string;
  promptWithAttachments?: string;
  attachments?: Parameters<ClaudeRunner>[0]["attachments"];
}): Promise<string | AsyncIterable<SDKUserMessage>> {
  if (!(params.attachments?.some(isImageAttachment))) {
    return params.promptWithAttachments ?? params.prompt;
  }

  const contentBlocks: Array<Record<string, unknown>> = [];
  for (const attachment of params.attachments ?? []) {
    if (!isImageAttachment(attachment)) {
      continue;
    }

    const data = await readAttachmentBase64(attachment);
    if (!data) {
      continue;
    }

    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data,
      },
    });
  }

  const textPrompt = params.prompt;
  if (textPrompt.trim().length > 0 || contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: textPrompt.trim().length > 0 ? textPrompt : (params.promptWithAttachments ?? params.prompt),
    });
  }

  return (async function* () {
    yield {
      type: "user",
      message: {
        role: "user",
        content: contentBlocks,
      } as SDKUserMessage["message"],
      parent_tool_use_id: null,
      session_id: "",
    } satisfies SDKUserMessage;
  })();
}

function resolveSdkPermissionMode(
  runPermissionMode: ChatMode | undefined,
  threadPermissionMode: ChatThreadPermissionMode | undefined,
): {
  sdkPermissionMode: ClaudeSessionPermissionMode;
  allowDangerouslySkipPermissions: boolean;
} {
  if (runPermissionMode === "plan") {
    return {
      sdkPermissionMode: "plan",
      allowDangerouslySkipPermissions: false,
    };
  }

  if (threadPermissionMode === "full_access") {
    return {
      sdkPermissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
  }

  return {
    sdkPermissionMode: runPermissionMode ?? "default",
    allowDangerouslySkipPermissions: false,
  };
}

export const runClaudeWithStreaming: ClaudeRunner = async ({
  prompt,
  promptWithAttachments,
  attachments,
  sessionId,
  listSlashCommandsOnly,
  cwd,
  sessionWorktreePath,
  abortController,
  onSessionId,
  permissionMode,
  threadPermissionMode,
  permissionProfile,
  autoAcceptTools,
  model,
  providerApiKey,
  providerBaseUrl,
  onProcessSpawned,
  onText,
  onToolStarted,
  onToolOutput,
  onToolFinished,
  onQuestionRequest,
  onPermissionRequest,
  onPlanFileDetected,
  onTodoUpdate,
  onSubagentStarted,
  onSubagentStopped,
  onToolInstrumentation,
}) => {
  const queryStartTimestamp = Date.now();
  const { sdkPermissionMode, allowDangerouslySkipPermissions } = resolveSdkPermissionMode(
    permissionMode,
    threadPermissionMode,
  );

  const instrumentContext = {
    cwd,
    sessionId,
    permissionMode: sdkPermissionMode,
    autoAcceptTools: Boolean(autoAcceptTools),
    permissionProfile: permissionProfile ?? "default",
  };

  const callbacks: HookCallbacks = {
    onToolStarted,
    onToolFinished,
    onQuestionRequest,
    onPermissionRequest,
    onPlanFileDetected,
    onTodoUpdate,
    onSubagentStarted,
    onSubagentStopped,
  };

  const configuredExecutable = process.env.CLAUDE_CODE_EXECUTABLE?.trim() || DEFAULT_CLAUDE_EXECUTABLE;

  const resolvedClaudeRuntimeEnv = buildClaudeRuntimeEnv({
    ...process.env,
  } as NodeJS.ProcessEnv);
  const initialRequestedModel = providerApiKey || providerBaseUrl
    ? (model || undefined)
    : resolveRequestedNativeClaudeCliModel(model || undefined, cwd, resolvedClaudeRuntimeEnv);
  const baseEnv = { ...resolvedClaudeRuntimeEnv };
  delete baseEnv.CLAUDECODE;
  delete baseEnv.ANTHROPIC_API_KEY;
  delete baseEnv.ANTHROPIC_BASE_URL;
  delete baseEnv.ANTHROPIC_AUTH_TOKEN;
  delete baseEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete baseEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;

  const candidateExecutables = buildExecutableCandidates(configuredExecutable);
  const claudeExecutable = selectExecutableForCurrentProcess(candidateExecutables, baseEnv);

  async function runAttempt(requestedModel: string | undefined, allowModelFallback: boolean) {
    const recentStderr: string[] = [];
    const processSpawnTasks: Array<Promise<void>> = [];
    let processSpawned = false;
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
      subagentToolUseIdByTaskToolUseId: new Map(),
      subagentOwnerToolUseIdByToolUseId: new Map(),
      subagentResponseByUseId: new Map(),
      sessionPersistedPlanFiles: new Set<string>(),
      activeSubagentToolUseIds: [],
      ownershipDebugLogCache: new Set<string>(),
    };
    const state: SessionState = {
      finalOutput: "",
      planFileDetected: false,
      todoGroupId: null,
      emittedTodoToolUseIds: new Set<string>(),
      queryStartTimestamp,
      promptSuggestions: [],
      recentDiagnostics: [],
      resultSummary: null,
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
      permissionProfile,
    );

    const runtimeEnv = { ...baseEnv };
    let effectiveModel = requestedModel;
    if (providerApiKey && providerBaseUrl) {
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

    let stream: Query | null = null;
    const notifyProcessSpawned = (pid: number | null | undefined) => {
      if (processSpawned || !Number.isInteger(pid) || Number(pid) <= 0) {
        return;
      }

      processSpawned = true;

      if (onProcessSpawned) {
        processSpawnTasks.push(Promise.resolve(onProcessSpawned(Number(pid))));
      }
    };
    const spawnClaudeCodeProcess = createClaudeProcessSpawner({
      onProcessSpawned: notifyProcessSpawned,
      onStderr: (data) => {
        captureStderrLine(recentStderr, data);
      },
    });

    try {
      const promptInput = listSlashCommandsOnly
        ? "List currently available slash commands."
        : await buildClaudePromptInput({
          prompt,
          promptWithAttachments,
          attachments,
        });
      stream = query({
        prompt: promptInput,
        options: {
          model: effectiveModel,
          abortController,
          includePartialMessages: true,
          resume: shouldResumeSession(sessionId, sessionWorktreePath, cwd) ? (sessionId ?? undefined) : undefined,
          forkSession: false,
          permissionMode: sdkPermissionMode,
          allowDangerouslySkipPermissions,
          canUseTool,
          tools: {
            type: "preset",
            preset: "claude_code",
          },
          hooks: {
            PreToolUse: [
              {
                hooks: [createPreToolUseHook(callbacks, state, markStarted, maps)],
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
          spawnClaudeCodeProcess,
          settingSources: ["local", "project", "user"],
          cwd,
          env: runtimeEnv,
          stderr: (data: string) => {
            captureStderrLine(recentStderr, data);
          },
        },
      });

      notifyProcessSpawned(resolveClaudeQueryProcessPid(stream));
      await Promise.all(processSpawnTasks);

      if (listSlashCommandsOnly) {
        const slashCommands = normalizeSlashCommands(await stream.supportedCommands());
        try {
          stream.close();
        } catch {
          // Best effort.
        }
        return {
          output: "",
          sessionId,
          slashCommands,
        };
      }

      const latestSessionId = await processStreamMessages(
        stream as AsyncIterable<SDKMessage>,
        {
          callbacks,
          emitInstrumentation,
          markStarted,
          maps,
          instrumentContext,
          state,
          permissionMode,
          onSessionId,
          onText,
          onToolOutput,
        },
      );

      await runPostStreamPlanDetection(state, maps, callbacks, permissionMode);
      await runSyntheticToolFinish(emitInstrumentation, callbacks, maps, instrumentContext);
      await runAnomalyDetection(emitInstrumentation, maps, instrumentContext);

      return {
        output: state.finalOutput.trim(),
        sessionId: latestSessionId ?? sessionId,
        promptSuggestions: state.promptSuggestions,
        resultSummary: state.resultSummary ?? undefined,
      };
    } catch (error) {
      if (stream) {
        try {
          await stream.interrupt();
        } catch {
          // Best effort.
        }
        try {
          stream.close();
        } catch {
          // Best effort.
        }
      }

      if (allowModelFallback && shouldRetryWithNativeClaudeCliModel({
        model: requestedModel,
        providerApiKey,
        providerBaseUrl,
        recentDiagnostics: state.recentDiagnostics,
        finalOutput: state.finalOutput,
        startedToolCount: maps.startedToolUseIds.size,
      })) {
        return runAttempt(resolveNativeClaudeCliModel(requestedModel), false);
      }

      if (state.finalOutput.trim().length > 0 && maps.startedToolUseIds.size === 0) {
        throw new Error(state.finalOutput.trim(), { cause: error instanceof Error ? error : undefined });
      }

      throw withClaudeSetupHint(error, recentStderr, state.recentDiagnostics, claudeExecutable);
    } finally {
      if (stream) {
        try {
          stream.close();
        } catch {
          // Best effort.
        }
      }
    }
  }

  return runAttempt(initialRequestedModel, true);
};
