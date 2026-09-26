# Deploy

Index: https://backenly.com/llms.txt

Versioned deployments with history and rollback. A deployment that would break the live schema is refused at plan time.

## Actions

<!-- generated:actions:deploy by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `deploy { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `status` | the live version, when it shipped and its state | nothing | yes | no |
| `history` | every published version, which one is serving, and which can be rolled back to | nothing | yes | no |
| `readiness` | the 0-100 readiness score with blockers; fixes nothing unless autoFix is true | nothing | yes | no |
| `deploy` | publish the current backend | nothing | no | waits for a human |
| `rollback` | return to an earlier version | nothing | no | waits for a human |
<!-- end generated -->

- `readiness` reports what stands between the project and a working deploy. It is a read and fixes nothing, unless a read-write key passes `autoFix: true`; a read-only key's readiness read never changes anything.
- `history` lists every published version, which one is serving, and which can be rolled back to.
- `deploy` and `rollback` wait for a human's approval (see `autonomy`); the approved call runs exactly as you made it.

Custom domains are set in the dashboard.
