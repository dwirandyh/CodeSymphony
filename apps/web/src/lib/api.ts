import type {
  ApprovePlanInput,
  ApprovePlanResult,
  AnswerQuestionInput,
  ChatEvent,
  ChatMessage,
  ChatQueuedMessage,
  ChatThread,
  ChatThreadSnapshot,
  ChatThreadStatusSnapshot,
  ChatTimelineSnapshot,
  CliAgent,
  ClipboardText,
  CreateChatThreadInput,
  CreateModelProviderInput,
  CreateRepositoryInput,
  CreateWorktreeResult,
  CreateWorktreeInput,
  CursorModelCatalog,
  DeviceInventorySnapshot,
  DeviceStreamSession,
  DismissQuestionInput,
  UpdateChatThreadAgentSelectionInput,
  UpdateChatThreadPermissionModeInput,
  UpdateChatThreadModeInput,
  ExternalApp,
  FileEntry,
  FilesystemBrowseResponse,
  FilesystemReadAttachmentsResponse,
  GitBranchDiffSummary,
  GitCommitInput,
  GitDiff,
  GitStatus,
  RepositoryReviewState,
  ModelProvider,
  OpenInAppInput,
  OpencodeModelCatalog,
  OpenWorktreeFileInput,
  PlanRevisionInput,
  QueueChatMessageInput,
  SlashCommandCatalog,
  RenameChatThreadTitleInput,
  RenameWorktreeBranchInput,
  ResolvePermissionInput,
  UpdateQueuedMessageInput,
  Repository,
  ScriptResult,
  SendDeviceControlInput,
  SendChatMessageInput,
  StartDeviceStreamInput,
  StopDeviceStreamInput,
  TestModelProviderInput,
  UpdateAndroidClipboardInput,
  UpdateWorktreeFileContentInput,
  UpdateModelProviderInput,
  UpdateRepositoryScriptsInput,
  UpdateWorktreeBaseBranchInput,
  WorktreeFileContent,
  Worktree,
} from "@codesymphony/shared-types";
import { resolveRuntimeApiBases } from "./runtimeUrl";
import { logService } from "./logService";
import { debugLog } from "./debugLog";

const DEFAULT_API_BASE = "http://127.0.0.1:4331/api";
const RETRY_DELAYS_MS = [150, 400];

let activeApiBase: string | null = null;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getConfiguredApiBases(): string[] {
  const resolved = resolveRuntimeApiBases();
  return resolved.length > 0 ? resolved : [DEFAULT_API_BASE];
}

function getCandidateApiBases(): string[] {
  const configuredBases = getConfiguredApiBases();
  const preferredBase = activeApiBase && configuredBases.includes(activeApiBase)
    ? activeApiBase
    : (configuredBases[0] ?? DEFAULT_API_BASE);

  activeApiBase = preferredBase;

  return [preferredBase, ...configuredBases.filter((base) => base !== preferredBase)];
}

function toApiUrl(apiBase: string, path: string): string {
  return `${apiBase}${path}`;
}

function toRuntimeUnavailableError(cause: unknown): Error {
  const triedBases = getCandidateApiBases().join(", ");
  const error = new Error(
    `Runtime API unavailable. Tried ${triedBases}. Start runtime with "pnpm dev:runtime" or set VITE_RUNTIME_URL.`,
  );
  if (cause instanceof Error && cause.stack) {
    error.stack = cause.stack;
  }
  return error;
}

async function runtimeFetch(path: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null;

  for (const apiBase of getCandidateApiBases()) {
    const url = toApiUrl(apiBase, path);

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if (activeApiBase !== apiBase) {
          activeApiBase = apiBase;
        }
        return response;
      } catch (error) {
        // Abort errors should propagate as-is.
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }

        lastError = error;

        logService.log("warn", "runtime.fetch", "Runtime fetch failed", {
          apiBase,
          path,
          method: init?.method ?? "GET",
          attempt: attempt + 1,
          maxAttempts: RETRY_DELAYS_MS.length + 1,
          error: error instanceof Error ? error.message : String(error),
        });

        const retryDelay = RETRY_DELAYS_MS[attempt];
        if (retryDelay == null) {
          break;
        }

        await wait(retryDelay);
      }
    }
  }

  throw toRuntimeUnavailableError(lastError);
}

function createEventSource(path: string): EventSource {
  return new EventSource(toApiUrl(getCandidateApiBases()[0] ?? DEFAULT_API_BASE, path));
}

async function readResponseDebugInfo(response: Response): Promise<{
  url: string;
  status: number;
  contentType: string | null;
  bodyPreview: string | null;
}> {
  const headers = response.headers as { get?: (name: string) => string | null } | undefined;
  const contentType = typeof headers?.get === "function" ? headers.get("content-type") : null;
  let bodyPreview: string | null = null;

  try {
    const clone = response.clone as (() => { text: () => Promise<string> }) | undefined;
    if (typeof clone === "function") {
      bodyPreview = (await clone.call(response).text()).slice(0, 400);
    }
  } catch {
    bodyPreview = null;
  }

  return {
    url: typeof response.url === "string" ? response.url : "unknown",
    status: typeof response.status === "number" ? response.status : 0,
    contentType,
    bodyPreview,
  };
}

function formatUnexpectedResponseShapeError(debug: {
  url: string;
  status: number;
  contentType: string | null;
  bodyPreview: string | null;
}): Error {
  const details = [
    `url=${debug.url || "unknown"}`,
    `status=${debug.status}`,
    `content-type=${debug.contentType ?? "unknown"}`,
  ];
  if (debug.bodyPreview && debug.bodyPreview.length > 0) {
    details.push(`body=${JSON.stringify(debug.bodyPreview)}`);
  }
  return new Error(`Runtime returned an unexpected response shape (${details.join(", ")})`);
}

function extractDataEnvelope<T>(payload: unknown, debug?: {
  url: string;
  status: number;
  contentType: string | null;
  bodyPreview: string | null;
}): T {
  if (payload != null && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  throw formatUnexpectedResponseShapeError(debug ?? {
    url: "unknown",
    status: 200,
    contentType: null,
    bodyPreview: null,
  });
}

export type RuntimeListenAddress =
  | {
    kind: "pipe";
    value: string;
  }
  | {
    kind: "tcp";
    value: string;
    family: string;
    port: number;
  };

export type RuntimeInfo = {
  pid: number;
  cwd: string;
  nodeVersion: string;
  runtimeHost: string | null;
  runtimePort: number | null;
  uptimeSec: number;
  database: {
    urlKind: string | null;
    resolvedPath: string | null;
    urlPreview: string | null;
  };
  listenAddress: RuntimeListenAddress | null;
  codexCliProviderOverride?: {
    configPath: string;
    providerId: string;
    providerName: string;
    baseUrl: string | null;
    model: string | null;
    wireApi: string | null;
  } | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await runtimeFetch(path, {
    headers,
    ...init,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? "Request failed");
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    return extractDataEnvelope<T>(payload);
  }

  const debug = await readResponseDebugInfo(response);
  return extractDataEnvelope<T>(payload, debug);
}


export const api = {
  pickDirectory: () => request<{ path: string }>("/system/pick-directory", { method: "POST" }),
  listRepositories: () => request<Repository[]>("/repositories"),
  getRepository: (id: string) => request<Repository>(`/repositories/${id}`),
  createRepository: (input: CreateRepositoryInput) =>
    request<Repository>("/repositories", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateRepositoryScripts: (id: string, input: UpdateRepositoryScriptsInput) =>
    request<Repository>(`/repositories/${id}/scripts`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  listBranches: (repositoryId: string) =>
    request<string[]>(`/repositories/${repositoryId}/branches`),
  getRepositoryReviews: (repositoryId: string) =>
    request<RepositoryReviewState>(`/repositories/${repositoryId}/reviews`),
  getOrCreatePrMrThread: (worktreeId: string, input: CreateChatThreadInput = {}) =>
    request<ChatThread>(`/worktrees/${worktreeId}/pr-mr-thread`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteRepository: async (repositoryId: string) => {
    const response = await runtimeFetch(`/repositories/${repositoryId}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete repository");
    }
  },
  createWorktree: async (repositoryId: string, input: CreateWorktreeInput = {}): Promise<CreateWorktreeResult> => {
    const response = await runtimeFetch(`/repositories/${repositoryId}/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to create worktree");
    }

    return extractDataEnvelope<CreateWorktreeResult>(payload);
  },
  deleteWorktree: async (worktreeId: string, options?: { force?: boolean }) => {
    const query = options?.force ? "?force=true" : "";
    const response = await runtimeFetch(`/worktrees/${worktreeId}${query}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete worktree");
    }
  },
  getWorktree: (id: string) => request<Worktree>(`/worktrees/${id}`),
  renameWorktreeBranch: (worktreeId: string, input: RenameWorktreeBranchInput) =>
    request<Worktree>(`/worktrees/${worktreeId}/branch`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateWorktreeBaseBranch: (worktreeId: string, input: UpdateWorktreeBaseBranchInput) =>
    request<Worktree>(`/worktrees/${worktreeId}/base-branch`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  rerunSetupScripts: (worktreeId: string) =>
    request<ScriptResult>(`/worktrees/${worktreeId}/run-setup`, {
      method: "POST",
    }),
  runSetupStream: (worktreeId: string): EventSource =>
    createEventSource(`/worktrees/${worktreeId}/run-setup/stream`),
  stopSetupScript: async (worktreeId: string): Promise<void> => {
    await runtimeFetch(`/worktrees/${worktreeId}/run-setup/stop`, {
      method: "POST",
    });
  },
  runTerminalCommand: async (input: { sessionId: string; command: string; cwd?: string; mode?: "stdin" | "exec" }): Promise<void> => {
    const response = await runtimeFetch("/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to run terminal command");
    }
  },
  interruptTerminalSession: async (sessionId: string): Promise<void> => {
    const response = await runtimeFetch("/terminal/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to stop terminal command");
    }
  },
  listThreads: (worktreeId: string) => request<ChatThread[]>(`/worktrees/${worktreeId}/threads`),
  createThread: (worktreeId: string, input: CreateChatThreadInput = {}) =>
    request<ChatThread>(`/worktrees/${worktreeId}/threads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getThread: (id: string) => request<ChatThread>(`/threads/${id}`),
  renameThreadTitle: (threadId: string, input: RenameChatThreadTitleInput) =>
    request<ChatThread>(`/threads/${threadId}/title`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateThreadMode: (threadId: string, input: UpdateChatThreadModeInput) =>
    request<ChatThread>(`/threads/${threadId}/mode`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateThreadPermissionMode: (threadId: string, input: UpdateChatThreadPermissionModeInput) =>
    request<ChatThread>(`/threads/${threadId}/permission-mode`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateThreadAgentSelection: (threadId: string, input: UpdateChatThreadAgentSelectionInput) =>
    request<ChatThread>(`/threads/${threadId}/agent-selection`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteThread: async (threadId: string) => {
    const response = await runtimeFetch(`/threads/${threadId}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete thread");
    }
  },
  listMessages: (threadId: string) =>
    request<ChatMessage[]>(`/threads/${threadId}/messages`),
  listEvents: (threadId: string) =>
    request<ChatEvent[]>(`/threads/${threadId}/events`),
  getThreadSnapshot: (threadId: string) =>
    request<ChatThreadSnapshot>(`/threads/${threadId}/snapshot`),
  getThreadStatusSnapshot: (threadId: string) =>
    request<ChatThreadStatusSnapshot>(`/threads/${threadId}/status-snapshot`),
  getTimelineSnapshot: (threadId: string) => {
    const path = `/threads/${threadId}/timeline`;
    const startedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

    debugLog("thread.timeline.api", "timeline.request.started", {
      threadId,
      path,
    });

    return request<ChatTimelineSnapshot>(path)
      .then((snapshot) => {
        const endedAt =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        debugLog("thread.timeline.api", "timeline.request.succeeded", {
          threadId,
          path,
          durationMs: Math.round((endedAt - startedAt) * 10) / 10,
          messagesCount: snapshot.messages.length,
          eventsCount: snapshot.events.length,
          timelineItemsCount: snapshot.timelineItems.length,
          newestSeq: snapshot.newestSeq,
          newestIdx: snapshot.newestIdx,
          oldestRenderableHydrationPending: snapshot.summary.oldestRenderableHydrationPending ?? false,
        });
        return snapshot;
      })
      .catch((error) => {
        const endedAt =
          typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now();
        debugLog("thread.timeline.api", "timeline.request.failed", {
          threadId,
          path,
          durationMs: Math.round((endedAt - startedAt) * 10) / 10,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  },
  sendMessage: (threadId: string, input: SendChatMessageInput) =>
    request<ChatMessage>(`/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listQueuedMessages: (threadId: string) =>
    request<ChatQueuedMessage[]>(`/threads/${threadId}/queue`),
  queueMessage: (threadId: string, input: QueueChatMessageInput) =>
    request<ChatQueuedMessage>(`/threads/${threadId}/queue`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateQueuedMessage: (threadId: string, queueMessageId: string, input: UpdateQueuedMessageInput) =>
    request<ChatQueuedMessage>(`/threads/${threadId}/queue/${queueMessageId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteQueuedMessage: async (threadId: string, queueMessageId: string) => {
    const response = await runtimeFetch(`/threads/${threadId}/queue/${queueMessageId}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete queued message");
    }
  },
  requestQueuedMessageDispatch: (threadId: string, queueMessageId: string) =>
    request<ChatQueuedMessage>(`/threads/${threadId}/queue/${queueMessageId}/dispatch`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  stopRun: async (threadId: string) => {
    const response = await runtimeFetch(`/threads/${threadId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to stop run");
    }
  },
  answerQuestion: async (threadId: string, input: AnswerQuestionInput) => {
    const response = await runtimeFetch(`/threads/${threadId}/questions/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to answer question");
    }
  },
  dismissQuestion: async (threadId: string, input: DismissQuestionInput) => {
    const response = await runtimeFetch(`/threads/${threadId}/questions/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to dismiss question");
    }
  },
  resolvePermission: async (threadId: string, input: ResolvePermissionInput) => {
    const response = await runtimeFetch(`/threads/${threadId}/permissions/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to resolve permission");
    }
  },
  approvePlan: async (threadId: string, input?: ApprovePlanInput): Promise<ApprovePlanResult> => {
    const response = await runtimeFetch(`/threads/${threadId}/plan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to approve plan");
    }

    const payload = await response.json().catch(() => null);
    return payload?.data;
  },
  dismissPlan: async (threadId: string) => {
    const response = await runtimeFetch(`/threads/${threadId}/plan/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to dismiss plan");
    }
  },
  revisePlan: async (threadId: string, input: PlanRevisionInput) => {
    const response = await runtimeFetch(`/threads/${threadId}/plan/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to revise plan");
    }
  },
  getGitStatus: (worktreeId: string) =>
    request<GitStatus>(`/worktrees/${worktreeId}/git/status`),
  getGitBranchDiffSummary: (worktreeId: string) =>
    request<GitBranchDiffSummary>(`/worktrees/${worktreeId}/git/branch-diff-summary`),
  getGitDiff: (worktreeId: string, opts?: { filePath?: string }) => {
    const params = opts?.filePath ? `?filePath=${encodeURIComponent(opts.filePath)}` : "";
    return request<GitDiff>(`/worktrees/${worktreeId}/git/diff${params}`);
  },
  getFileContents: (worktreeId: string, filePath: string) => {
    const params = `?path=${encodeURIComponent(filePath)}`;
    return request<{ oldContent: string | null; newContent: string | null }>(
      `/worktrees/${worktreeId}/git/file-contents${params}`
    );
  },
  gitCommit: (worktreeId: string, input: GitCommitInput) =>
    request<{ result: string }>(`/worktrees/${worktreeId}/git/commit`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  gitSync: (worktreeId: string) =>
    request<{ result: string }>(`/worktrees/${worktreeId}/git/sync`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  discardGitChange: async (worktreeId: string, filePath: string) => {
    const response = await runtimeFetch(`/worktrees/${worktreeId}/git/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to discard change");
    }
  },
  searchFiles: (worktreeId: string, query: string, signal?: AbortSignal) =>
    request<FileEntry[]>(`/worktrees/${worktreeId}/files?q=${encodeURIComponent(query)}`, { signal }),
  getFileIndex: (worktreeId: string, signal?: AbortSignal) =>
    request<FileEntry[]>(`/worktrees/${worktreeId}/files/index`, { signal }),
  getWorktreeDirectoryEntries: (worktreeId: string, directoryPath?: string, signal?: AbortSignal) => {
    const params = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
    return request<FileEntry[]>(`/worktrees/${worktreeId}/files/tree${params}`, { signal });
  },
  getSlashCommands: (worktreeId: string, agent: CliAgent, signal?: AbortSignal) =>
    request<SlashCommandCatalog>(`/worktrees/${worktreeId}/slash-commands?agent=${encodeURIComponent(agent)}`, { signal }),
  getWorktreeFileContent: (worktreeId: string, filePath: string, signal?: AbortSignal) => {
    const params = `?path=${encodeURIComponent(filePath)}`;
    return request<WorktreeFileContent>(`/worktrees/${worktreeId}/files/content${params}`, { signal });
  },
  saveWorktreeFileContent: (worktreeId: string, input: UpdateWorktreeFileContentInput) =>
    request<WorktreeFileContent>(`/worktrees/${worktreeId}/files/content`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  openWorktreeFile: async (worktreeId: string, input: OpenWorktreeFileInput) => {
    const response = await runtimeFetch(`/worktrees/${worktreeId}/files/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to open file");
    }
  },
  get runtimeBaseUrl() {
    return (activeApiBase ?? getCandidateApiBases()[0] ?? DEFAULT_API_BASE).replace(/\/api$/, "");
  },
  getRuntimeInfo: () => request<RuntimeInfo>("/debug/runtime-info"),
  browseFilesystem: (path?: string) => {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    return request<FilesystemBrowseResponse>(`/filesystem/browse${params}`);
  },
  readLocalAttachments: (paths: string[]) =>
    request<FilesystemReadAttachmentsResponse>("/filesystem/attachments/read", {
      method: "POST",
      body: JSON.stringify({ paths }),
    }).then((response) => response.attachments),
  getInstalledApps: () =>
    request<{ apps: ExternalApp[] }>("/system/installed-apps").then((r) => r.apps),
  readHostClipboard: () =>
    request<ClipboardText>("/system/clipboard").then((response) => response.text),
  writeHostClipboard: async (text: string): Promise<void> => {
    const response = await runtimeFetch("/system/clipboard", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to write the host clipboard");
    }
  },
  openInApp: async (input: OpenInAppInput) => {
    const response = await runtimeFetch("/system/open-in-app", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to open in app");
    }
  },
  getDevices: () => request<DeviceInventorySnapshot>("/devices"),
  streamDevices: () => createEventSource("/devices/stream"),
  startDeviceStream: (deviceId: string, input: StartDeviceStreamInput = {}) =>
    request<DeviceStreamSession>(`/devices/${encodeURIComponent(deviceId)}/stream/start`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  stopDeviceStream: async (input: StopDeviceStreamInput): Promise<void> => {
    const response = await runtimeFetch("/device-streams/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to stop device stream");
    }
  },
  sendDeviceControl: async (sessionId: string, input: SendDeviceControlInput): Promise<void> => {
    const response = await runtimeFetch(`/device-streams/${encodeURIComponent(sessionId)}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to send device control");
    }
  },
  readAndroidClipboard: (sessionId: string) =>
    request<ClipboardText>(`/device-streams/${encodeURIComponent(sessionId)}/android/clipboard`).then((response) => response.text),
  writeAndroidClipboard: async (sessionId: string, input: UpdateAndroidClipboardInput): Promise<void> => {
    const response = await runtimeFetch(`/device-streams/${encodeURIComponent(sessionId)}/android/clipboard`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to write the Android clipboard");
    }
  },

  // ── Model Providers ──

  listOpencodeModels: () => request<OpencodeModelCatalog>("/opencode/models"),
  listCursorModels: () => request<CursorModelCatalog>("/cursor/models"),
  listModelProviders: () => request<ModelProvider[]>("/model-providers"),
  createModelProvider: (input: CreateModelProviderInput) =>
    request<ModelProvider>("/model-providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateModelProvider: (id: string, input: UpdateModelProviderInput) =>
    request<ModelProvider>(`/model-providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteModelProvider: async (id: string) => {
    const response = await runtimeFetch(`/model-providers/${id}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete provider");
    }
  },
  activateModelProvider: (id: string) =>
    request<ModelProvider>(`/model-providers/${id}/activate`, {
      method: "POST",
    }),
  deactivateAllProviders: async () => {
    const response = await runtimeFetch("/model-providers/deactivate", {
      method: "POST",
    });
    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to deactivate providers");
    }
  },
  testModelProvider: (input: TestModelProviderInput) =>
    request<{ success: boolean; error?: string }>("/model-providers/test", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
