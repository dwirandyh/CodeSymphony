DROP TABLE IF EXISTS "RunEvent";
DROP TABLE IF EXISTS "ApprovalDecision";
DROP TABLE IF EXISTS "RunStep";
DROP TABLE IF EXISTS "Run";
DROP TABLE IF EXISTS "WorkflowStep";
DROP TABLE IF EXISTS "Workflow";

CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Worktree" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Worktree_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "claudeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChatEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Repository_rootPath_key" ON "Repository"("rootPath");
CREATE UNIQUE INDEX "Worktree_path_key" ON "Worktree"("path");
CREATE INDEX "Worktree_repositoryId_idx" ON "Worktree"("repositoryId");
CREATE UNIQUE INDEX "Worktree_repositoryId_branch_key" ON "Worktree"("repositoryId", "branch");
CREATE INDEX "ChatThread_worktreeId_idx" ON "ChatThread"("worktreeId");
CREATE INDEX "ChatMessage_threadId_idx" ON "ChatMessage"("threadId");
CREATE UNIQUE INDEX "ChatMessage_threadId_seq_key" ON "ChatMessage"("threadId", "seq");
CREATE INDEX "ChatEvent_threadId_idx" ON "ChatEvent"("threadId");
CREATE UNIQUE INDEX "ChatEvent_threadId_idx_key" ON "ChatEvent"("threadId", "idx");
