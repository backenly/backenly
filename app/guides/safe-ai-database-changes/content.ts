/**
 * The guide's facts, kept apart from its layout so they can be checked.
 *
 * Every table and step here restates the engine's own design
 * (docs/CHANGE_RECOVERY.md, lib/changes/) or the production acceptance record
 * (docs/maintenance-production-acceptance.md).
 * tests/unit/safe-changes-guide-conformance.spec.ts holds them to those
 * sources: the recovery-safety names to lib/changes/recovery.ts, the ladder's
 * rungs and the one that stays a person's to lib/autonomy/maintenance/step.ts,
 * and every figure quoted from the record to the record itself.
 */

export const GUIDE_PATH = '/guides/safe-ai-database-changes'

/** The last real edit of this guide. Sitemap lastmod and the article's dateModified. */
export const GUIDE_UPDATED = '2026-10-24'

const GITHUB = 'https://github.com/backenly/backenly/blob/main'
export const SOURCES = {
  recoveryDesign: `${GITHUB}/docs/CHANGE_RECOVERY.md`,
  acceptanceRecord: `${GITHUB}/docs/maintenance-production-acceptance.md`,
  ledger: `${GITHUB}/lib/changes/ledger.ts`,
  verify: `${GITHUB}/lib/changes/verify.ts`,
  recovery: `${GITHUB}/lib/changes/recovery.ts`,
  preserve: `${GITHUB}/lib/changes/preserve.ts`,
  migrationParser: `${GITHUB}/lib/mcp/migration-parser.ts`,
  ladder: `${GITHUB}/lib/autonomy/maintenance/step.ts`,
} as const

export const AUTHORITIES = [
  {
    who: 'Your coding agent (MCP key)',
    may: 'Request changes, request a restore, read outcomes.',
    mayNot: 'Approve anything, skip or weaken verification, touch checkpoints or the audit trail, or change governance settings without a person.',
  },
  {
    who: 'Backenly',
    may: 'Take checkpoints, verify, recover a failed change when recovery is proven lossless, escalate.',
    mayNot: 'Recover when it cannot prove safety, or report success it has not verified.',
  },
  {
    who: 'A person (admin on the project)',
    may: 'Approve a risky restore, restore by hand, approve an agent’s request.',
    mayNot: '',
  },
]

export const CHANGE_STEPS = [
  {
    title: 'The agent sends SQL',
    body: '`apply_migration` parses the whole migration before anything runs, and refuses all of it if one statement cannot be mapped to a governed action. Each statement is then checked against the tables that exist. A `DROP` is refused with `DESTRUCTIVE_REFUSED` and a pointer to `backend_chat`, which parks the request for a person.',
  },
  {
    title: 'Backenly takes a checkpoint',
    body: 'Under the project’s change lock, before the first statement, sized to the change’s risk (the table below). One change at a time per project: a second waits, then is refused.',
  },
  {
    title: 'The statements run',
    body: 'Execution stops at the first failure and the response lists what applied and what remains, so the agent can finish the job instead of replaying the lot.',
  },
  {
    title: 'Backenly verifies the result',
    body: 'Protected verification checks that each reported step really happened, that nothing disappeared as a side effect, that row-level security and API grants were not weakened, and that every touched table is still usable. The checks take nothing from the request: no argument an agent sends can skip or narrow them.',
  },
  {
    title: 'The change ends in a recorded state',
    body: '`healthy` when the checks confirm it. Recovered automatically when they contradict it and the way back is provably lossless. Otherwise it waits for a person in the approvals inbox. A check that could not run leaves the change `unverified`, which is never recovered automatically.',
  },
]

export const CHECKPOINTS = [
  { risk: 'Additive', example: 'Create a table, column, index or constraint', protection: 'A catalog restore point.' },
  {
    risk: 'Transforming',
    example: 'Rename, retype, change nullability or a default',
    protection: 'A restore point; a retype also keeps the original values and the values it produced.',
  },
  {
    risk: 'Destructive',
    example: 'Drop a table or a column',
    protection: 'A restore point, and the data moves into the change’s vault in the same transaction as the drop.',
  },
  {
    risk: 'Data rewrite',
    example: 'Backfill, normalise, split, cast with data',
    protection: 'A restore point, with the before and after images of the rewritten columns.',
  },
]

/** One row per value of lib/changes/recovery.ts `RecoverySafety`. */
export const RECOVERY_SAFETY = [
  {
    safety: 'lossless',
    meaning: 'No conflicts, no impact on data written since, and the proof passed.',
    who: 'Backenly automatically after a failed verification, or a person.',
  },
  {
    safety: 'needs_approval',
    meaning: 'The proof passed, but data written since the change would stop being available to the app.',
    who: 'A person, who sees exactly what and how many.',
  },
  {
    safety: 'blocked',
    meaning: 'A later change touched the same table, or the proof failed against today’s data.',
    who: 'Nobody, until the named cause is resolved.',
  },
  {
    safety: 'unavailable',
    meaning: 'The restore point expired, was purged, or failed its integrity check.',
    who: 'Nobody. The console does not offer it.',
  },
]

/** What a restore asks before it runs: would data written since stop being available? */
export const IMPACT_CASES = [
  'rows in a table the restore removes',
  'values in a column the restore removes, other than its default',
  'values updated since a retype or a data rewrite',
  'values that would not survive the reverse cast',
  'rows written since that the previous schema cannot hold, such as a restored NOT NULL column they have no value for',
]

/** The production run, as docs/maintenance-production-acceptance.md records it (2026-09-16). */
export const LADDER_RUN = [
  { rung: 'add_structure', outcome: 'Added sessions.lifecycle_state; the table’s oid unchanged; 80 rows preserved.' },
  { rung: 'carry_constraints', outcome: 'Derived the new column’s allowed values from status under upper(): ACTIVE, ARCHIVED, PENDING.' },
  { rung: 'dual_write', outcome: 'Installed a trigger that writes both columns.' },
  { rung: 'backfill', outcome: '80 rows updated in 1 batch, as a background job, through row-level security.' },
  { rung: 'verify', outcome: '80 compared, none disagreed.' },
  { rung: 'switch_readers', outcome: '9 Backenly-authored readers switched to the new column; 3 consumer classes cannot be enumerated and still read the old one.' },
  { rung: 'contract', outcome: 'Awaiting a person. Never executed by Backenly.' },
]

/** Byte-level evidence that undoing the reader switch restored the original code. */
export const READER_HASHES = [
  { point: 'Before the switch', hash: 'a99ecbe4f30f8af4', reads: 'status' },
  { point: 'After the switch', hash: '020adfff944c0364', reads: 'lifecycle_state' },
  { point: 'After the revert', hash: 'a99ecbe4f30f8af4', reads: 'status' },
]

export const NOT_AUTOMATED = [
  'Changes outside the database (functions, auth providers, storage) are not in the checkpoint yet.',
  'Row data your application writes is not versioned; only data a change itself removed or rewrote is kept.',
  'A restore that crosses a later change to the same table is refused, not merged.',
  'A change interrupted by a crash is reconciled to “manual intervention required”, and a person decides.',
  'A restore that today’s rows would break, such as bringing back a constraint rows written since would violate, is never offered.',
  'Dropping the old column at the end of a restructuring is always a person’s step: Backenly cannot know that nothing outside it still reads the column.',
]
