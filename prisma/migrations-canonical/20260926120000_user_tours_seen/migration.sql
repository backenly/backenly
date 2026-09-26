-- One-time console tours: a row per (user, tour) the user has finished or
-- skipped, so the tour never shows to them again on any device.
--
-- A new table rather than a column on "users": the session lookup loads the
-- whole user row on every request, so a column there would break sign-in for
-- as long as a release ran ahead of this migration. Without this table the tour
-- simply does not run.
--
-- Additive: no existing table, column or row changes.

-- CreateTable
CREATE TABLE "user_tours_seen" (
    "userId" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tours_seen_pkey" PRIMARY KEY ("userId","tourId")
);

-- AddForeignKey
ALTER TABLE "user_tours_seen" ADD CONSTRAINT "user_tours_seen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
