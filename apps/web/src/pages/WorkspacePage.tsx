import { useEffect, useMemo, useState } from "react";
import type { ChatEvent, ChatMessage, ChatThread, Repository } from "@codesymphony/shared-types";
import { api } from "../lib/api";

type RepositoryFormState = {
  path: string;
};

type WorktreeFormState = {
  branch: string;
  baseBranch: string;
};

const EVENT_TYPES = [
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "chat.completed",
  "chat.failed",
] as const;

function findRepositoryByWorktree(repositories: Repository[], worktreeId: string | null): Repository | null {
  if (!worktreeId) {
    return null;
  }

  for (const repository of repositories) {
    if (repository.worktrees.some((worktree) => worktree.id === worktreeId)) {
      return repository;
    }
  }

  return null;
}

export function WorkspacePage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const [repoForm, setRepoForm] = useState<RepositoryFormState>({ path: "" });
  const [worktreeForm, setWorktreeForm] = useState<WorktreeFormState>({ branch: "", baseBranch: "" });
  const [chatInput, setChatInput] = useState("");

  const [loadingRepos, setLoadingRepos] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [submittingWorktree, setSubmittingWorktree] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRepository = useMemo(() => {
    if (selectedRepositoryId) {
      return repositories.find((repository) => repository.id === selectedRepositoryId) ?? null;
    }

    return findRepositoryByWorktree(repositories, selectedWorktreeId);
  }, [repositories, selectedRepositoryId, selectedWorktreeId]);
  const selectedWorktree = useMemo(() => {
    if (!selectedWorktreeId) {
      return null;
    }

    for (const repository of repositories) {
      const found = repository.worktrees.find((worktree) => worktree.id === selectedWorktreeId);
      if (found) {
        return found;
      }
    }

    return null;
  }, [repositories, selectedWorktreeId]);

  async function loadRepositories() {
    setLoadingRepos(true);
    setError(null);

    try {
      const data = await api.listRepositories();
      setRepositories(data);

      if (!selectedRepositoryId && data[0]) {
        setSelectedRepositoryId(data[0].id);
      }

      if (!selectedWorktreeId) {
        const firstWorktree = data[0]?.worktrees[0];
        if (firstWorktree) {
          setSelectedWorktreeId(firstWorktree.id);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load repositories");
    } finally {
      setLoadingRepos(false);
    }
  }

  async function ensureThread(worktreeId: string): Promise<string | null> {
    const existing = await api.listThreads(worktreeId);
    setThreads(existing);

    if (existing.length > 0) {
      return existing[0].id;
    }

    const created = await api.createThread(worktreeId, { title: "Main Thread" });
    setThreads([created]);
    return created.id;
  }

  async function loadThreadData(threadId: string) {
    const [threadMessages, threadEvents] = await Promise.all([api.listMessages(threadId), api.listEvents(threadId)]);
    setMessages(threadMessages);
    setEvents(threadEvents);
  }

  useEffect(() => {
    void loadRepositories();
  }, []);

  useEffect(() => {
    if (!selectedWorktreeId) {
      setThreads([]);
      setSelectedThreadId(null);
      setMessages([]);
      setEvents([]);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const threadId = await ensureThread(selectedWorktreeId);
        if (!threadId || cancelled) {
          return;
        }

        setSelectedThreadId(threadId);
      } catch (threadError) {
        if (!cancelled) {
          setError(threadError instanceof Error ? threadError.message : "Failed to load threads");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedWorktreeId]);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      setEvents([]);
      return;
    }

    let disposed = false;
    const stream = new EventSource(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);

    const onEvent = (rawEvent: MessageEvent<string>) => {
      if (disposed) {
        return;
      }

      const payload = JSON.parse(rawEvent.data) as ChatEvent;

      setEvents((current) => {
        const exists = current.some((event) => event.id === payload.id);
        if (exists) {
          return current;
        }

        return [...current, payload].sort((a, b) => a.idx - b.idx);
      });

      if (payload.type === "message.delta") {
        const messageId = String(payload.payload.messageId ?? "");
        const role = payload.payload.role === "assistant" || payload.payload.role === "user" ? payload.payload.role : "assistant";
        const delta = String(payload.payload.delta ?? "");

        if (messageId.length === 0) {
          return;
        }

        setMessages((current) => {
          const existing = current.find((message) => message.id === messageId);
          if (!existing) {
            return [
              ...current,
              {
                id: messageId,
                threadId: selectedThreadId,
                seq: current.length,
                role,
                content: delta,
                createdAt: new Date().toISOString(),
              },
            ];
          }

          if (role === "user") {
            return current;
          }

          return current.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: message.content + delta,
                }
              : message,
          );
        });
      }

      if (payload.type === "chat.completed") {
        void loadThreadData(selectedThreadId);
      }
    };

    void loadThreadData(selectedThreadId);

    for (const eventType of EVENT_TYPES) {
      stream.addEventListener(eventType, onEvent as EventListener);
    }

    stream.onerror = () => {
      if (!disposed && stream.readyState === EventSource.CLOSED) {
        setError("Lost connection to chat stream");
      }
    };

    return () => {
      disposed = true;
      stream.close();
    };
  }, [selectedThreadId]);

  async function submitRepository() {
    if (!repoForm.path.trim()) {
      setError("Repository path is required");
      return;
    }

    setSubmittingRepo(true);
    setError(null);

    try {
      await api.createRepository({
        path: repoForm.path,
      });
      setRepoForm({ path: "" });
      await loadRepositories();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to add repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function browseDirectory() {
    setError(null);

    try {
      const picked = await api.pickDirectory();
      setRepoForm({ path: picked.path });
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : "Failed to browse directory");
    }
  }

  async function submitWorktree(repositoryId: string) {
    if (!worktreeForm.branch.trim()) {
      setError("Branch name is required");
      return;
    }

    setSubmittingWorktree(true);
    setError(null);

    try {
      const created = await api.createWorktree(repositoryId, {
        branch: worktreeForm.branch,
        baseBranch: worktreeForm.baseBranch.trim() || undefined,
      });

      setWorktreeForm({ branch: "", baseBranch: "" });
      await loadRepositories();
      setSelectedWorktreeId(created.id);
      setSelectedRepositoryId(repositoryId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create worktree");
    } finally {
      setSubmittingWorktree(false);
    }
  }

  async function removeWorktree(worktreeId: string) {
    setError(null);

    try {
      await api.deleteWorktree(worktreeId);
      if (selectedWorktreeId === worktreeId) {
        setSelectedWorktreeId(null);
        setSelectedThreadId(null);
      }
      await loadRepositories();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to delete worktree");
    }
  }

  async function createAdditionalThread() {
    if (!selectedWorktreeId) {
      return;
    }

    setError(null);

    try {
      const created = await api.createThread(selectedWorktreeId, {
        title: `Thread ${threads.length + 1}`,
      });
      const updatedThreads = await api.listThreads(selectedWorktreeId);
      setThreads(updatedThreads);
      setSelectedThreadId(created.id);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Failed to create thread");
    }
  }

  async function submitMessage() {
    if (!selectedThreadId || !chatInput.trim()) {
      return;
    }

    setSendingMessage(true);
    setError(null);

    try {
      await api.sendMessage(selectedThreadId, {
        content: chatInput,
      });
      setChatInput("");
      await loadThreadData(selectedThreadId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Failed to send message");
    } finally {
      setSendingMessage(false);
    }
  }

  const toolEvents = useMemo(
    () => events.filter((event) => event.type.startsWith("tool.") || event.type === "chat.failed"),
    [events],
  );

  return (
    <div className="workspace-layout">
      <aside className="sidebar">
        <h1>CodeSymphony</h1>

        <div className="panel stack">
          <h2>Add Repository</h2>
          <div className="row">
            <input value={repoForm.path} placeholder="No directory selected" readOnly />
            <button type="button" onClick={() => void browseDirectory()}>
              Browse
            </button>
          </div>
          <button type="button" onClick={() => void submitRepository()} disabled={submittingRepo}>
            {submittingRepo ? "Adding..." : "Add Repository"}
          </button>
        </div>

        <div className="panel stack">
          <h2>Repositories</h2>
          {loadingRepos ? <div>Loading...</div> : null}

          <ul className="clean stack">
            {repositories.map((repository) => (
              <li key={repository.id} className="repo-item stack">
                <div>
                  <strong>{repository.name}</strong>
                  <div className="meta">{repository.defaultBranch}</div>
                </div>

                <button type="button" onClick={() => setSelectedRepositoryId(repository.id)}>
                  {selectedRepositoryId === repository.id ? "Selected" : "Select"}
                </button>

                {selectedRepositoryId === repository.id ? (
                  <div className="stack">
                    <input
                      value={worktreeForm.branch}
                      placeholder="new branch"
                      onChange={(event) =>
                        setWorktreeForm((current) => ({
                          ...current,
                          branch: event.target.value,
                        }))
                      }
                    />
                    <input
                      value={worktreeForm.baseBranch}
                      placeholder={`base (default ${repository.defaultBranch})`}
                      onChange={(event) =>
                        setWorktreeForm((current) => ({
                          ...current,
                          baseBranch: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      onClick={() => void submitWorktree(repository.id)}
                      disabled={submittingWorktree}
                    >
                      {submittingWorktree ? "Creating..." : "Create Worktree"}
                    </button>
                  </div>
                ) : null}

                <ul className="clean stack">
                  {repository.worktrees.map((worktree) => (
                    <li key={worktree.id} className="worktree-row">
                      <button
                        type="button"
                        className={selectedWorktreeId === worktree.id ? "selected" : ""}
                        onClick={() => {
                          setSelectedRepositoryId(repository.id);
                          setSelectedWorktreeId(worktree.id);
                        }}
                      >
                        {worktree.branch}
                      </button>
                      <button type="button" className="danger" onClick={() => void removeWorktree(worktree.id)}>
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="main-panel">
        <header className="panel row spread">
          <div>
            <strong>{selectedRepository?.name ?? "No repository selected"}</strong>
            <div className="meta">{selectedWorktree ? `Worktree: ${selectedWorktree.branch}` : "Choose a worktree"}</div>
          </div>

          <div className="row">
            <select
              value={selectedThreadId ?? ""}
              onChange={(event) => setSelectedThreadId(event.target.value || null)}
              disabled={!selectedWorktreeId}
            >
              <option value="">Select thread</option>
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void createAdditionalThread()} disabled={!selectedWorktreeId}>
              New Thread
            </button>
          </div>
        </header>

        {error ? <div className="panel error">Error: {error}</div> : null}

        <section className="panel messages">
          {messages.length === 0 ? (
            <div className="meta">No messages yet. Send a prompt to start.</div>
          ) : (
            messages.map((message) => (
              <article key={message.id} className={`bubble ${message.role}`}>
                <div className="meta">{message.role}</div>
                <pre>{message.content}</pre>
              </article>
            ))
          )}
        </section>

        <section className="panel composer row">
          <textarea
            value={chatInput}
            placeholder="Ask Claude to inspect, edit, or run commands in this worktree"
            onChange={(event) => setChatInput(event.target.value)}
            disabled={!selectedThreadId || sendingMessage}
          />
          <button type="button" onClick={() => void submitMessage()} disabled={!selectedThreadId || sendingMessage}>
            {sendingMessage ? "Sending..." : "Send"}
          </button>
        </section>

        <section className="panel stack">
          <h2>Tool Logs</h2>
          {toolEvents.length === 0 ? (
            <div className="meta">No tool activity yet.</div>
          ) : (
            toolEvents.map((event) => (
              <details key={event.id}>
                <summary>
                  [{event.idx}] {event.type}
                </summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            ))
          )}
        </section>
      </main>
    </div>
  );
}
