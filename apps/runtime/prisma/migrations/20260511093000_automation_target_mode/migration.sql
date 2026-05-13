PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

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
    CONSTRAINT "Automation_targetWorktreeId_fkey" FOREIGN KEY ("targetWorktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Automation_modelProviderId_fkey" FOREIGN KEY ("modelProviderId") REFERENCES "ModelProvider" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Automation" (
    "id",
    "repositoryId",
    "targetWorktreeId",
    "targetMode",
    "name",
    "prompt",
    "agent",
    "model",
    "modelProviderId",
    "permissionMode",
    "chatMode",
    "enabled",
    "rrule",
    "timezone",
    "dtstart",
    "nextRunAt",
    "lastRunAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "repositoryId",
    "targetWorktreeId",
    'repo_root',
    "name",
    "prompt",
    "agent",
    "model",
    "modelProviderId",
    'full_access',
    "chatMode",
    "enabled",
    "rrule",
    "timezone",
    "dtstart",
    "nextRunAt",
    "lastRunAt",
    "createdAt",
    "updatedAt"
FROM "Automation";

DROP TABLE "Automation";
ALTER TABLE "new_Automation" RENAME TO "Automation";

CREATE INDEX "Automation_repositoryId_idx" ON "Automation"("repositoryId");
CREATE INDEX "Automation_targetWorktreeId_idx" ON "Automation"("targetWorktreeId");
CREATE INDEX "Automation_enabled_nextRunAt_idx" ON "Automation"("enabled", "nextRunAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
