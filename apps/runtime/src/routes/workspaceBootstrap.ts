import type { FastifyInstance } from "fastify";
import {
  GitStatusSchema,
  WorkspaceStartupBootstrapQuerySchema,
  type ChatThread,
  type GitStatus,
  type Repository,
  type Worktree,
} from "@codesymphony/shared-types";
import { appendRuntimeDebugLog } from "./debug.js";
import { getCachedWorktreeGitStatus } from "../services/worktreeGitQueryCache.js";
import { isOperationalWorktreeStatus } from "../services/worktreeService.js";

async function listThreadsForBootstrap(
  app: FastifyInstance,
  worktreeId: string,
): Promise<{ threads: ChatThread[]; threadsLoaded: boolean }> {
  try {
    return {
      threads: await app.chatService.listThreads(worktreeId),
      threadsLoaded: true,
    };
  } catch {
    return {
      threads: [],
      threadsLoaded: false,
    };
  }
}

async function getGitStatusForBootstrap(worktree: Worktree | null): Promise<GitStatus | null> {
  if (!worktree || !isOperationalWorktreeStatus(worktree.status)) {
    return null;
  }

  try {
    return GitStatusSchema.parse(await getCachedWorktreeGitStatus(worktree.id, worktree.path));
  } catch {
    return null;
  }
}

async function listRepositoriesForBootstrap(app: FastifyInstance): Promise<Repository[] | null> {
  try {
    return await app.repositoryService.list();
  } catch {
    return null;
  }
}

export async function registerWorkspaceBootstrapRoutes(app: FastifyInstance) {
  app.get("/workspace/bootstrap", async (request) => {
    const query = WorkspaceStartupBootstrapQuerySchema.parse(request.query);
    const startedAt = Date.now();

    const thread = query.threadId
      ? await app.chatService.getThreadById(query.threadId)
      : null;

    const resolvedWorktreeId = thread?.worktreeId ?? query.worktreeId ?? null;
    const worktree = resolvedWorktreeId
      ? await app.worktreeService.getById(resolvedWorktreeId)
      : null;

    const resolvedRepositoryId = worktree?.repositoryId ?? query.repositoryId ?? null;
    const repository = resolvedRepositoryId
      ? await app.repositoryService.getById(resolvedRepositoryId)
      : null;

    const [repositories, threadResult, gitStatus] = await Promise.all([
      listRepositoriesForBootstrap(app),
      worktree
        ? listThreadsForBootstrap(app, worktree.id)
        : Promise.resolve({ threads: [], threadsLoaded: false }),
      getGitStatusForBootstrap(worktree),
    ]);
    const { threads, threadsLoaded } = threadResult;
    const selectedThread = thread ?? threads.find((candidate) => candidate.preferred === true) ?? null;

    const durationMs = Date.now() - startedAt;
    if (durationMs >= 250) {
      appendRuntimeDebugLog({
        source: "runtime.workspace",
        message: "workspace.bootstrap.slow",
        data: {
          requestedRepositoryId: query.repositoryId ?? null,
          requestedWorktreeId: query.worktreeId ?? null,
          requestedThreadId: query.threadId ?? null,
          resolvedRepositoryId: repository?.id ?? null,
          resolvedWorktreeId: worktree?.id ?? null,
          resolvedThreadId: selectedThread?.id ?? null,
          durationMs,
          threadsCount: threads.length,
          threadsLoaded,
          gitStatusPresent: gitStatus != null,
        },
      });
    }

    return {
      data: {
        selection: {
          repositoryId: repository?.id ?? null,
          worktreeId: worktree?.id ?? null,
          threadId: selectedThread?.id ?? null,
        },
        repositories: repositories ?? undefined,
        repository,
        worktree,
        threads,
        threadsLoaded,
        thread: selectedThread,
        gitStatus,
        capturedAt: new Date().toISOString(),
      },
    };
  });
}
