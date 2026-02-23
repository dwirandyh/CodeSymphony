-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ModelProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ModelProvider" ("apiKey", "baseUrl", "createdAt", "id", "isActive", "name", "updatedAt") SELECT "apiKey", "baseUrl", "createdAt", "id", "isActive", "name", "updatedAt" FROM "ModelProvider";
DROP TABLE "ModelProvider";
ALTER TABLE "new_ModelProvider" RENAME TO "ModelProvider";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
