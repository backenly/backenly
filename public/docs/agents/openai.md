# OpenAI

Index: https://backenly.com/llms.txt · Integrations: https://backenly.com/docs/agents/integrations.md

## Connecting

```
integrations { action: "connect", integrationId: "openai", apiKey: "sk-…" }
```

The key is checked with OpenAI before it is stored. Storing it from an agent also creates an authenticated, per-user rate-limited chat endpoint and an embeddings endpoint.

## In a function

`ctx.integrations.openai`:

- `complete(prompt, maxTokens?)` → string (a gpt-4o-mini chat completion)
- `embed(text)` → number[] (text-embedding-3-small)
- `request(method, path, body?, headers?)`: any other OpenAI endpoint

Calls use the project's key, so they bill the project's OpenAI account, not Backenly's AI credits.
