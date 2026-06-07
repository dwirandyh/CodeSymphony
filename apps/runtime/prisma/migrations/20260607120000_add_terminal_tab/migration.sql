-- CreateTable
CREATE TABLE "TerminalTab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worktreeId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalTab_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TerminalTab_sessionId_key" ON "TerminalTab"("sessionId");

-- CreateIndex
CREATE INDEX "TerminalTab_worktreeId_idx" ON "TerminalTab"("worktreeId");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalTab_worktreeId_ordinal_key" ON "TerminalTab"("worktreeId", "ordinal");
