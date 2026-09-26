# Autonomy and approvals

Index: https://backenly.com/llms.txt

## The loop

A Monitor → Analyze → Plan → Execute loop watches every project. It applies on its own only additive, snapshotted changes in the reversible safe band (missing indexes, drift it can reconcile, broken triggers). Anything it will not apply lands on the project's **Autonomy** page as a finding with a receipt, for a human to approve or reject. Auth, external credentials, destructive and irreversible changes always wait for a human. The loop runs no model, so it never draws AI credits.

## Actions

<!-- generated:actions:autonomy by scripts/generate-agent-docs.ts from lib/mcp/domains.ts; do not edit -->
Call as `autonomy { action: "<action>", … }`.

| Action | What it does | Needs | Read-only key | Approval |
| --- | --- | --- | --- | --- |
| `status` | mode, recent repairs and what is waiting | nothing | yes | no |
| `findings` | open health findings with evidence | nothing | yes | no |
| `maintenance` | the schema-maintenance ladder and its consent state | nothing | yes | no |
| `set_level` | OFF, CONSERVATIVE, BALANCED or AGGRESSIVE | `level` | no | no |
<!-- end generated -->

`set_level { level }` takes `OFF`, `CONSERVATIVE`, `BALANCED` or `AGGRESSIVE`. Approving what the loop queued is for a human only; there is no agent action for it.

## Approvals

Some actions never run from the call that asks for them: every one marked "waits for a human" in a topic's action table, and dropping or truncating a table or discarding a branch through `backend_chat`. For those:

1. The exact call, with its arguments, is parked. The response carries an `approval` object with its `id`, and nothing has changed.
2. A human approves or rejects it on the project's **Autonomy** page.
3. Once approved, the parked call runs verbatim: no model reads it again, and nothing is re-derived from a description.
4. Poll `check_approval { id }` every 15–30 seconds until the status is terminal:
   - `executed`: done.
   - `rejected`: do not retry; ask your human what they want instead.
   - `expired`: nobody decided within 24 hours.
   - `failed`: nothing was applied; safe to try again.
   - `partial`: some changes landed before the run stopped; read `resultSummary` and verify state instead of replaying the call.

A read-only key is never parked: its write calls are refused with `READ_ONLY_KEY` before anything else happens. Calling a destructive tool directly by an older name (for example `delete_bucket`) is refused with `DESTRUCTIVE_NEEDS_APPROVAL`; use the section tool's action, which parks it.
