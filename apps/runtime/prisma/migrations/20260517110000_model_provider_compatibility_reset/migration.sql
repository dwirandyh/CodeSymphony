-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

UPDATE "ChatThread" SET "modelProviderId" = NULL;
UPDATE "Automation" SET "modelProviderId" = NULL;

CREATE TABLE "new_ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "compatibility" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT,
    "apiKey" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

DROP TABLE "ModelProvider";
ALTER TABLE "new_ModelProvider" RENAME TO "ModelProvider";
CREATE INDEX "ModelProvider_compatibility_isActive_idx" ON "ModelProvider"("compatibility", "isActive");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
