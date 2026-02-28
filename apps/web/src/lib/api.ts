import type {
  AnswerQuestionInput,
  ChatEvent,
  ChatMessage,
  ChatThread,
  CreateChatThreadInput,
  CreateModelProviderInput,
  CreateRepositoryInput,
  CreateWorktreeInput,
  ExternalApp,
  FileEntry,
  FilesystemBrowseResponse,
  GitCommitInput,
  GitDiff,
  GitStatus,
  ModelProvider,
  OpenInAppInput,
  OpenWorktreeFileInput,
  PlanRevisionInput,
  RenameWorktreeBranchInput,
  ResolvePermissionInput,
  Repository,
  ScriptResult,
  SendChatMessageInput,
  UpdateModelProviderInput,
  UpdateRepositoryScriptsInput,
  Worktree,
} from "@codesymphony/shared-types";
import { resolveRuntimeApiBase } from "./runtimeUrl";

const API_BASE = resolveRuntimeApiBase();

export class TeardownFailedError extends Error {
  public readonly output: string;
  constructor(output: string) {
    super("Teardown scripts failed");
    this.name = "TeardownFailedError";
    this.output = output;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${API_BASE}${path}`, {
    headers,
    ...init,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? "Request failed");
  }

  return payload.data as T;
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
  deleteRepository: async (repositoryId: string) => {
    const response = await fetch(`${API_BASE}/repositories/${repositoryId}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete repository");
    }
  },
  createWorktree: async (repositoryId: string, input: CreateWorktreeInput = {}): Promise<{ worktree: Worktree; scriptResult?: ScriptResult }> => {
    const response = await fetch(`${API_BASE}/repositories/${repositoryId}/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to create worktree");
    }

    return { worktree: payload.data as Worktree, scriptResult: payload.scriptResult as ScriptResult | undefined };
  },
  deleteWorktree: async (worktreeId: string, options?: { force?: boolean }) => {
    const query = options?.force ? "?force=true" : "";
    const response = await fetch(`${API_BASE}/worktrees/${worktreeId}${query}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && payload?.output) {
        throw new TeardownFailedError(payload.output);
      }
      throw new Error(payload?.error ?? "Failed to delete worktree");
    }
  },
  getWorktree: (id: string) => request<Worktree>(`/worktrees/${id}`),
  renameWorktreeBranch: (worktreeId: string, input: RenameWorktreeBranchInput) =>
    request<Worktree>(`/worktrees/${worktreeId}/branch`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  rerunSetupScripts: (worktreeId: string) =>
    request<ScriptResult>(`/worktrees/${worktreeId}/run-setup`, {
      method: "POST",
    }),
  runSetupStream: (worktreeId: string): EventSource =>
    new EventSource(`${API_BASE}/worktrees/${worktreeId}/run-setup/stream`),
  stopSetupScript: async (worktreeId: string): Promise<void> => {
    await fetch(`${API_BASE}/worktrees/${worktreeId}/run-setup/stop`, {
      method: "POST",
    });
  },
  runScriptStream: (worktreeId: string, cmd?: string): EventSource => {
    const params = cmd ? `?cmd=${encodeURIComponent(cmd)}` : "";
    return new EventSource(`${API_BASE}/worktrees/${worktreeId}/run-script/stream${params}`);
  },
  stopRunScript: async (worktreeId: string): Promise<void> => {
    await fetch(`${API_BASE}/worktrees/${worktreeId}/run-script/stop`, {
      method: "POST",
    });
  },
  runTerminalCommand: async (input: { sessionId: string; command: string; cwd?: string; mode?: "stdin" | "exec" }): Promise<void> => {
    const response = await fetch(`${API_BASE}/terminal/run`, {
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
    const response = await fetch(`${API_BASE}/terminal/interrupt`, {
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
  createRepositoryThread: (repositoryId: string, input: CreateChatThreadInput = {}) =>
    request<ChatThread>(`/repositories/${repositoryId}/threads`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getThread: (id: string) => request<ChatThread>(`/threads/${id}`),
  deleteThread: async (threadId: string) => {
    const response = await fetch(`${API_BASE}/threads/${threadId}`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to delete thread");
    }
  },
  listMessages: (threadId: string) => request<ChatMessage[]>(`/threads/${threadId}/messages`),
  sendMessage: (threadId: string, input: SendChatMessageInput) =>
    request<ChatMessage>(`/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  stopRun: async (threadId: string) => {
    const response = await fetch(`${API_BASE}/threads/${threadId}/stop`, {
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
    const response = await fetch(`${API_BASE}/threads/${threadId}/questions/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to answer question");
    }
  },
  resolvePermission: async (threadId: string, input: ResolvePermissionInput) => {
    const response = await fetch(`${API_BASE}/threads/${threadId}/permissions/resolve`, {
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
  approvePlan: async (threadId: string) => {
    const response = await fetch(`${API_BASE}/threads/${threadId}/plan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to approve plan");
    }
  },
  revisePlan: async (threadId: string, input: PlanRevisionInput) => {
    const response = await fetch(`${API_BASE}/threads/${threadId}/plan/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to revise plan");
    }
  },
  listEvents: (threadId: string) => request<ChatEvent[]>(`/threads/${threadId}/events`),
  getGitStatus: (worktreeId: string) =>
    request<GitStatus>(`/worktrees/${worktreeId}/git/status`),
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
  discardGitChange: async (worktreeId: string, filePath: string) => {
    const response = await fetch(`${API_BASE}/worktrees/${worktreeId}/git/discard`, {
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
  openWorktreeFile: async (worktreeId: string, input: OpenWorktreeFileInput) => {
    const response = await fetch(`${API_BASE}/worktrees/${worktreeId}/files/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to open file");
    }
  },
  runtimeBaseUrl: API_BASE.replace(/\/api$/, ""),
  browseFilesystem: (path?: string) => {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    return request<FilesystemBrowseResponse>(`/filesystem/browse${params}`);
  },
  getInstalledApps: () =>
    request<{ apps: ExternalApp[] }>("/system/installed-apps").then((r) => r.apps),
  openInApp: async (input: OpenInAppInput) => {
    const response = await fetch(`${API_BASE}/system/open-in-app`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to open in app");
    }
  },

  // ── Model Providers ──

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
    const response = await fetch(`${API_BASE}/model-providers/${id}`, {
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
    const response = await fetch(`${API_BASE}/model-providers/deactivate`, {
      method: "POST",
    });
    if (!response.ok && response.status !== 204) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error ?? "Failed to deactivate providers");
    }
  },
  testModelProvider: (input: { baseUrl: string; apiKey: string; modelId: string }) =>
    request<{ success: boolean; error?: string }>("/model-providers/test", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
