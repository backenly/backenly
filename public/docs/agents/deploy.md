# Deploy

Index: https://backenly.com/llms.txt

Versioned deployments with history and rollback. A deploy runs the readiness gate first and is refused while the gate reports blockers. Each deploy publishes the project's one production deployment; there is no staging target.

## Actions

<!-- generated:actions:deploy by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `deploy { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `status` | the live version, when it shipped and its state | nothing | yes | no |
| `history` | every published version, which one is serving, and which can be rolled back to | nothing | yes | no |
| `readiness` | the 0-100 readiness score with blockers; fixes nothing unless autoFix is true | nothing | yes | no |
| `deploy` | publish the current backend | nothing | no | waits for a human |
| `rollback` | mark an earlier published version as current (version bookkeeping; the live backend is unchanged) | nothing | no | waits for a human |
<!-- end generated -->

- `readiness` reports what stands between the project and a working deploy. It is a read and fixes nothing, unless a read-write key passes `autoFix: true`; a read-only key's readiness read never changes anything.
- `history` lists every published version, which one is serving, and which can be rolled back to.
- `deploy` and `rollback` wait for a human's approval (see `autonomy`); the approved call runs exactly as you made it.

Custom domains have no console setting yet. The project is served at its base URL, which `deploy { action: "status" }` returns.
