-- AlterTable: add modelOptionsPerModel JSON column to ChatThread
ALTER TABLE "ChatThread" ADD COLUMN "modelOptionsPerModel" TEXT;
