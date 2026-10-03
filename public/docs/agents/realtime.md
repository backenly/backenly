# Realtime

Index: https://backenly.com/llms.txt

PostgreSQL `LISTEN/NOTIFY` delivered as Server-Sent Events: table changes (insert, update, delete), presence (a 60-second activity window) and broadcast (ephemeral, 6 KB payload limit). A table streams nothing until realtime is enabled for it.

## Actions

<!-- generated:actions:realtime by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `realtime { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `enable` | stream inserts, updates and deletes for one table | `tableName` | no | no |
| `status` | which tables stream changes | nothing | yes | no |
| `disable` | stop streaming a table (live subscribers disconnect) | nothing | no | waits for a human |
<!-- end generated -->

Disabling a table disconnects its live subscribers, which is why it waits for a human.

## Subscribing from an app

With the SDK: `backend.posts.subscribe(({ event, row }) => { … })`.

Without it: `EventSource` cannot send headers, so exchange them for a short-lived, single-use ticket first.

```
POST /api/v1/{projectId}/realtime/ticket
x-api-key: <project key>
X-User-Token: <end-user JWT>
→ { ticket, expiresIn }
```

```
GET /api/v1/{projectId}/realtime/subscribe?table=<table>&ticket=<ticket>
Accept: text/event-stream
```

Each event is one `data:` line: `{ "type": "insert" | "update" | "delete" | "connected" | "error", "table", "record", "old", "at" }`. Presence and broadcast use the same transport with `?channel=<name>`. The older `?apiKey=&userToken=` query form still works and is deprecated, because a JWT in a URL ends up in logs.
