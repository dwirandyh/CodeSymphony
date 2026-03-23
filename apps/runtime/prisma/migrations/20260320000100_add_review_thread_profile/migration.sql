-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ChatThread" ADD COLUMN "permissionProfile" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "ChatThread_worktreeId_kind_createdAt_idx" ON "ChatThread"("worktreeId", "kind", "createdAt");
