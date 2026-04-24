ALTER TABLE "ChatThread" ADD COLUMN "cursorSessionId" TEXT;

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

INSERT INTO "new_ModelProvider" ("agent", "apiKey", "baseUrl", "createdAt", "id", "isActive", "modelId", "name", "updatedAt")
SELECT "agent", "apiKey", "baseUrl", "createdAt", "id", "isActive", "modelId", "name", "updatedAt" FROM "ModelProvider";

DROP TABLE "ModelProvider";
ALTER TABLE "new_ModelProvider" RENAME TO "ModelProvider";
CREATE INDEX "ModelProvider_agent_isActive_idx" ON "ModelProvider"("agent", "isActive");
