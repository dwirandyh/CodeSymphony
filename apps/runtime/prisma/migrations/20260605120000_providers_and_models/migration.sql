-- Normalize custom providers into providers with one compatibility and many models.
-- Existing custom provider rows are intentionally reset instead of migrated.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Superseded dev migration (provider_connections_models) may have created these tables.
DROP TABLE IF EXISTS "ModelProviderConnection";
DROP TABLE IF EXISTS "ModelProviderModel";

UPDATE "ChatThread"
SET "model" = CASE "agent"
    WHEN 'codex' THEN 'gpt-5.4'
    WHEN 'cursor' THEN 'default[]'
    WHEN 'opencode' THEN 'opencode/minimax-m2.5-free'
    ELSE 'claude-sonnet-4-6'
  END
WHERE "modelProviderId" IS NOT NULL;

UPDATE "Automation"
SET "model" = CASE "agent"
    WHEN 'codex' THEN 'gpt-5.4'
    WHEN 'cursor' THEN 'default[]'
    WHEN 'opencode' THEN 'opencode/minimax-m2.5-free'
    ELSE 'claude-sonnet-4-6'
  END
WHERE "modelProviderId" IS NOT NULL;

CREATE TABLE "new_ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'default',
    "isAutomation" BOOLEAN NOT NULL DEFAULT false,
    "permissionProfile" TEXT NOT NULL DEFAULT 'default',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "mode" TEXT NOT NULL DEFAULT 'default',
    "titleEditedManually" BOOLEAN NOT NULL DEFAULT false,
    "agent" TEXT NOT NULL DEFAULT 'claude',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "modelProviderId" TEXT,
    "pendingPlanEventId" TEXT,
    "pendingPlanFilePath" TEXT,
    "pendingPlanContent" TEXT,
    "handoffSourceThreadId" TEXT,
    "handoffSourcePlanEventId" TEXT,
    "claudeSessionId" TEXT,
    "codexSessionId" TEXT,
    "cursorSessionId" TEXT,
    "opencodeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatThread" ("id", "worktreeId", "title", "kind", "isAutomation", "permissionProfile", "permissionMode", "mode", "titleEditedManually", "agent", "model", "modelProviderId", "pendingPlanEventId", "pendingPlanFilePath", "pendingPlanContent", "handoffSourceThreadId", "handoffSourcePlanEventId", "claudeSessionId", "codexSessionId", "cursorSessionId", "opencodeSessionId", "createdAt", "updatedAt")
SELECT "id", "worktreeId", "title", "kind", "isAutomation", "permissionProfile", "permissionMode", "mode", "titleEditedManually", "agent", "model", NULL, "pendingPlanEventId", "pendingPlanFilePath", "pendingPlanContent", "handoffSourceThreadId", "handoffSourcePlanEventId", "claudeSessionId", "codexSessionId", "cursorSessionId", "opencodeSessionId", "createdAt", "updatedAt" FROM "ChatThread";
DROP TABLE "ChatThread";
ALTER TABLE "new_ChatThread" RENAME TO "ChatThread";
CREATE INDEX "ChatThread_worktreeId_idx" ON "ChatThread"("worktreeId");
CREATE INDEX "ChatThread_worktreeId_kind_createdAt_idx" ON "ChatThread"("worktreeId", "kind", "createdAt");
CREATE INDEX "ChatThread_modelProviderId_idx" ON "ChatThread"("modelProviderId");

CREATE TABLE "new_Automation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "targetWorktreeId" TEXT NOT NULL,
    "targetMode" TEXT NOT NULL DEFAULT 'repo_root',
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "agent" TEXT NOT NULL DEFAULT 'claude',
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    "modelProviderId" TEXT,
    "permissionMode" TEXT NOT NULL DEFAULT 'full_access',
    "chatMode" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rrule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "dtstart" DATETIME NOT NULL,
    "nextRunAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Automation_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Automation_targetWorktreeId_fkey" FOREIGN KEY ("targetWorktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Automation" ("id", "repositoryId", "targetWorktreeId", "targetMode", "name", "prompt", "agent", "model", "modelProviderId", "permissionMode", "chatMode", "enabled", "rrule", "timezone", "dtstart", "nextRunAt", "lastRunAt", "createdAt", "updatedAt")
SELECT "id", "repositoryId", "targetWorktreeId", "targetMode", "name", "prompt", "agent", "model", NULL, "permissionMode", "chatMode", "enabled", "rrule", "timezone", "dtstart", "nextRunAt", "lastRunAt", "createdAt", "updatedAt" FROM "Automation";
DROP TABLE "Automation";
ALTER TABLE "new_Automation" RENAME TO "Automation";
CREATE INDEX "Automation_repositoryId_idx" ON "Automation"("repositoryId");
CREATE INDEX "Automation_targetWorktreeId_idx" ON "Automation"("targetWorktreeId");
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");

DROP TABLE "ModelProvider";
CREATE TABLE "ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "compatibility" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "ModelProviderModel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelProviderModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ModelProvider_compatibility_idx" ON "ModelProvider"("compatibility");
CREATE UNIQUE INDEX "ModelProviderModel_providerId_modelId_key" ON "ModelProviderModel"("providerId", "modelId");
CREATE INDEX "ModelProviderModel_providerId_idx" ON "ModelProviderModel"("providerId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
