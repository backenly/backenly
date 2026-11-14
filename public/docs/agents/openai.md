# OpenAI

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "openai", apiKey: "sk-…" }
```

The key is checked with OpenAI before it is stored. Storing it from an agent also creates an authenticated, per-user rate-limited chat endpoint and an embeddings endpoint.

## In a function

`ctx.integrations.openai`:

- `complete(prompt, { model?, maxTokens?, system? })` → string (a chat completion)
- `embed(text)` → number[] (text-embedding-3-small)
- `request(method, path, body?, headers?)`: any other OpenAI endpoint

`complete` calls `gpt-4o-mini`, with a `maxTokens` of 256, unless `model` names another OpenAI model. OpenAI has announced `gpt-4o-mini`'s shutdown for January 14, 2027, so pass `model` to choose another before then. `complete(prompt, maxTokens?, systemPrompt?)` also works.

Calls use the project's key, so they bill the project's OpenAI account, not Backenly's AI credits.
