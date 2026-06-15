-- CreateTable: singleton AgentConfig for custom CLI paths and Cursor API key
CREATE TABLE "AgentConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "claudePath" TEXT,
    "codexPath" TEXT,
    "opencodePath" TEXT,
    "cursorApiKey" TEXT,
    "updatedAt" DATETIME NOT NULL
);
