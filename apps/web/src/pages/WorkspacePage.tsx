import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, ChatMessage, ChatThread, Repository } from "@codesymphony/shared-types";
import { Composer } from "../components/workspace/Composer";
import { ChatMessageList, type AssistantRenderHint, type ChatTimelineItem } from "../components/workspace/ChatMessageList";
import { RepositoryPanel } from "../components/workspace/RepositoryPanel";
import { WorkspaceHeader } from "../components/workspace/WorkspaceHeader";
import { api } from "../lib/api";
import { pushRenderDebug } from "../lib/renderDebug";

const EVENT_TYPES = [
  "message.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "chat.completed",
  "chat.failed",
] as const;

const INLINE_TOOL_EVENT_TYPES = new Set<ChatEvent["type"]>(["tool.started", "tool.output", "tool.finished", "chat.failed"]);
const MAX_ORDER_INDEX = Number.MAX_SAFE_INTEGER;
const READ_TOOL_PATTERN = /\b(read|open|cat)\b/i;
const READ_PROMPT_PATTERN =
  /\b(read|open|show|cat|display|view|find|locate|buka\w*|lihat\w*|isi\w*|lengkap|full|ulang|repeat|cari\w*|temu\w*|kasih\s*tau)\b/i;
const FILE_PATH_PATTERN = /(?:[~./\w-]+\/)?[\w.-]+\.[a-z0-9]{1,10}\b|readme(?:\.md)?\b/gi;
const TRIM_FILE_TOKEN_PATTERN = /^[`"'([{<\s]+|[`"',.;:)\]}>/\\\s]+$/g;

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

function parseTimestamp(input: string): number | null {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function getEventMessageId(event: ChatEvent): string | null {
  if (event.type !== "message.delta") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

function getCompletedMessageId(event: ChatEvent): string | null {
  if (event.type !== "chat.completed") {
    return null;
  }

  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

function eventPayloadText(event: ChatEvent): string {
  return JSON.stringify(event.payload ?? {}).toLowerCase();
}

function isReadToolEvent(event: ChatEvent): boolean {
  if (event.type === "chat.failed") {
    return false;
  }

  return READ_TOOL_PATTERN.test(eventPayloadText(event));
}

function extractFirstFilePath(text: string): string | null {
  const matches = text.match(FILE_PATH_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }

  for (const match of matches) {
    const candidate = match.replace(TRIM_FILE_TOKEN_PATTERN, "").trim();
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

function promptLooksLikeFileRead(prompt: string): boolean {
  return READ_PROMPT_PATTERN.test(prompt) && extractFirstFilePath(prompt) != null;
}

function inferLanguageFromPath(filePath: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const normalizedPath = filePath.toLowerCase().split(/[?#]/, 1)[0];
  if (normalizedPath.endsWith("readme") || normalizedPath.endsWith("readme.md")) {
    return "md";
  }

  const lastDot = normalizedPath.lastIndexOf(".");
  if (lastDot < 0 || lastDot === normalizedPath.length - 1) {
    return undefined;
  }

  return normalizedPath.slice(lastDot + 1);
}

function inferRawFileLanguage(context: ChatEvent[], prompt: string): string {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const event = context[index];
    if (!isReadToolEvent(event)) {
      continue;
    }

    const pathFromEvent = extractFirstFilePath(JSON.stringify(event.payload ?? {}));
    const language = inferLanguageFromPath(pathFromEvent);
    if (language) {
      return language;
    }
  }

  const pathFromPrompt = extractFirstFilePath(prompt);
  return inferLanguageFromPath(pathFromPrompt) ?? "text";
}

function hasUnclosedCodeFence(content: string): boolean {
  const fenceCount = (content.match(/(^|\n)```/g) ?? []).length;
  return fenceCount % 2 !== 0;
}

function isLikelyDiffContent(content: string): boolean {
  return /^(diff --git|---\s|\+\+\+\s|@@\s)/m.test(content);
}

export function WorkspacePage() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);

  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(null);
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("");

  const [loadingRepos, setLoadingRepos] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [submittingWorktree, setSubmittingWorktree] = useState(false);
  const [closingThreadId, setClosingThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenEventIdsByThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const lastEventIdxByThreadRef = useRef<Map<string, number>>(new Map());
  const streamingMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFileMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFallbackMessageIdsRef = useRef<Set<string>>(new Set());
  const stickyRawFileLanguageByMessageIdRef = useRef<Map<string, string>>(new Map());
  const renderDecisionByMessageIdRef = useRef<Map<string, string>>(new Map());

  function ensureSeenEventIds(threadId: string): Set<string> {
    const existing = seenEventIdsByThreadRef.current.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Set<string>();
    seenEventIdsByThreadRef.current.set(threadId, created);
    return created;
  }

  function updateLastEventIdx(threadId: string, idx: number) {
    const current = lastEventIdxByThreadRef.current.get(threadId);
    if (current == null || idx > current) {
      lastEventIdxByThreadRef.current.set(threadId, idx);
    }
  }

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
    pushRenderDebug({
      source: "WorkspacePage",
      event: "loadThreadData",
      details: {
        threadId,
        messages: threadMessages.length,
        events: threadEvents.length,
      },
    });

    const seenEventIds = new Set<string>();
    let lastIdx: number | null = null;
    for (const event of threadEvents) {
      seenEventIds.add(event.id);
      if (lastIdx == null || event.idx > lastIdx) {
        lastIdx = event.idx;
      }
    }

    seenEventIdsByThreadRef.current.set(threadId, seenEventIds);
    if (lastIdx == null) {
      lastEventIdxByThreadRef.current.delete(threadId);
    } else {
      lastEventIdxByThreadRef.current.set(threadId, lastIdx);
    }
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
      streamingMessageIdsRef.current = new Set();
      stickyRawFileMessageIdsRef.current = new Set();
      stickyRawFallbackMessageIdsRef.current = new Set();
      stickyRawFileLanguageByMessageIdRef.current = new Map();
      setMessages([]);
      setEvents([]);
      return;
    }

    streamingMessageIdsRef.current = new Set();
    stickyRawFileMessageIdsRef.current = new Set();
    stickyRawFallbackMessageIdsRef.current = new Set();
    stickyRawFileLanguageByMessageIdRef.current = new Map();

    let disposed = false;
    let stream: EventSource | null = null;

    void (async () => {
      try {
        await loadThreadData(selectedThreadId);
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load thread");
        }
        return;
      }

      if (disposed) {
        return;
      }

      const streamUrl = new URL(`${api.runtimeBaseUrl}/api/threads/${selectedThreadId}/events/stream`);
      const lastEventIdx = lastEventIdxByThreadRef.current.get(selectedThreadId);
      if (typeof lastEventIdx === "number") {
        streamUrl.searchParams.set("afterIdx", String(lastEventIdx));
      }

      stream = new EventSource(streamUrl.toString());

      const onEvent = (rawEvent: MessageEvent<string>) => {
        if (disposed) {
          return;
        }

        const payload = JSON.parse(rawEvent.data) as ChatEvent;
        const seenEventIds = ensureSeenEventIds(selectedThreadId);
        if (seenEventIds.has(payload.id)) {
          pushRenderDebug({
            source: "WorkspacePage",
            event: "streamEventSkippedDuplicate",
            messageId: String(payload.payload.messageId ?? ""),
            details: {
              eventId: payload.id,
              type: payload.type,
              idx: payload.idx,
            },
          });
          return;
        }

        seenEventIds.add(payload.id);
        updateLastEventIdx(selectedThreadId, payload.idx);
        pushRenderDebug({
          source: "WorkspacePage",
          event: "streamEventAccepted",
          messageId: String(payload.payload.messageId ?? ""),
          details: {
            eventId: payload.id,
            type: payload.type,
            idx: payload.idx,
          },
        });

        setEvents((current) => [...current, payload].sort((a, b) => a.idx - b.idx));

        if (payload.type === "message.delta") {
          const messageId = String(payload.payload.messageId ?? "");
          const role =
            payload.payload.role === "assistant" || payload.payload.role === "user" ? payload.payload.role : "assistant";
          const delta = String(payload.payload.delta ?? "");
          pushRenderDebug({
            source: "WorkspacePage",
            event: "messageDelta",
            messageId,
            details: {
              role,
              deltaLength: delta.length,
              idx: payload.idx,
            },
          });

          if (messageId.length === 0) {
            return;
          }

          if (role === "assistant") {
            streamingMessageIdsRef.current.add(messageId);
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
          const completedMessageId = String(payload.payload.messageId ?? "");
          if (completedMessageId.length > 0) {
            streamingMessageIdsRef.current.delete(completedMessageId);
          }
          pushRenderDebug({
            source: "WorkspacePage",
            event: "chatCompleted",
            messageId: completedMessageId,
            details: { idx: payload.idx },
          });
          void loadThreadData(selectedThreadId);
        }
      };

      for (const eventType of EVENT_TYPES) {
        stream.addEventListener(eventType, onEvent as EventListener);
      }

      stream.onerror = () => {
        if (!disposed && stream && stream.readyState === EventSource.CLOSED) {
          setError("Lost connection to chat stream");
        }
      };
    })();

    return () => {
      disposed = true;
      stream?.close();
    };
  }, [selectedThreadId]);

  async function attachRepository() {
    setSubmittingRepo(true);
    setError(null);

    try {
      let path = "";

      try {
        const picked = await api.pickDirectory();
        path = picked.path.trim();
      } catch {
        const manualPath =
          typeof window === "undefined"
            ? null
            : window.prompt("Enter the repository path on the runtime machine", "");
        path = manualPath?.trim() ?? "";
      }

      if (!path) {
        return;
      }

      await api.createRepository({
        path,
      });
      await loadRepositories();
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Failed to add repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function submitWorktree(repositoryId: string) {
    setSubmittingWorktree(true);
    setError(null);

    try {
      const created = await api.createWorktree(repositoryId);

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
      setThreads((current) => {
        const exists = current.some((thread) => thread.id === created.id);
        if (exists) {
          return current;
        }

        return [...current, created];
      });
      setSelectedThreadId(created.id);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Failed to create thread");
    }
  }

  async function closeThread(threadId: string) {
    setError(null);
    setClosingThreadId(threadId);

    try {
      await api.deleteThread(threadId);
      setThreads((current) => {
        const updated = current.filter((thread) => thread.id !== threadId);

        if (selectedThreadId === threadId) {
          const nextThreadId = updated[0]?.id ?? null;
          setSelectedThreadId(nextThreadId);

          if (!nextThreadId) {
            setMessages([]);
            setEvents([]);
          }
        }

        return updated;
      });
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Failed to close session");
    } finally {
      setClosingThreadId(null);
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

  const timelineItems = useMemo<ChatTimelineItem[]>(() => {
    const orderedEventsByIdx = [...events].sort((a, b) => a.idx - b.idx);

    const firstMessageEventIdxById = new Map<string, number>();
    const completedMessageIds = new Set<string>();
    for (const event of orderedEventsByIdx) {
      const messageId = getEventMessageId(event);
      if (messageId) {
        const currentIdx = firstMessageEventIdxById.get(messageId);
        if (currentIdx == null || event.idx < currentIdx) {
          firstMessageEventIdxById.set(messageId, event.idx);
        }
      }

      const completedId = getCompletedMessageId(event);
      if (completedId) {
        completedMessageIds.add(completedId);
      }
    }

    const sortedMessages = [...messages].sort((a, b) => a.seq - b.seq);
    const latestUserPromptByAssistantId = new Map<string, string>();
    let latestUserPrompt = "";
    for (const message of sortedMessages) {
      if (message.role === "user") {
        latestUserPrompt = message.content;
        continue;
      }

      if (message.role === "assistant") {
        latestUserPromptByAssistantId.set(message.id, latestUserPrompt);
      }
    }

    const inlineToolEvents = orderedEventsByIdx.filter((event) => INLINE_TOOL_EVENT_TYPES.has(event.type));
    const assistantContextById = new Map<string, ChatEvent[]>();
    let previousAssistantBoundaryIdx = -1;
    let previousAssistantBoundaryTime: number | null = null;
    for (const message of sortedMessages) {
      if (message.role !== "assistant") {
        continue;
      }

      const anchorIdx = firstMessageEventIdxById.get(message.id) ?? MAX_ORDER_INDEX;
      const messageTimestamp = parseTimestamp(message.createdAt);
      const context = inlineToolEvents.filter((event) => {
        if (event.idx <= previousAssistantBoundaryIdx) {
          return false;
        }

        if (anchorIdx !== MAX_ORDER_INDEX) {
          return event.idx <= anchorIdx;
        }

        const eventTimestamp = parseTimestamp(event.createdAt);
        if (messageTimestamp == null || eventTimestamp == null) {
          return true;
        }

        const afterPreviousBoundary =
          previousAssistantBoundaryTime == null ? true : eventTimestamp > previousAssistantBoundaryTime;
        return afterPreviousBoundary && eventTimestamp <= messageTimestamp;
      });

      assistantContextById.set(message.id, context);
      if (anchorIdx !== MAX_ORDER_INDEX) {
        previousAssistantBoundaryIdx = anchorIdx;
      }
      if (messageTimestamp != null) {
        previousAssistantBoundaryTime = messageTimestamp;
      }
    }

    const sortable = [
      ...messages.map((message) => {
        const anchorIdx = firstMessageEventIdxById.get(message.id) ?? MAX_ORDER_INDEX;
        const timestamp = parseTimestamp(message.createdAt);
        const context = message.role === "assistant" ? assistantContextById.get(message.id) ?? [] : [];
        const nearestUserPrompt = latestUserPromptByAssistantId.get(message.id) ?? "";
        const hasReadContext = context.some((event) => isReadToolEvent(event));
        const looksLikeFileRead = promptLooksLikeFileRead(nearestUserPrompt);
        const shouldRenderRawFileNow = hasReadContext || looksLikeFileRead;
        const isCompleted = message.role === "assistant" ? completedMessageIds.has(message.id) : false;
        const hasUnclosedFence = message.role === "assistant" ? hasUnclosedCodeFence(message.content) : false;
        if (message.role === "assistant" && shouldRenderRawFileNow) {
          stickyRawFileMessageIdsRef.current.add(message.id);
        }
        if (message.role === "assistant" && !isCompleted && hasUnclosedFence) {
          stickyRawFallbackMessageIdsRef.current.add(message.id);
        }
        if (message.role === "assistant" && isCompleted) {
          stickyRawFallbackMessageIdsRef.current.delete(message.id);
        }
        const shouldRenderRawFile =
          message.role === "assistant" && stickyRawFileMessageIdsRef.current.has(message.id);
        const shouldRenderRawFallback =
          message.role === "assistant" && !isCompleted && stickyRawFallbackMessageIdsRef.current.has(message.id);
        const isStreamingMessage =
          message.role === "assistant" && streamingMessageIdsRef.current.has(message.id) && !isCompleted;
        const inferredLanguage = shouldRenderRawFile ? inferRawFileLanguage(context, nearestUserPrompt) : undefined;
        if (message.role === "assistant" && shouldRenderRawFile && inferredLanguage && inferredLanguage !== "text") {
          stickyRawFileLanguageByMessageIdRef.current.set(message.id, inferredLanguage);
        }
        const stickyLanguage = stickyRawFileLanguageByMessageIdRef.current.get(message.id);
        if (message.role === "assistant") {
          const decisionSignature = [
            shouldRenderRawFileNow ? "now:1" : "now:0",
            shouldRenderRawFile ? "sticky:1" : "sticky:0",
            shouldRenderRawFallback ? "fallback:1" : "fallback:0",
            inferredLanguage ?? "infer:none",
            stickyLanguage ?? "stickyLang:none",
            `ctx:${context.length}`,
            `len:${message.content.length}`,
          ].join("|");
          const previousSignature = renderDecisionByMessageIdRef.current.get(message.id);
          if (decisionSignature !== previousSignature) {
            renderDecisionByMessageIdRef.current.set(message.id, decisionSignature);
            pushRenderDebug({
              source: "WorkspacePage",
              event: "rawFileDecision",
              messageId: message.id,
              details: {
                shouldRenderRawFileNow,
                shouldRenderRawFile,
                inferredLanguage,
                stickyLanguage,
                contextCount: context.length,
                contentLength: message.content.length,
              },
            });
          }
        }
        const renderHint: AssistantRenderHint | undefined =
          message.role === "assistant"
            ? (() => {
                if (isLikelyDiffContent(message.content)) {
                  return "diff";
                }

                if (shouldRenderRawFile) {
                  if (isStreamingMessage) {
                    return "markdown";
                  }
                  return "raw-file";
                }

                if (shouldRenderRawFallback) {
                  if (isStreamingMessage) {
                    return "markdown";
                  }
                  return "raw-fallback";
                }

                return "markdown";
              })()
            : undefined;

        return {
          item: {
            kind: "message" as const,
            message,
            renderHint,
            rawFileLanguage:
              message.role === "assistant" && shouldRenderRawFile
                ? stickyLanguage ?? inferredLanguage
                : undefined,
            isCompleted,
            context,
          },
          anchorIdx,
          timestamp,
          rank: message.role === "assistant" ? 2 : message.role === "user" ? 1 : 3,
          stableOrder: message.seq,
        };
      }),
      ...inlineToolEvents.map((event) => ({
        item: {
          kind: "tool" as const,
          event,
        },
        anchorIdx: event.idx,
        timestamp: parseTimestamp(event.createdAt),
        rank: 0,
        stableOrder: event.idx,
      })),
    ];

    sortable.sort((a, b) => {
      const aTime = a.timestamp ?? MAX_ORDER_INDEX;
      const bTime = b.timestamp ?? MAX_ORDER_INDEX;
      if (aTime !== bTime) {
        return aTime - bTime;
      }

      if (a.anchorIdx !== b.anchorIdx) {
        return a.anchorIdx - b.anchorIdx;
      }

      if (a.rank !== b.rank) {
        return a.rank - b.rank;
      }

      return a.stableOrder - b.stableOrder;
    });

    return sortable.map((entry) => entry.item);
  }, [messages, events]);

  return (
    <div className="h-full p-2 sm:p-3">
      <div className="mx-auto grid h-full max-w-[1860px] grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="min-h-0 border-b border-border/30 p-2 lg:border-b-0 lg:border-r lg:p-3">
          <div className="mb-3">
            <h1 className="text-sm font-semibold tracking-wide">CodeSymphony</h1>
            <p className="text-xs text-muted-foreground">Local code conductor</p>
          </div>

          <RepositoryPanel
            repositories={repositories}
            selectedRepositoryId={selectedRepositoryId}
            selectedWorktreeId={selectedWorktreeId}
            loadingRepos={loadingRepos}
            submittingRepo={submittingRepo}
            submittingWorktree={submittingWorktree}
            onAttachRepository={() => void attachRepository()}
            onSelectRepository={setSelectedRepositoryId}
            onCreateWorktree={(repositoryId) => void submitWorktree(repositoryId)}
            onSelectWorktree={(repositoryId, worktreeId) => {
              setSelectedRepositoryId(repositoryId);
              setSelectedWorktreeId(worktreeId);
            }}
            onDeleteWorktree={(worktreeId) => void removeWorktree(worktreeId)}
          />
        </aside>

        <main className="min-h-0 p-2.5 lg:p-3">
          <div className="flex h-full min-h-0 flex-col gap-2">
            <WorkspaceHeader
              selectedRepositoryName={selectedRepository?.name ?? "No repository selected"}
              selectedWorktreeLabel={selectedWorktree ? `Worktree: ${selectedWorktree.branch}` : "Choose a worktree"}
              threads={threads}
              selectedThreadId={selectedThreadId}
              disabled={!selectedWorktreeId}
              closingThreadId={closingThreadId}
              onSelectThread={setSelectedThreadId}
              onCreateThread={() => void createAdditionalThread()}
              onCloseThread={(threadId) => void closeThread(threadId)}
            />

            {error ? (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-destructive">
                <strong>!</strong> {error}
              </div>
            ) : null}

            <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1">
                <ChatMessageList items={timelineItems} />
              </div>
            </section>

            <Composer
              value={chatInput}
              disabled={!selectedThreadId || sendingMessage}
              sending={sendingMessage}
              onChange={setChatInput}
              onSubmit={() => void submitMessage()}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
