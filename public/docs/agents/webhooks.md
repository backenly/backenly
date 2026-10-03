# Webhooks

Index: https://backenly.com/llms.txt

Outbound endpoints on the Webhooks page receive a signed `POST` when an event happens: `row.inserted`, `row.updated`, `row.deleted` or `auth.user.created`. Deliveries retry, and a delivery that keeps failing ends up in a dead-letter state you can replay.

## Actions

<!-- generated:actions:webhooks by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `webhooks { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `list` | every endpoint with its event, URL, on/off state and capture health | nothing | yes | no |
| `create` | an endpoint for row.inserted, row.updated, row.deleted or auth.user.created | `eventType`, `targetUrl` | no | no |
| `update` | change the URL or event of an endpoint, or switch it on or off | `webhookId` | no | no |
| `delete` | remove an endpoint and its delivery history | `webhookId` | no | waits for a human |
| `test` | send one real signed test delivery now and see what the receiver answered | `webhookId` | no | no |
| `logs` | the deliveries of one endpoint, with status, HTTP code, error and payload | `webhookId` | yes | no |
| `replay` | send a FAILED or DEAD_LETTER delivery again | `deliveryId` | no | no |
| `rotate_secret` | a new signing secret for an endpoint | `webhookId` | no | no |
| `triggers` | the table triggers, including those whose action calls a URL | nothing | yes | no |
| `trigger_deliveries` | recent trigger deliveries, filterable by SUCCESS, FAILED or DEAD | nothing | yes | no |
| `replay_trigger_delivery` | send a DEAD trigger delivery again | `id` | no | no |
| `rotate_trigger_secret` | a new signing secret for a trigger | nothing | no | no |
<!-- end generated -->

- `create` returns the endpoint's signing secret once, in `data.secret`, never in the summary; store it where the receiver can read it.
- Each delivery carries `X-Webhook-Signature: sha256=<HMAC-SHA256 of the raw body>`. Verify it against the raw bytes, before parsing.
- `test` sends one real signed delivery now; a receiver that refuses it is recorded as a failed delivery.
- `replay` sends a `FAILED` or `DEAD_LETTER` delivery again, as a new attempt; a delivered event is not sent twice, and a disabled endpoint is not sent to.
- `rotate_secret` issues a new signing secret; the next delivery is signed with the new one only.
- `triggers`, `trigger_deliveries`, `replay_trigger_delivery` and `rotate_trigger_secret` are for table triggers whose action calls a URL.

Destinations are checked by the egress guard, which refuses private and cloud-metadata addresses.
