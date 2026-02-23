/*
  Warnings:

  - You are about to drop the column `providerApiKey` on the `ChatThread` table. All the data in the column will be lost.
  - You are about to drop the column `providerBaseUrl` on the `ChatThread` table. All the data in the column will be lost.
  - You are about to drop the column `providerModelId` on the `ChatThread` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ChatThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "claudeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatThread_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ChatThread" ("claudeSessionId", "createdAt", "id", "title", "updatedAt", "worktreeId") SELECT "claudeSessionId", "createdAt", "id", "title", "updatedAt", "worktreeId" FROM "ChatThread";
DROP TABLE "ChatThread";
ALTER TABLE "new_ChatThread" RENAME TO "ChatThread";
CREATE INDEX "ChatThread_worktreeId_idx" ON "ChatThread"("worktreeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
