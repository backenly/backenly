# PostHog

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "posthog", apiKey: "phc_…" }
```

A PostHog project key cannot be checked by an API call, so it is stored as unverifiable, never reported as verified. Nothing is built automatically: ask for the events you want captured.

## In a function

`ctx.integrations.posthog`:

- `capture({ distinctId, event, properties? })` → `{ ok }`
- `identify({ distinctId, properties })` → `{ ok }`
- `isFeatureEnabled(flagKey, distinctId)` → boolean

There is no `request` for PostHog: its API authenticates in the request body, and the helpers above cover it.
