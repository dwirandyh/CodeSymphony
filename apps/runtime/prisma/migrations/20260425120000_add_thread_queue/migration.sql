CREATE TABLE "ChatQueuedMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "dispatchRequestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatQueuedMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChatQueuedAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "queuedMessageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "storagePath" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatQueuedAttachment_queuedMessageId_fkey" FOREIGN KEY ("queuedMessageId") REFERENCES "ChatQueuedMessage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ChatQueuedMessage_threadId_seq_key" ON "ChatQueuedMessage"("threadId", "seq");
CREATE INDEX "ChatQueuedMessage_threadId_status_dispatchRequestedAt_seq_idx" ON "ChatQueuedMessage"("threadId", "status", "dispatchRequestedAt", "seq");
CREATE INDEX "ChatQueuedAttachment_queuedMessageId_idx" ON "ChatQueuedAttachment"("queuedMessageId");
