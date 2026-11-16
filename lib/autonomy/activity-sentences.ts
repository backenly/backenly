/**
 * What the loop's audit rows say in the activity feeds.
 *
 * One labeller for the rows that the autonomy loop, its gate, the approvals
 * and the change ledger write (types `autonomy` and `health`, and the ledger's
 * CHANGE_ and ROLLBACK_ rows). Two feeds read it: the Autonomy page's log
 * (lib/autonomy/trust-report.ts) and the project's activity feed
 * (lib/activity/feed.ts), which the shared change report shows.
 *
 * It is a list of sentences, not a list of exclusions. Both feeds used to print
 * any action they had no sentence for as its own name: a new project's feed
 * read "authority propose only" and "autonomy escalation retried", and an
 * approved index read "Applied your approved fix: slow query missing index"
 * (production QA, 2026-11-16). The Autonomy page kept a list of bookkeeping rows
 * to hide, and every row the loop learned to write after it reached the page as
 * its name until someone added it there.
 *
 * A row is shown only when its action has a sentence here. The loop's own
 * bookkeeping has none: a tick, a deferral to the next pass, a gate receipt
 * whose outcome another row tells, a measurement kept for the precision
 * analysis. Those rows stay in the audit log for whoever reads it.
 */

import { prisma } from '@/lib/db/prisma'
import { AUTONOMOUS_AUDIT_ACTIONS } from './circuit-breaker'
import { explainAutonomyEvent } from './because-copy'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { isVerifiedFix, isVerificationError } from '@/lib/core/fix-verification'

/** The audit types the loop writes under. */
export const LOOP_LOG_TYPES = ['autonomy', 'health'] as const

/** Governed-change rows (lib/changes/recovery.ts); each carries its own sentence. */
export const CHANGE_PREFIX = 'CHANGE_'
export const ROLLBACK_PREFIX = 'ROLLBACK_'

/**
 * Every loop action the feeds have a sentence for. A row of a loop type whose
 * action is not here is not shown. Left out on purpose, as of 2026-11-17:
 *
 *   AUTONOMY_TICK, AUTONOMY_SCAN_CONSUMED, AUTONOMY_LIVE_RUN: per-tick cadence
 *     and budget markers; the fix rows carry what happened.
 *   HEALTH_FIX_DEFERRED: the loop deciding to try a finding again next pass.
 *   AUTONOMY_INVESTIGATION, AUTONOMY_DIAGNOSIS_OUTCOME: the investigator's cap
 *     and precision receipts; what it found is shown on the finding.
 *   AUTHORITY_AUTO_EXECUTE, AUTHORITY_FREEZE, AUTHORITY_LEGACY_COMPATIBILITY:
 *     gate receipts whose outcome is its own row, or that changed nothing.
 *   AUTONOMY_RECURRENCE_SUPPRESSED, AUTONOMY_SUBSYSTEM_RECURRENCE_SHADOW,
 *     AUTONOMY_LOOP_STALLED, AUTONOMY_SKIPPED: measurements and operator
 *     diagnostics.
 *   AI_PROPOSAL_*: a proposal's own steps; HEALTH_FIX_AWAITING_APPROVAL and
 *     HEALTH_FIX_APPROVED tell its story.
 *   DATA_PLANE_*: a region's data-plane heal, not this project's history.
 *   FIX_PLAN_AWAITING_APPROVAL, FIX_PLAN_FAILED: no longer written.
 */
export const FEED_ACTIONS: readonly string[] = [
  ...AUTONOMOUS_AUDIT_ACTIONS,
  'HEALTH_FIX_UNVERIFIED',
  'HEALTH_FIX_CONFIRMED_LATE',
  'HEALTH_FIX_ESCALATED',
  'HEALTH_FIX_AWAITING_APPROVAL',
  'HEALTH_FIX_REQUESTED',
  'HEALTH_FIX_APPROVED',
  'HEALTH_FIX_EXECUTED',
  'HEALTH_FIX_EXECUTION_FAILED',
  'HEALTH_FIX_RESOLVED_VIA_CHAT',
  'HEALTH_FIX_ROLLED_BACK',
  'HEALTH_FINDING_DISMISSED',
  'AUTHORITY_PROPOSE_ONLY',
  'AUTHORITY_DENY',
  'AUTHORITY_RECOVERY',
  'AUTONOMY_ESCALATION_RETRIED',
  'AUTONOMY_RECURRENCE_ESCALATED',
  'AUTONOMY_CIRCUIT_OPEN',
  'AUTONOMY_CHANGE_FREEZE',
  'AUTONOMY_REPAIR_HELD',
  'AUTONOMY_SHADOW_DECISION',
  'AUTONOMY_LEVEL_CHANGED',
  'AUTONOMY_DETECTOR_RETIRED',
  'INDEX_TRIAL_RESULT',
  'EXTERNAL_SCHEMA_ADOPTED',
  'AI_FUNCTION_SELF_HEALED',
  'MAINTENANCE_ROLLBACK_PERFORMED',
  'MAINTENANCE_APPROVAL_GRANTED',
  'MAINTENANCE_APPROVAL_REVOKED',
]

/** A finding a row names, as it is on record now. */
export interface RecordedFinding {
  type: string
  details: Record<string, unknown>
}

type Details = Record<string, any>

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The finding a row is about, in the words its card uses: from the finding on
 * record when it still exists (rows written at approval carry only its type),
 * else from what the row kept.
 */
function findingWords(d: Details, finding: RecordedFinding | null | undefined): string | null {
  if (finding) return summariseFinding(finding.type, finding.details)
  const type = text(d.findingType)
  return type ? summariseFinding(type, d) : null
}

/** The product's names for the autonomy dial, never the stored value. */
function levelSentence(level: unknown): string {
  switch (typeof level === 'string' ? level.toUpperCase() : null) {
    case 'OFF': return 'You turned autonomy off'
    case 'CONSERVATIVE': return 'You set autonomy to Review-only'
    case 'BALANCED':
    case 'AGGRESSIVE': return 'You set autonomy to Autopilot'
    default: return 'You changed the autonomy level'
  }
}

/** The table a gate receipt names: its resource is `schema.table`, or the project alone. */
function receiptTable(resource: unknown): string | null {
  const r = text(resource)
  if (!r) return null
  const dot = r.indexOf('.')
  return dot > 0 && dot < r.length - 1 ? r.slice(dot + 1) : null
}

/**
 * The sentence for one row, or null when the row is bookkeeping that the feeds
 * do not show. `finding` is the finding the row names (`details.findingId`),
 * when it is still on record.
 */
export function activitySentence(
  action: string,
  details: Details | null | undefined,
  finding?: RecordedFinding | null,
): string | null {
  const d: Details = details ?? {}
  const what = findingWords(d, finding)
  const summary = text(d.summary)

  // The trust UI's headline rows: the canonical "what because why" sentence,
  // so the feed and the welcome-back banner agree word for word. Only a
  // recorded 'confirmed' outcome is a verified fix: the retired orchestrator's
  // AGENT_AUTO_FIXED rows and FIX_PLAN_AUTO_EXECUTED record none, so they read
  // as what they were.
  if ((AUTONOMOUS_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return `${explainAutonomyEvent(d).full}${isVerifiedFix(d.verification) ? '' : ' (it ran, but could not be confirmed)'}`
  }

  // A governed change's recovery and restore write their own sentence.
  if (action.startsWith(CHANGE_PREFIX)) {
    if (summary) return summary
    return action.startsWith('CHANGE_RECOVERY_') ? 'Held back for your approval' : null
  }
  if (action.startsWith(ROLLBACK_PREFIX)) {
    return summary ?? `Rolled back a previous change${what ? `: ${what}` : ''}`
  }

  switch (action) {
    case 'HEALTH_FIX_UNVERIFIED':
      return 'Applied a fix but could not confirm it worked — re-checking next pass'
    case 'HEALTH_FIX_CONFIRMED_LATE':
      return `Confirmed a fix that could not be checked when it ran${what ? `: ${what}` : ''}`
    case 'HEALTH_FIX_ESCALATED':
      // Never the raw type: `Held back for your approval: rls_expression_invalid`
      // told the user nothing they could act on, and every escalation on a
      // different table produced the same row.
      if (!d.findingType && summary) return summary
      return what ? `Held back for your approval: ${what}` : 'Held back for your approval'
    case 'HEALTH_FIX_AWAITING_APPROVAL':
      return what ? `Asked for your approval: ${what}` : 'Asked for your approval of a fix'
    case 'HEALTH_FIX_REQUESTED':
      // Kept in the feed (a person asked, and History shows who), with the
      // subject that makes it worth a line; the outcome is its own row.
      return what ? `You asked Backenly to fix: ${what}` : 'You asked Backenly to fix a finding'
    case 'HEALTH_FIX_APPROVED':
      return 'You approved a fix — applying it now'
    case 'HEALTH_FIX_EXECUTED': {
      const subject = text(d.title) ?? what
      // Claim a re-check only when one confirmed it, and a snapshot only when
      // one was kept: the approve route records its id, and a fix that takes
      // none (an index, say) records null.
      const snapshot = typeof d.snapshotId === 'string' && d.snapshotId.length > 0
      const suffix = isVerifiedFix(d.verification)
        ? ` — re-checked and confirmed${snapshot ? ', snapshot captured' : ''}`
        : isVerificationError(d.verification)
          ? ' — applied, but the check that would confirm it could not run'
          : ` — applied${snapshot ? ' and snapshotted' : ''} (not independently re-checked)`
      return subject ? `Applied your approved fix: ${subject}${suffix}` : `Applied your approved fix${suffix}`
    }
    case 'HEALTH_FIX_EXECUTION_FAILED':
      return what
        ? `Could not apply your approved fix: ${what} — left for your review`
        : 'Could not apply your approved fix — left for your review'
    case 'HEALTH_FIX_RESOLVED_VIA_CHAT':
      return what ? `Applied the fix you asked for in chat: ${what}` : 'Applied the fix you asked for in chat'
    case 'HEALTH_FIX_ROLLED_BACK':
      return what ? `You undid a fix: ${what}` : 'You undid a fix'
    case 'HEALTH_FINDING_DISMISSED':
      return 'You dismissed a finding'

    // The gate let the loop only propose this change, so it went to Waiting on
    // you. The receipt is the one row that says so; it names the table, not
    // the finding.
    case 'AUTHORITY_PROPOSE_ONLY':
    case 'AUTHORITY_DENY': {
      const table = receiptTable(d.resource)
      return table ? `Held back a change to ${table} for your approval` : 'Held back a change for your approval'
    }
    // The loop putting a table's access rules back after its own verifier
    // rejected a policy repair (auto-fix-engine.ts, _recoverPolicies).
    case 'AUTHORITY_RECOVERY': {
      const table = text(d.tableName) ? ` on ${d.tableName}` : ''
      if (d.status === 'verified') return `Put the access rules${table} back after a repair failed its check`
      if (d.status === 'not_needed') return `A repair failed its check and had changed no access rules${table}`
      return `A repair failed its check, and the access rules${table} could not be put back: needs a look`
    }

    case 'AUTONOMY_ESCALATION_RETRIED': {
      const attempt = Number(d.attempt)
      const max = Number(d.maxAttempts)
      const of = attempt > 0 && max > 0 ? ` (attempt ${attempt} of ${max})` : ''
      return `Retried a fix that failed earlier${of}${what ? `: ${what}` : ''}`
    }
    case 'AUTONOMY_RECURRENCE_ESCALATED': {
      const n = Number(d.priorAutoFixCount) || 0
      const hours = Number(d.windowHours) || 24
      const back = n > 0 ? `came back ${count(n, 'time', 'times')} in ${hours} hours` : 'kept coming back'
      return `Stopped fixing this on its own after it ${back}${what ? `: ${what}` : ''}`
    }
    case 'AUTONOMY_CIRCUIT_OPEN':
      return `Safety circuit tripped — autonomous actions paused (${text(d.reason) ?? 'rate ceiling reached'})`
    case 'AUTONOMY_CHANGE_FREEZE':
    case 'AUTONOMY_REPAIR_HELD':
      return 'Paused repairs while the backend has an active incident'
    case 'AUTONOMY_SHADOW_DECISION':
      return summary ?? 'Evaluated what it would do (shadow mode)'
    case 'AUTONOMY_LEVEL_CHANGED':
      return levelSentence(d.level)
    case 'AUTONOMY_DETECTOR_RETIRED': {
      const n = Number(d.withdrawn) || 0
      const kept = Number(d.kept) || 0
      return (
        `Withdrew ${count(n, 'finding', 'findings')} from a retired check` +
        (kept > 0 ? `; ${kept} you had acted on ${kept === 1 ? 'stays' : 'stay'} listed` : '')
      )
    }

    // An index Backenly built on its own, kept or taken away after its trial
    // (lib/autonomy/index-trials.ts). The row carries its own sentence.
    case 'INDEX_TRIAL_RESULT':
      return text(d.sentence) ?? 'Backenly checked an index it built'
    // Schema changes made over a direct connection, taken into the platform's
    // records (lib/autonomy/drift-watch.ts). A pass that could not establish
    // the live tables changed nothing and retries; it is not news.
    case 'EXTERNAL_SCHEMA_ADOPTED':
      if (d.outcome === 'adopted') return 'Took in schema changes made directly in the database'
      if (d.outcome === 'partial') return 'Took in part of the schema changes made directly in the database; the rest is retried on the next pass'
      return null
    case 'AI_FUNCTION_SELF_HEALED': {
      const name = text(d.name) ? `the function "${d.name}"` : 'a function'
      return d.reason === 'regenerated from a runtime error'
        ? `Rewrote ${name} after it failed while running`
        : `Turned ${name} back on: it had stopped because of a fault in Backenly, not in its code`
    }
    case 'MAINTENANCE_ROLLBACK_PERFORMED':
      if (d.status === 'verified') return 'Undid a maintenance step'
      if (d.status === 'failed') return 'Could not finish undoing a maintenance step: needs a look'
      return 'Undid a maintenance step, but could not confirm it'
    case 'MAINTENANCE_APPROVAL_GRANTED':
      return 'You approved a maintenance plan'
    case 'MAINTENANCE_APPROVAL_REVOKED':
      return 'You withdrew your approval of a maintenance plan'
    default:
      return null
  }
}

/**
 * The findings these rows name, as they are on record now, by id. One read
 * for a page of rows. A finding that no longer exists is simply absent.
 */
export async function findingsNamedBy(
  projectId: string,
  detailsList: Array<Details | null | undefined>,
): Promise<Map<string, RecordedFinding>> {
  const ids = [...new Set(detailsList.map((d) => text(d?.findingId)).filter((id): id is string => id !== null))]
  if (ids.length === 0) return new Map()
  const found = await prisma.healthFinding
    .findMany({ where: { projectId, id: { in: ids } }, select: { id: true, type: true, details: true } })
    .catch(() => [] as Array<{ id: string; type: string; details: unknown }>)
  return new Map(
    found.map((f): [string, RecordedFinding] => [f.id, { type: f.type, details: (f.details ?? {}) as Record<string, unknown> }]),
  )
}

/** A row's `details` column (a JSON string; free text on some legacy rows). */
export function parseDetails(details: string | null | undefined): Details {
  if (!details) return {}
  try {
    const parsed = JSON.parse(details)
    return parsed && typeof parsed === 'object' ? (parsed as Details) : {}
  } catch {
    return {}
  }
}
