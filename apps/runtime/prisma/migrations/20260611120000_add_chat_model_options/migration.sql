-- AlterTable: add modelOptions JSON column to ChatThread
ALTER TABLE "ChatThread" ADD COLUMN "modelOptions" TEXT;

-- AlterTable: add modelOptions JSON column to ChatMessage
ALTER TABLE "ChatMessage" ADD COLUMN "modelOptions" TEXT;
