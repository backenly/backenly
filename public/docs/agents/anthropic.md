# Anthropic

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "anthropic", apiKey: "sk-ant-…" }
```

The key is checked with Anthropic before it is stored. Storing it from an agent also creates an authenticated, per-user rate-limited chat endpoint.

## In a function

`ctx.integrations.anthropic`:

- `complete(prompt, { model?, maxTokens?, system?, effort? })` → string
- `request(method, path, body?, headers?)`: any other Anthropic endpoint

`complete` calls `claude-haiku-5-5` at effort `low`, with a `maxTokens` of 1024, unless `model` names another Claude model, such as `claude-opus-5-5`. A model you name thinks at its own default effort unless you pass `effort`. Thinking counts toward `maxTokens`, and a prompt Claude declines throws. `complete(prompt, maxTokens?, systemPrompt?)` also works.

Anthropic has no embeddings API; use `ctx.integrations.openai.embed` for vectors. `ctx.integrations.isConnected('claude')` answers for Anthropic too. Calls use the project's key and bill the project's Anthropic account.
