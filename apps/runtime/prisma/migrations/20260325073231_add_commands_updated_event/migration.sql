ALTER TABLE "ChatEvent" RENAME TO "ChatEvent_old";

CREATE TABLE "ChatEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "ChatEvent" ("id", "threadId", "idx", "type", "payload", "createdAt")
SELECT "id", "threadId", "idx", "type", "payload", "createdAt"
FROM "ChatEvent_old";

DROP TABLE "ChatEvent_old";

CREATE INDEX "ChatEvent_threadId_idx_idx" ON "ChatEvent"("threadId", "idx");
CREATE INDEX "ChatEvent_threadId_createdAt_idx" ON "ChatEvent"("threadId", "createdAt");
CREATE UNIQUE INDEX "ChatEvent_threadId_idx_key" ON "ChatEvent"("threadId", "idx");
