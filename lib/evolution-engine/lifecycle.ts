/**
 * EVOLUTION LIFECYCLE — every state an architecture change can be in
 * ==================================================================
 *
 * An evolution is long-running: it is proposed, rehearsed, approved, expanded,
 * backfilled, verified, cut over, watched, and only then trusted. Any of those
 * can be interrupted by a crash, a withdrawn consent, a regression or an owner
 * pressing undo. A lifecycle that lives only in the order of function calls
 * cannot say where an interrupted change stands, so it is explicit here: a
 * closed set of states, a closed set of transitions, and one function that
 * refuses every transition not in the table.
 *
 *   proposed ─▶ rehearsing ─▶ rehearsed ─▶ awaiting_approval ─▶ approved
 *                    │                                             │
 *                    ▼                                             ▼
 *                 blocked ◀───────────────────────────────── expanding
 *                    ▲                                             │
 *                    │                                             ▼
 *                    ├──────────────────────────────────────  backfilling
 *                    │                                             │
 *                    │                                             ▼
 *                    ├──────────────────────────────────────  verifying
 *                    │                                             │
 *                    │                                             ▼
 *                    ├──────────────────────────────────────── cutover
 *                    │                                             │
 *                    │                                             ▼
 *                    └──────────────────────────────────────── observing ─▶ stable
 *
 *   any expanding … stable, blocked, failed ─▶ rolling_back ─▶ rolled_back
 *
 * ── Cutover is not success ──────────────────────────────────────────────────
 *
 * The rungs finishing proves the migration WORKED. It does not prove the new
 * shape is BETTER, or even harmless under real traffic. So a completed ladder
 * enters `observing`, and only an observation window with no regression moves
 * it to `stable`. A change that never finished observing is never reported as
 * a success.
 *
 * ── Blocked and failed are different facts ─────────────────────────────────
 *
 *   blocked  the engine stopped on purpose and needs a person: consent was
 *            withdrawn or went stale, verification disagreed, observation saw
 *            a regression. Nothing is broken; progress is withheld.
 *   failed   a rung did not do what it said. The ledger says which, and the
 *            rollback contract says what can be undone.
 *
 * Pure. Persistence is the ledger's (see ./memory.ts); this decides only what
 * may follow what.
 */

export const LIFECYCLE_STATES = [
  'proposed',
  'rehearsing',
  'rehearsed',
  'awaiting_approval',
  'approved',
  'expanding',
  'backfilling',
  'verifying',
  'cutover',
  'observing',
  'stable',
  'blocked',
  'failed',
  'rolling_back',
  'rolled_back',
] as const

export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

/** States in which rungs are being applied to the live schema. */
export const ACTIVE_STATES: readonly LifecycleState[] = ['expanding', 'backfilling', 'verifying', 'cutover']

/** States from which nothing further happens without a person. */
export const TERMINAL_STATES: readonly LifecycleState[] = ['stable', 'rolled_back']

/** Where an interrupted change may be undone from. */
const UNDOABLE: readonly LifecycleState[] = [
  'expanding',
  'backfilling',
  'verifying',
  'cutover',
  'observing',
  'stable',
  'blocked',
  'failed',
]

/**
 * The transition table. Self-transitions are always permitted (a resumed rung
 * stays in its stage) and are not listed.
 */
const NEXT: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  proposed: ['rehearsing', 'blocked'],
  rehearsing: ['rehearsed', 'blocked'],
  // A drifted table means the rehearsal was of a plan that no longer exists.
  rehearsed: ['awaiting_approval', 'rehearsing', 'blocked'],
  awaiting_approval: ['approved', 'rehearsing', 'blocked'],
  // `approved → rehearsing` covers a ladder approved before rehearsal evidence
  // for its exact version existed: the executor rehearses before any rung.
  approved: ['expanding', 'rehearsing', 'blocked'],
  expanding: ['backfilling', 'blocked', 'failed', 'rolling_back'],
  backfilling: ['verifying', 'blocked', 'failed', 'rolling_back'],
  verifying: ['cutover', 'blocked', 'failed', 'rolling_back'],
  cutover: ['observing', 'blocked', 'failed', 'rolling_back'],
  observing: ['stable', 'blocked', 'rolling_back'],
  stable: ['rolling_back'],
  // Unblocking resumes the stage that stopped, after a person acted.
  blocked: ['rehearsing', 'awaiting_approval', 'approved', 'expanding', 'backfilling', 'verifying', 'cutover', 'observing', 'rolling_back'],
  failed: ['rolling_back', 'expanding', 'backfilling', 'verifying', 'cutover'],
  // A refused or failed undo leaves things as they were, stopped.
  rolling_back: ['rolled_back', 'blocked'],
  // Re-proposing a reversed change needs new evidence; see ./memory.ts.
  rolled_back: ['proposed'],
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return from === to || NEXT[from].includes(to)
}

export class InvalidTransition extends Error {
  constructor(public from: LifecycleState, public to: LifecycleState) {
    super(`an evolution cannot go from ${from} to ${to}`)
  }
}

/** Throws on a transition the table does not allow. */
export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to)
}

export function isLifecycleState(x: unknown): x is LifecycleState {
  return typeof x === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(x)
}

export const canUndoFrom = (s: LifecycleState): boolean => UNDOABLE.includes(s)

/**
 * The words a normal user sees. Internal machinery — rehearsing, expanding,
 * backfilling — collapses into "in progress"; the person needs to know whether
 * something is waiting on them and whether it worked, not which rung is live.
 */
export function userFacingStatus(s: LifecycleState): {
  label: string
  tone: 'neutral' | 'attention' | 'progress' | 'good' | 'bad'
} {
  switch (s) {
    case 'proposed':
    case 'rehearsing':
    case 'rehearsed':
      return { label: 'Being evaluated', tone: 'neutral' }
    case 'awaiting_approval':
      return { label: 'Needs your approval', tone: 'attention' }
    case 'approved':
    case 'expanding':
    case 'backfilling':
    case 'verifying':
    case 'cutover':
      return { label: 'In progress', tone: 'progress' }
    case 'observing':
      return { label: 'Applied — watching the result', tone: 'progress' }
    case 'stable':
      return { label: 'Done', tone: 'good' }
    case 'blocked':
      return { label: 'Paused — needs your attention', tone: 'attention' }
    case 'failed':
      return { label: 'Stopped', tone: 'bad' }
    case 'rolling_back':
      return { label: 'Undoing', tone: 'progress' }
    case 'rolled_back':
      return { label: 'Undone', tone: 'neutral' }
  }
}
