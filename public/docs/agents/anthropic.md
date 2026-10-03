# Anthropic

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "anthropic", apiKey: "sk-ant-…" }
```

The key is checked with Anthropic before it is stored. Storing it from an agent also creates an authenticated, per-user rate-limited chat endpoint.

## In a function

`ctx.integrations.anthropic`:

- `complete(prompt, maxTokens?, systemPrompt?)` → string
- `request(method, path, body?, headers?)`: any other Anthropic endpoint

Anthropic has no embeddings API; use `ctx.integrations.openai.embed` for vectors. `ctx.integrations.isConnected('claude')` answers for Anthropic too. Calls use the project's key and bill the project's Anthropic account.
