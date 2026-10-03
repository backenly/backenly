-- Emailed codes for platform signup and password reset.
--
-- Signup created the account and a session before anything proved the address
-- belonged to the person typing it. Password reset mailed a signed link whose
-- delivery nobody observed. Both now go through one short, single-use code.
--
-- Only an HMAC of the code is stored, so a leaked row cannot be turned back
-- into a working code offline. `payload` carries a pending signup's bcrypt
-- password hash and admission verdict until the code is proven; no user row
-- exists before then.
CREATE TABLE "auth_email_codes" (
    "id"         TEXT NOT NULL,
    -- 'signup' | 'password_reset'. Text rather than an enum so a new purpose
    -- is a code change reviewed with the code that issues it.
    "purpose"    TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "codeHash"   TEXT NOT NULL,
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "sendCount"  INTEGER NOT NULL DEFAULT 1,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "payload"    JSONB,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_email_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_email_codes_purpose_email_key"
    ON "auth_email_codes"("purpose", "email");
CREATE INDEX "auth_email_codes_expiresAt_idx"
    ON "auth_email_codes"("expiresAt");

-- The link-based reset this replaces. Its rows were one-hour bearer tokens for
-- links that are no longer accepted, so there is nothing to carry.
DROP TABLE "password_reset_tokens";
