# Resend

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "resend", apiKey: "re_…" }
```

The key is checked with Resend before it is stored. SendGrid (`integrationId: "sendgrid"`, key `SG.…`) works the same way and is the fallback when both are connected.

Storing the key from an agent also sends a welcome email on sign-up when end-user auth is on, and a password-reset email when a reset-token table exists.

## In a function

Sending mail goes through the email helper, which uses Resend when it is connected and SendGrid otherwise:

- `ctx.integrations.email.send({ to, subject, html, from?, text? })` → `{ id }`

Resend's own API (domains, audiences, …) is `ctx.integrations.resend.request(method, path, body?, headers?)`, and SendGrid's is `ctx.integrations.sendgrid.request(…)`. Resend itself has no `send` helper: mail goes through `email`.

Delivery logs and stored templates are built by asking for them. Auth emails (verification, password reset, magic links) are configured separately, with `auth` `set_smtp` and `set_email_template`.
