import type {
  AnswerQuestionInput,
  ChatEvent,
  ChatMessage,
  ChatThread,
  CreateChatThreadInput,
  CreateRepositoryInput,
  CreateWorktreeInput,
  FileEntry,
  GitCommitInput,
  GitDiff,
  GitStatus,
  OpenWorktreeFileInput,
  PlanRevisionInput,
  RenameWorktreeBranchInput,
  ResolvePermissionInput,
  Repository,
  SendChatMessageInput,
  Worktree,
} from "@codesymphony/shared-types";

const DEFAULT_RUNTIME_URL =
  typeof window === "undefined"
    ? "http://127.0.0.1:4321/api"
    : `${window.location.protocol}//${window.location.hostname}:4321/api`;

const API_BASE = import.meta.env.VITE_RUNTIME_URL ?? DEFAULT_RUNTIME_URL;

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
  createWorktree: (repositoryId: string, input: CreateWorktreeInput = {}) =>
    request<Worktree>(`/repositories/${repositoryId}/worktrees`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteWorktree: async (worktreeId: string) => {
    const response = await fetch(`${API_BASE}/worktrees/${worktreeId}`, {
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
  listThreads: (worktreeId: string) => request<ChatThread[]>(`/worktrees/${worktreeId}/threads`),
  createThread: (worktreeId: string, input: CreateChatThreadInput = {}) =>
    request<ChatThread>(`/worktrees/${worktreeId}/threads`, {
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
};
