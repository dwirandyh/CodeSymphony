-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Worktree" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "branchRenamed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Worktree_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Worktree" ("baseBranch", "branch", "createdAt", "id", "path", "repositoryId", "status", "updatedAt") SELECT "baseBranch", "branch", "createdAt", "id", "path", "repositoryId", "status", "updatedAt" FROM "Worktree";
DROP TABLE "Worktree";
ALTER TABLE "new_Worktree" RENAME TO "Worktree";
CREATE UNIQUE INDEX "Worktree_path_key" ON "Worktree"("path");
CREATE INDEX "Worktree_repositoryId_idx" ON "Worktree"("repositoryId");
CREATE UNIQUE INDEX "Worktree_repositoryId_branch_key" ON "Worktree"("repositoryId", "branch");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
