# Monitoring

Index: https://backenly.com/llms.txt

Latency percentiles, error rate, anomaly detection, per-endpoint health and incident history, from the project's own request log.

## Actions

<!-- generated:actions:monitoring by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `monitoring { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `metrics` | request rate, latency percentiles and error rate | nothing | yes | no |
| `errors` | recent 5xx errors grouped by endpoint | nothing | yes | no |
| `usage` | plan usage against its limits | nothing | yes | no |
| `incidents` | what was detected, fixed or queued while nobody was watching | nothing | yes | no |
| `request_logs` | each request the runtime API served: method, path, status, latency, time | nothing | yes | no |
<!-- end generated -->

`request_logs` lists each request the project's runtime API served (method, path without its query string, status, latency, time), newest first. Filter with `minStatus` (400 for failures), `pathPrefix` and `sinceMinutes`. Only traffic to the runtime API (`/db`, `/auth`, `/fn`, `/storage`, `/realtime`) is recorded, never the dashboard's. From the shell: `backenly logs --status 5xx --follow`.

Function runs are in `functions` `logs`; webhook deliveries in `webhooks` `logs`.

There is no alert action. Nothing evaluates alerts yet, so one could be stored but never fire; it is not offered until it can.
