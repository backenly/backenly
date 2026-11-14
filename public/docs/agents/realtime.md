# Realtime

Index: https://backenly.com/llms.txt

PostgreSQL `LISTEN/NOTIFY` delivered as Server-Sent Events: table changes (insert, update, delete), presence (a 60-second activity window) and broadcast (ephemeral, 6 KB payload limit). A table streams nothing until realtime is enabled for it.

Each change travels as a PostgreSQL notification, which holds about 7.5 KB. A change too large for that arrives with `truncated: true` and only the row's primary key in `data` (and in an update's `old`): fetch the row by that key, or drop a deleted one. An update that fits only without its previous row arrives whole, with `oldTruncated: true` and only the previous row's primary key in `old`. Presence metadata may be up to 4 KB as JSON; more is refused with 413 `PRESENCE_METADATA_TOO_LARGE`.

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

## Presence

`backend.presence.join(user.id, metadata)` marks the signed-in user online, by the `user.id` sign-in returned, and heartbeats every 25 seconds until `leave()`. The server checks that id against the sign-in: `join` rejects with `PRESENCE_TOKEN_REQUIRED` (401) before sign-in and `PRESENCE_IDENTITY_MISMATCH` (403) for any other id, such as a username or an email, and a heartbeat refused with 401 or 403 stops. Only a service-role key, from a server, may announce other users.

## Subscribing from an app

With the SDK the callback receives the event object itself: `backend.posts.subscribe((event) => { if (event.type === 'insert') addRow(event.data) })`.

Without it: `EventSource` cannot send headers, so exchange them for a short-lived, single-use ticket first.

```
POST /api/v1/{projectId}/realtime/ticket
x-api-key: <project key>
X-User-Token: <end-user JWT>
→ { ticket, expiresIn }
```

```
GET /api/v1/{projectId}/realtime?table=<table>&ticket=<ticket>
Accept: text/event-stream
```

Each event is one `data:` line: `{ "type": "insert" | "update" | "delete" | "connected" | "error", "table", "data", "old", "truncated", "timestamp" }` — the changed row is in `data` (`old` carries the previous row on updates; `truncated: true` means the row was too large to embed). Broadcast messages are published with `POST /api/v1/{projectId}/broadcast { channel, payload }` and arrive as `{ "type": "broadcast", "channel", "payload", "timestamp" }` frames; presence changes arrive as `{ "type": "presence", "event": "join" | "leave" | "update", "userId", "metadata", "timestamp" }`. Neither carries a `table`, so a stream opened with `?table=` never receives them: for broadcast or presence, open the stream without `?table=` (it then carries every realtime-enabled table's changes too) and filter by `type` and `channel` yourself. The SDK does this for you. The older `?apiKey=&userToken=` query form still works and is deprecated, because a JWT in a URL ends up in logs.
