-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'default',
    "permissionProfile" TEXT NOT NULL DEFAULT 'default',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "mode" TEXT NOT NULL DEFAULT 'default',
    "titleEditedManually" BOOLEAN NOT NULL DEFAULT false,
    "agent" TEXT NOT NULL DEFAULT 'claude',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "modelProviderId" TEXT,
    "claudeSessionId" TEXT,
    "codexSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatThread_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ChatThread" ("claudeSessionId", "createdAt", "id", "kind", "mode", "permissionMode", "permissionProfile", "title", "titleEditedManually", "updatedAt", "worktreeId") SELECT "claudeSessionId", "createdAt", "id", "kind", "mode", "permissionMode", "permissionProfile", "title", "titleEditedManually", "updatedAt", "worktreeId" FROM "ChatThread";
DROP TABLE "ChatThread";
ALTER TABLE "new_ChatThread" RENAME TO "ChatThread";
CREATE INDEX "ChatThread_worktreeId_idx" ON "ChatThread"("worktreeId");
CREATE INDEX "ChatThread_worktreeId_kind_createdAt_idx" ON "ChatThread"("worktreeId", "kind", "createdAt");
CREATE INDEX "ChatThread_modelProviderId_idx" ON "ChatThread"("modelProviderId");
CREATE TABLE "new_ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent" TEXT NOT NULL DEFAULT 'claude',
    "name" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ModelProvider" ("apiKey", "baseUrl", "createdAt", "id", "isActive", "modelId", "name", "updatedAt") SELECT "apiKey", "baseUrl", "createdAt", "id", "isActive", "modelId", "name", "updatedAt" FROM "ModelProvider";
DROP TABLE "ModelProvider";
ALTER TABLE "new_ModelProvider" RENAME TO "ModelProvider";
CREATE INDEX "ModelProvider_agent_isActive_idx" ON "ModelProvider"("agent", "isActive");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
