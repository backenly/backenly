# End-user auth

Index: https://backenly.com/llms.txt

Authentication for the **end-users of the app you are building**. It is completely separate from Backenly's own accounts: its own users table in the project's schema, and JWTs signed with a per-project secret. Email and password, magic links, OAuth, access and refresh tokens, password reset, email verification, account lockout and session revocation.

## Actions

<!-- generated:actions:auth by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `auth { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `enable` | turn on email + password sign-up with JWT sessions | nothing | no | no |
| `add_oauth_provider` | Google, GitHub, Discord, Facebook or Apple sign-in, with the provider's clientId and clientSecret | `provider` | no | no |
| `remove_oauth_provider` | turn a sign-in provider off | `provider` | no | waits for a human |
| `list_users` | the end-users who have signed up | nothing | yes | no |
| `reset_password` | send a password reset to one user (userId or email) | nothing | no | no |
| `block_user` | stop one user from signing in | nothing | no | waits for a human |
| `unblock_user` | let a blocked user sign in again | nothing | no | no |
| `enable_teams` | organizations with members and roles | nothing | no | no |
| `email_settings` | how verification and password-reset emails are sent, whether the last test worked, and the templates | nothing | yes | no |
| `set_smtp` | the SMTP server auth emails are sent through (the password is stored encrypted and never returned) | `host`, `port`, `username`, `fromAddress` | no | no |
| `test_smtp` | send one real test email and record whether it arrived at the server | `to` | no | no |
| `remove_smtp` | remove the SMTP settings | nothing | no | waits for a human |
| `set_email_template` | the app's own verification, password_reset or magic_link email; must include {{ctaUrl}} | `kind`, `subject`, `bodyHtml` | no | no |
| `reset_email_template` | go back to the default for one of them | `kind` | no | no |
<!-- end generated -->

`add_oauth_provider` takes the provider's own `clientId` and `clientSecret`; the secret is stored encrypted. `set_smtp` stores the password encrypted and never returns it; `test_smtp` sends one real email and records whether the server accepted it. A template set with `set_email_template` must include `{{ctaUrl}}`, the link the email exists to deliver. Session settings are in the dashboard.

## Endpoints

Relative to `https://backenly.com/api/v1/{projectId}`, with `x-api-key: <project key>`:

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/auth/signup` | `{ email, password, name? }` returns `{ user, accessToken, refreshToken }` |
| POST | `/auth/signin` | `{ email, password }` returns `{ user, accessToken, refreshToken }` |
| POST | `/auth/refresh-token` | `{ refreshToken }` returns `{ accessToken, refreshToken }` |
| POST | `/auth/logout` | `X-User-Token` required; revokes the session |
| POST | `/auth/forgot-password` | `{ email }`, always 200 (no account enumeration) |
| POST | `/auth/reset-password` | `{ token, password }` |
| GET | `/auth/me` | `X-User-Token` required; the current end-user |
| GET | `/auth/{provider}?redirect_to=…` | OAuth start; redirects back to `redirect_to` with the tokens |
| POST | `/auth/magic-link` | `{ email, redirectTo? }` emails a one-time sign-in link |
| POST | `/auth/verify-email` | `{ token }` |

Send the access token as `X-User-Token` on data requests; that is what row-level security reads. `users` is never served through `/db/users`.
