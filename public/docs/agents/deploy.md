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
| `changes` | every schema change to production, newest first: its changeId, who made it, what it did, whether it was verified, and whether the state before it can be restored | nothing | yes | no |
| `revert_change` | ask to restore the state before one change (changeId); a person approves it, and data written since is never dropped silently | `changeId` | no | waits for a human |
<!-- end generated -->

- `readiness` reports what stands between the project and a working deploy. It is a read and fixes nothing, unless a read-write key passes `autoFix: true`; a read-only key's readiness read never changes anything.
- `history` lists every published version, which one is serving, and which can be rolled back to.
- `deploy` and `rollback` wait for a human's approval (see `autonomy`); the approved call runs exactly as you made it.
- `changes` lists every governed change to production, newest first. Each schema change you make (`apply_migration`, the typed schema tools, an approved drop, a branch merge) is one: Backenly takes a checkpoint first, applies it, then runs protected verification you cannot skip or weaken. A change that fails verification is recovered automatically when that is provably lossless, and otherwise waits for a person; the `change` in an `apply_migration` response says which.
- `revert_change { changeId }` asks for the state before one change to be restored. It waits for a human; you can request a restore, never approve one. Backenly measures what restoring would do first: one that is impossible (a later change touched the same tables, its restore point expired) is answered at once, and one that would set aside data written since says exactly what, and the person approves exactly that. `check_approval` then reports the outcome.

Custom domains have no console setting yet. The project is served at its base URL, which `deploy { action: "status" }` returns.
