-- Per-project SMTP, and operator-authored auth email templates.
--
-- Both surfaces were PARTIAL in the derived register for the same reason: the
-- thing itself was real and there was no way to configure it. A transport read
-- SMTP_HOST/SMTP_USER/SMTP_PASS from deployment-wide env, and the subjects and
-- bodies were built in TypeScript. Real, sending, and unchangeable without a
-- code change and a deploy.
--
-- Both tables are OVERRIDES. Absence means the existing behaviour, so an
-- install that upgrades and configures nothing behaves exactly as it did.

CREATE TABLE "project_email_configs" (
    "id"             TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    -- False keeps the row but routes through the deployment fallback, so an
    -- operator can stop using project SMTP without losing the settings.
    "enabled"        BOOLEAN NOT NULL DEFAULT false,

    "host"           TEXT NOT NULL,
    "port"           INTEGER NOT NULL,
    "username"       TEXT NOT NULL,

    -- AES-256-GCM, the scheme database_credentials already uses. Three columns
    -- because GCM needs the IV and the auth tag to decrypt at all, and a tag
    -- that is not checked is not authentication.
    "passwordCipher" TEXT NOT NULL,
    "passwordIv"     TEXT NOT NULL,
    "passwordTag"    TEXT NOT NULL,

    -- Envelope sender, separate from username: SES and SendGrid authenticate as
    -- an API identity and send as your domain.
    "fromAddress"    TEXT NOT NULL,
    "fromName"       TEXT,

    -- Evidence rather than intent. "Configured" and "works" are different
    -- claims and the dashboard must not imply the second from the first.
    "lastTestAt"     TIMESTAMP(3),
    "lastTestError"  TEXT,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_email_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_email_configs_projectId_key"
    ON "project_email_configs"("projectId");

ALTER TABLE "project_email_configs"
    ADD CONSTRAINT "project_email_configs_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_email_templates" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    -- 'verification' | 'password_reset' | 'magic_link'. Text rather than an
    -- enum so adding a kind is a code change reviewed alongside the code that
    -- sends it, instead of a migration that silently outruns the sender.
    "kind"      TEXT NOT NULL,

    "subject"   TEXT NOT NULL,
    "bodyHtml"  TEXT NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_email_templates_pkey" PRIMARY KEY ("id")
);

-- One override per kind per project. Without this a project could hold two
-- password-reset templates and which one sent would depend on row order.
CREATE UNIQUE INDEX "project_email_templates_projectId_kind_key"
    ON "project_email_templates"("projectId", "kind");

ALTER TABLE "project_email_templates"
    ADD CONSTRAINT "project_email_templates_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
