import type { PrismaClient } from "@prisma/client";
import type {
  AutomationRun,
  GitStatus,
  RepositoryReviewState,
  WorkspaceLiveResourceEvent,
  WorkspaceLiveResourceKind,
  WorkspaceSyncEvent,
} from "@codesymphony/shared-types";
import { getCachedWorktreeGitStatus } from "./worktreeGitQueryCache.js";
import { getUnavailableWorktreeErrorMessage } from "./worktreeService.js";

type WorkspaceLiveListener<TEvent extends WorkspaceLiveResourceEvent = WorkspaceLiveResourceEvent> = (event: TEvent) => void;

type RepositoryServiceAdapter = {
  listBranches: (id: string) => Promise<string[]>;
};

type ReviewServiceAdapter = {
  getRepositoryReviews: (repositoryId: string) => Promise<RepositoryReviewState>;
};

type AutomationRunSnapshotRecord = Omit<AutomationRun, "status" | "triggerKind"> & {
  status: string;
  triggerKind: string;
};

type AutomationServiceAdapter = {
  listRuns: (automationId: string) => Promise<AutomationRunSnapshotRecord[]>;
};

type WorkspaceEventHubAdapter = {
  subscribe: (listener: (event: WorkspaceSyncEvent) => void) => () => void;
};

type ChannelOptions<TSnapshot, TEvent extends WorkspaceLiveResourceEvent> = {
  fetchSnapshot: () => Promise<TSnapshot>;
  pollIntervalMs?: number;
  resource: TEvent["resource"];
  scopeId: string;
};

type ChannelState<TSnapshot, TEvent extends WorkspaceLiveResourceEvent> = {
  current: TEvent | null;
  currentSerialized: string | null;
  inFlight: Promise<TEvent> | null;
  listeners: Set<WorkspaceLiveListener<TEvent>>;
  nextSeq: number;
  options: ChannelOptions<TSnapshot, TEvent>;
  poller: ReturnType<typeof setInterval> | null;
  replayBuffer: TEvent[];
};

type GitStatusLiveEvent = Extract<WorkspaceLiveResourceEvent, { resource: "git_status" }>;
type RepositoryBranchesLiveEvent = Extract<WorkspaceLiveResourceEvent, { resource: "repository_branches" }>;
type RepositoryReviewsLiveEvent = Extract<WorkspaceLiveResourceEvent, { resource: "repository_reviews" }>;
type AutomationRunsLiveEvent = Extract<WorkspaceLiveResourceEvent, { resource: "automation_runs" }>;

const REPLAY_BUFFER_LIMIT = 25;
const GIT_STATUS_POLL_INTERVAL_MS = 60_000;
const REPOSITORY_BRANCHES_POLL_INTERVAL_MS = 60_000;
const REPOSITORY_REVIEWS_POLL_INTERVAL_MS = 30_000;
const AUTOMATION_RUNS_POLL_INTERVAL_MS = 15_000;

function channelHasSubscribers(channel: { listeners: { size: number } }): boolean {
  return channel.listeners.size > 0;
}

function shouldRefreshRepositoryBranches(event: WorkspaceSyncEvent): boolean {
  return !!event.repositoryId && (
    event.type === "repository.created"
    || event.type === "repository.updated"
    || event.type === "worktree.created"
    || event.type === "worktree.updated"
    || event.type === "worktree.deletion_started"
    || event.type === "worktree.deletion_failed"
    || event.type === "worktree.deleted"
  );
}

function shouldRefreshRepositoryReviews(event: WorkspaceSyncEvent): boolean {
  return !!event.repositoryId && (
    event.type === "repository.created"
    || event.type === "repository.updated"
    || event.type === "worktree.created"
    || event.type === "worktree.updated"
    || event.type === "worktree.deletion_started"
    || event.type === "worktree.deletion_failed"
    || event.type === "worktree.deleted"
    || event.type === "thread.created"
    || event.type === "thread.updated"
  );
}

function shouldRefreshAutomationRuns(event: WorkspaceSyncEvent): boolean {
  return !!event.automationId && (
    event.type === "automation.created"
    || event.type === "automation.updated"
    || event.type === "automation.run.updated"
  );
}

function createLiveEvent<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
  options: {
    resource: WorkspaceLiveResourceKind;
    scopeId: string;
    seq: number;
    snapshot: TSnapshot;
  },
): TEvent {
  return {
    resource: options.resource,
    scopeId: options.scopeId,
    seq: options.seq,
    snapshot: options.snapshot,
    emittedAt: new Date().toISOString(),
  } as unknown as TEvent;
}

export function createWorkspaceLiveUpdateService(deps: {
  prisma: PrismaClient;
  workspaceEventHub: WorkspaceEventHubAdapter;
  repositoryService: RepositoryServiceAdapter;
  reviewService: ReviewServiceAdapter;
  automationService: AutomationServiceAdapter;
}) {
  const channels = new Map<string, ChannelState<unknown, WorkspaceLiveResourceEvent>>();

  function ensureChannel<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    options: ChannelOptions<TSnapshot, TEvent>,
  ): ChannelState<TSnapshot, TEvent> {
    const existing = channels.get(key);
    if (existing) {
      (existing as unknown as ChannelState<TSnapshot, TEvent>).options = options;
      return existing as unknown as ChannelState<TSnapshot, TEvent>;
    }

    const created: ChannelState<TSnapshot, TEvent> = {
      current: null,
      currentSerialized: null,
      inFlight: null,
      listeners: new Set(),
      nextSeq: 1,
      options,
      poller: null,
      replayBuffer: [],
    };
    channels.set(key, created as unknown as ChannelState<unknown, WorkspaceLiveResourceEvent>);
    return created;
  }

  function pushReplayEvent<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    channel: ChannelState<TSnapshot, TEvent>,
    event: TEvent,
  ) {
    channel.replayBuffer.push(event);
    if (channel.replayBuffer.length > REPLAY_BUFFER_LIMIT) {
      channel.replayBuffer.splice(0, channel.replayBuffer.length - REPLAY_BUFFER_LIMIT);
    }
  }

  async function publishSnapshot<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    options: ChannelOptions<TSnapshot, TEvent>,
  ): Promise<TEvent> {
    const channel = ensureChannel(key, options);
    if (channel.inFlight) {
      return channel.inFlight;
    }

    const task = options.fetchSnapshot()
      .then((snapshot) => {
        const serialized = JSON.stringify(snapshot);
        if (channel.current && channel.currentSerialized === serialized) {
          return channel.current;
        }

        const nextEvent = createLiveEvent<TSnapshot, TEvent>({
          resource: options.resource,
          scopeId: options.scopeId,
          seq: channel.nextSeq,
          snapshot,
        });
        channel.nextSeq += 1;
        channel.current = nextEvent;
        channel.currentSerialized = serialized;
        pushReplayEvent(channel, nextEvent);
        for (const listener of [...channel.listeners]) {
          listener(nextEvent);
        }
        return nextEvent;
      })
      .finally(() => {
        channel.inFlight = null;
      });

    channel.inFlight = task;
    return task;
  }

  async function materializeEventsSince<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    options: ChannelOptions<TSnapshot, TEvent>,
    afterSeq?: number,
  ): Promise<TEvent[]> {
    const channel = ensureChannel(key, options);
    if (typeof afterSeq === "number") {
      const replay = channel.replayBuffer.filter((event) => event.seq > afterSeq);
      if (replay.length > 0) {
        return replay;
      }
      if (channel.current && channel.current.seq > afterSeq) {
        return [channel.current];
      }
    }

    const current = await publishSnapshot(key, options);
    return [current];
  }

  function startPollerIfNeeded<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    channel: ChannelState<TSnapshot, TEvent>,
  ) {
    if (channel.poller || channel.options.pollIntervalMs == null || !channelHasSubscribers(channel)) {
      return;
    }

    channel.poller = setInterval(() => {
      void publishSnapshot(key, channel.options).catch(() => {});
    }, channel.options.pollIntervalMs);
  }

  function stopPollerIfIdle<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    channel: ChannelState<TSnapshot, TEvent>,
  ) {
    if (channelHasSubscribers(channel) || channel.poller == null) {
      return;
    }

    clearInterval(channel.poller);
    channel.poller = null;
  }

  function subscribeToChannel<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    options: ChannelOptions<TSnapshot, TEvent>,
    listener: WorkspaceLiveListener<TEvent>,
  ): () => void {
    const channel = ensureChannel(key, options);
    channel.listeners.add(listener);
    startPollerIfNeeded(key, channel);

    return () => {
      channel.listeners.delete(listener);
      stopPollerIfIdle(channel);
    };
  }

  function refreshIfSubscribed<TSnapshot, TEvent extends WorkspaceLiveResourceEvent>(
    key: string,
    options: ChannelOptions<TSnapshot, TEvent>,
  ) {
    const channel = ensureChannel(key, options);
    if (!channelHasSubscribers(channel)) {
      return;
    }
    void publishSnapshot(key, options).catch(() => {});
  }

  async function readOperationalWorktree(worktreeId: string) {
    const worktree = await deps.prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: {
        id: true,
        path: true,
        status: true,
        lastCreateError: true,
      },
    });

    if (!worktree) {
      throw new Error("Worktree not found");
    }

    if (worktree.status !== "active") {
      throw new Error(getUnavailableWorktreeErrorMessage(worktree));
    }

    return worktree;
  }

  function gitStatusChannelKey(worktreeId: string) {
    return `git_status:${worktreeId}`;
  }

  function repositoryBranchesChannelKey(repositoryId: string) {
    return `repository_branches:${repositoryId}`;
  }

  function repositoryReviewsChannelKey(repositoryId: string) {
    return `repository_reviews:${repositoryId}`;
  }

  function automationRunsChannelKey(automationId: string) {
    return `automation_runs:${automationId}`;
  }

  function gitStatusChannelOptions(worktreeId: string): ChannelOptions<GitStatus, GitStatusLiveEvent> {
    return {
      resource: "git_status",
      scopeId: worktreeId,
      pollIntervalMs: GIT_STATUS_POLL_INTERVAL_MS,
      fetchSnapshot: async () => {
        const worktree = await readOperationalWorktree(worktreeId);
        return await getCachedWorktreeGitStatus(worktree.id, worktree.path) as GitStatus;
      },
    };
  }

  function repositoryBranchesChannelOptions(repositoryId: string): ChannelOptions<string[], RepositoryBranchesLiveEvent> {
    return {
      resource: "repository_branches",
      scopeId: repositoryId,
      pollIntervalMs: REPOSITORY_BRANCHES_POLL_INTERVAL_MS,
      fetchSnapshot: () => deps.repositoryService.listBranches(repositoryId),
    };
  }

  function repositoryReviewsChannelOptions(repositoryId: string): ChannelOptions<RepositoryReviewState, RepositoryReviewsLiveEvent> {
    return {
      resource: "repository_reviews",
      scopeId: repositoryId,
      pollIntervalMs: REPOSITORY_REVIEWS_POLL_INTERVAL_MS,
      fetchSnapshot: () => deps.reviewService.getRepositoryReviews(repositoryId),
    };
  }

  function automationRunsChannelOptions(automationId: string): ChannelOptions<AutomationRun[], AutomationRunsLiveEvent> {
    return {
      resource: "automation_runs",
      scopeId: automationId,
      pollIntervalMs: AUTOMATION_RUNS_POLL_INTERVAL_MS,
      fetchSnapshot: async () => await deps.automationService.listRuns(automationId) as AutomationRun[],
    };
  }

  const unsubscribeWorkspaceEvents = deps.workspaceEventHub.subscribe((event) => {
    if (event.worktreeId && (event.type === "worktree.git.updated" || event.type === "worktree.updated")) {
      refreshIfSubscribed(gitStatusChannelKey(event.worktreeId), gitStatusChannelOptions(event.worktreeId));
    }

    if (event.repositoryId && shouldRefreshRepositoryBranches(event)) {
      refreshIfSubscribed(
        repositoryBranchesChannelKey(event.repositoryId),
        repositoryBranchesChannelOptions(event.repositoryId),
      );
    }

    if (event.repositoryId && shouldRefreshRepositoryReviews(event)) {
      refreshIfSubscribed(
        repositoryReviewsChannelKey(event.repositoryId),
        repositoryReviewsChannelOptions(event.repositoryId),
      );
    }

    if (event.automationId && shouldRefreshAutomationRuns(event)) {
      refreshIfSubscribed(
        automationRunsChannelKey(event.automationId),
        automationRunsChannelOptions(event.automationId),
      );
    }
  });

  function dispose() {
    unsubscribeWorkspaceEvents();
    for (const channel of channels.values()) {
      if (channel.poller) {
        clearInterval(channel.poller);
        channel.poller = null;
      }
      channel.listeners.clear();
    }
  }

  return {
    dispose,
    listGitStatusEvents(worktreeId: string, afterSeq?: number) {
      return materializeEventsSince(gitStatusChannelKey(worktreeId), gitStatusChannelOptions(worktreeId), afterSeq);
    },
    subscribeToGitStatus(worktreeId: string, listener: WorkspaceLiveListener<GitStatusLiveEvent>) {
      return subscribeToChannel(gitStatusChannelKey(worktreeId), gitStatusChannelOptions(worktreeId), listener);
    },
    listRepositoryBranchesEvents(repositoryId: string, afterSeq?: number) {
      return materializeEventsSince(
        repositoryBranchesChannelKey(repositoryId),
        repositoryBranchesChannelOptions(repositoryId),
        afterSeq,
      );
    },
    subscribeToRepositoryBranches(repositoryId: string, listener: WorkspaceLiveListener<RepositoryBranchesLiveEvent>) {
      return subscribeToChannel(
        repositoryBranchesChannelKey(repositoryId),
        repositoryBranchesChannelOptions(repositoryId),
        listener,
      );
    },
    listRepositoryReviewsEvents(repositoryId: string, afterSeq?: number) {
      return materializeEventsSince(
        repositoryReviewsChannelKey(repositoryId),
        repositoryReviewsChannelOptions(repositoryId),
        afterSeq,
      );
    },
    subscribeToRepositoryReviews(repositoryId: string, listener: WorkspaceLiveListener<RepositoryReviewsLiveEvent>) {
      return subscribeToChannel(
        repositoryReviewsChannelKey(repositoryId),
        repositoryReviewsChannelOptions(repositoryId),
        listener,
      );
    },
    listAutomationRunsEvents(automationId: string, afterSeq?: number) {
      return materializeEventsSince(
        automationRunsChannelKey(automationId),
        automationRunsChannelOptions(automationId),
        afterSeq,
      );
    },
    subscribeToAutomationRuns(automationId: string, listener: WorkspaceLiveListener<AutomationRunsLiveEvent>) {
      return subscribeToChannel(
        automationRunsChannelKey(automationId),
        automationRunsChannelOptions(automationId),
        listener,
      );
    },
  };
}
