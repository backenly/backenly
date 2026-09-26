# Integrations

Index: https://backenly.com/llms.txt

Third-party providers a project's functions call, with the keys kept server side. Five have a dashboard card and a topic of their own: [stripe](https://backenly.com/docs/agents/stripe.md), [resend](https://backenly.com/docs/agents/resend.md), [openai](https://backenly.com/docs/agents/openai.md), [anthropic](https://backenly.com/docs/agents/anthropic.md) and [posthog](https://backenly.com/docs/agents/posthog.md). The runtime also covers SendGrid, Twilio, OneSignal, Replicate, Runway and Stability.

## Actions

<!-- generated:actions:integrations by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `integrations { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `list` | connected providers, masked keys and verification state | nothing | yes | no |
| `capabilities` | the exact ctx.integrations methods each provider gives a function, and for Stripe its receiver URL and signing-secret state | nothing | yes | no |
| `verify` | ask the provider again whether the stored key works | `integrationId` | no | no |
| `connect` | store a provider key (Stripe also takes webhookSecret) and wire the first functions | `integrationId` | no | no |
| `disconnect` | remove a provider key | `integrationId` | no | waits for a human |
| `send_push` | a push notification through the connected OneSignal app | `message` | no | no |
<!-- end generated -->

`capabilities` is the authority for what a function can call: the exact `ctx.integrations.<id>` methods for each provider, and for Stripe the receiver URL and whether the signing secret is stored. It never returns a key.

## Connecting a key

Either the human pastes it on the Integrations page, which keeps it out of the conversation, or the agent passes it:

```
integrations { action: "connect", integrationId: "stripe", apiKey: "sk_test_…", webhookSecret: "whsec_…" }
```

From the shell: `npx -y @backenly/cli@latest call integrations action=connect integrationId=stripe apiKey=sk_test_…`.

The key is checked with the provider before it is stored: Stripe, Resend, OpenAI and Anthropic are asked directly, and a key the provider rejects is refused rather than filed. PostHog project keys and webhook signing secrets cannot be checked by an API call and are stored as unverifiable, never reported as verified. `verify` asks the provider again about a stored key and records the answer. Backenly never invents a credential.

Storing a key from an agent also builds the first functions for that provider (each provider's topic says which). Connecting from the dashboard stores the key only. Anything beyond that is built by asking for it, with `functions` `deploy_code` for code you write or `backend_chat` for an outcome you describe.

## Using a provider in a function

In a sandbox function (any trigger other than http), a connected provider is `ctx.integrations.<id>`, and the key never appears in code or logs. Only the methods `capabilities` lists exist. Most providers also have `request(method, path, body?, headers?)`, a signed call to the provider's own API; the email helper, PostHog and Twilio do not. `ctx.integrations.isConnected(name)` says whether a provider is connected.

Do not write a key into function code: `deploy_code` refuses it, and stored code is readable by anyone who can read the project.
