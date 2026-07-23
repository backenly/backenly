# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public report is a
working exploit handed to everyone running this software before any of them can
patch.

Email **support@backenly.com** with `SECURITY` in the subject. Include what
you did, what happened, and what you expected. A proof of concept helps and is
never required.

You will get an acknowledgement within 72 hours and an assessment within 7 days.
Please give us 90 days before public disclosure, or less if the issue is being
actively exploited. In that case tell us, and we will move at that pace.

We will credit you unless you prefer otherwise.

## What is in scope

Backenly is multi-tenant. The findings we care most about are the ones that
cross a boundary that is supposed to hold:

- **Tenant isolation**: reading or writing another project's `workspace_*`
  schema by any route
- **Auth confusion**: a platform user authenticating as an end user, or a token
  from one project being accepted by another
- **Row-level security bypass**: reaching rows an RLS policy should have hidden
- **Credential exposure**: any path that returns password hashes, API keys, or
  connection strings
- **Privilege escalation through autonomy**: causing the autonomous loop to
  apply a change it should have escalated to a human

## Out of scope

- Findings that require an already-compromised operator account
- Rate limiting on unauthenticated endpoints, absent a demonstrated impact
- Automated scanner output with no working proof of concept
- Anything on a self-hosted instance the reporter controls entirely

## Supported versions

Security fixes land on `main`. There are no long-lived release branches yet, so
if you are self-hosting, track `main`.

## For self-hosters

Two settings are the difference between a safe deployment and an open one:

- **`JWT_SECRET` must be a strong random value, unique to your deployment.**
  It signs every platform session. Generate it with `openssl rand -hex 32`.
- **Never set `BYPASS_AI_ENFORCEMENT` outside a local test run.** It disables
  the layer that keeps schema changes governed.

Per-project isolation is enforced by PostgreSQL itself, using separate schemas
plus grants and row-level security, rather than by application code. If you
change how roles are granted, you are changing the tenant boundary.
