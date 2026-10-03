-- Signup trust (anti-abuse).
--
-- Records how each account arrived so that an address which scored in the
-- challenge band can be held inert until it verifies its mailbox, and so a
-- false positive can be diagnosed from the stored signals rather than guessed at.
--
-- Every existing row defaults to 'trusted': this must never retroactively lock
-- out a user who signed up before the gate existed.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "trustLevel"    TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signupScore"   INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signupSignals" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signupIp"      TEXT;

-- Admin "Users" tab filters on this; the reaper sweeps on it plus createdAt.
CREATE INDEX IF NOT EXISTS "users_trustLevel_idx" ON "users" ("trustLevel");
CREATE INDEX IF NOT EXISTS "users_emailVerified_createdAt_idx" ON "users" ("emailVerified", "createdAt");
