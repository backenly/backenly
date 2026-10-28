-- Profile photos: the Google account's own photo, recorded at each Google
-- sign-in and shown as the console avatar. An account without a row shows its
-- initials.
--
-- A new table rather than a column on "users", for the reason user_tours_seen
-- is one: the session lookup loads the whole user row on every request, so a
-- column there would break sign-in for as long as a release ran ahead of this
-- migration. Without this table the console simply shows initials.
--
-- Additive: no existing table, column or row changes.

-- CreateTable
CREATE TABLE "user_avatars" (
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_avatars_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_avatars" ADD CONSTRAINT "user_avatars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
