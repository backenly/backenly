-- The support AI first responder retries a transient failure and records why it
-- did not answer: aiError (the failure kind), aiAttempts (attempts started) and
-- aiNextAttemptAt (the running attempt's lease, or when the retry is due).
-- Additive with defaults, so every existing case reads as zero attempts and no
-- recorded reason.

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "aiAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "aiError" TEXT,
ADD COLUMN     "aiNextAttemptAt" TIMESTAMP(3);
