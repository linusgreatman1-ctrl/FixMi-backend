ALTER TABLE "ChatThread" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN "closedBy" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "attachmentUrl" TEXT;
