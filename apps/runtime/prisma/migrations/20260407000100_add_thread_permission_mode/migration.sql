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
    "claudeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatThread" ("claudeSessionId", "createdAt", "id", "kind", "mode", "permissionProfile", "title", "titleEditedManually", "updatedAt", "worktreeId")
SELECT "claudeSessionId", "createdAt", "id", "kind", "mode", "permissionProfile", "title", "titleEditedManually", "updatedAt", "worktreeId" FROM "ChatThread";
DROP TABLE "ChatThread";
ALTER TABLE "new_ChatThread" RENAME TO "ChatThread";
CREATE INDEX "ChatThread_worktreeId_idx" ON "ChatThread"("worktreeId");
CREATE INDEX "ChatThread_worktreeId_kind_createdAt_idx" ON "ChatThread"("worktreeId", "kind", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
