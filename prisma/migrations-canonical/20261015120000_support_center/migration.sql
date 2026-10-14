-- Support center: the flat contact-form table becomes a real case system with
-- a correspondence thread (support_messages), category/severity, an optional
-- project link, and queue fields (lastMessageAt/lastMessageBy, aiState).

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "aiState" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "caseNumber" SERIAL NOT NULL,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN     "firstStaffReplyAt" TIMESTAMP(3),
ADD COLUMN     "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastMessageBy" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedBy" TEXT,
ADD COLUMN     "severity" TEXT NOT NULL DEFAULT 'normal';

-- Existing rows: last activity is the row's own last write, not the moment this
-- migration ran, and the legacy "dismissed" state maps to closed.
UPDATE "support_tickets" SET "lastMessageAt" = "updatedAt";
UPDATE "support_tickets" SET "status" = 'closed' WHERE "status" = 'dismissed';

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_messages_ticketId_createdAt_idx" ON "support_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_caseNumber_key" ON "support_tickets"("caseNumber");

-- CreateIndex
CREATE INDEX "support_tickets_lastMessageAt_idx" ON "support_tickets"("lastMessageAt");

-- CreateIndex
CREATE INDEX "support_tickets_projectId_idx" ON "support_tickets"("projectId");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
