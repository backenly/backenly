/**
 * CHANGE CORRELATION — what happened to this backend just before it changed
 * =========================================================================
 *
 * "Tell me the query got slower" is half an answer. The other half is "and here
 * is what changed shortly before it did", because that is where the developer
 * was going to look next anyway.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * It is not causal inference, and the wording it produces never claims to be.
 * Three things changed in the hour before a regression; probably none of them
 * caused it, possibly one did, and this module has no way to tell. Saying "this
 * deploy caused your slowdown" on temporal adjacency alone is how an automated
 * system spends its credibility — the user checks the deploy, finds it
 * unrelated, and stops reading the findings.
 *
 * So it answers a narrower question exactly: WHAT CHANGED, and WHEN, relative to
 * the deviation. The developer does the inference. That is the division of
 * labour the platform's whole finding policy is built on.
 *
 * ── Where the changes come from ────────────────────────────────────────────
 *
 * Four ledgers the platform already keeps, and nothing new:
 *
 *   AuditLog             every governed mutation, autonomous fix and approval
 *   SchemaDriftEvent     DDL that arrived over a direct psql/migration-tool
 *                        connection — the changes Backenly did NOT make, which
 *                        are the ones most worth surfacing here
 *   Deployment           the project's own deploys
 *   WorkspaceSchemaSnapshot  a version boundary, so "the schema changed here"
 *                        is answerable even when nothing else recorded it
 *
 * Read-only.
 */

import { prisma } from '@/lib/db/prisma'

export interface CorrelatedChange {
  at: string
  /** Which ledger this came from. */
  source: 'autonomy' | 'schema' | 'deploy' | 'external_ddl'
  /** One line naming what happened. */
  summary: string
  /** Minutes before the deviation. Negative means after (never reported). */
  minutesBefore: number
}

/**
 * How far back to look.
 *
 * Six hours. Long enough to catch a deploy that started degrading things
 * gradually, short enough that the list stays readable and the adjacency stays
 * meaningful — a change from three days ago is not context, it is noise.
 */
export const CORRELATION_WINDOW_HOURS = 6

/** Most changes reported. Beyond this the list stops being a lead and becomes a log. */
const MAX_CHANGES = 8

/**
 * Audit actions that represent a CHANGE to the backend.
 *
 * Bookkeeping rows — tick markers, scan-budget consumption, deferral notes — are
 * excluded by allow-listing rather than by denying known-noisy actions: a new
 * bookkeeping action added later would otherwise silently start appearing as a
 * "change" beside every regression.
 */
const CHANGE_ACTIONS = [
  'HEALTH_AUTO_FIXED',
  'HEALTH_FIX_EXECUTED',
  'HEALTH_FIX_ROLLED_BACK',
  'EXTERNAL_SCHEMA_ADOPTED',
  'TABLE_CREATED',
  'TABLE_ALTERED',
  'TABLE_DROPPED',
  'SCHEMA_MIGRATION_APPLIED',
  'API_GENERATED',
  'PERMISSION_POLICY_APPLIED',
  'AI_ACTION_EXECUTED',
] as const

function minutesBetween(change: Date, deviation: Date): number {
  return Math.round((deviation.getTime() - change.getTime()) / 60_000)
}

/**
 * What changed on this project in the window before `deviationAt`.
 *
 * Newest first, so the most adjacent change — the one a developer looks at
 * first — leads the list.
 */
export async function changesBefore(
  projectId: string,
  deviationAt: Date = new Date(),
  windowHours: number = CORRELATION_WINDOW_HOURS,
): Promise<CorrelatedChange[]> {
  const since = new Date(deviationAt.getTime() - windowHours * 60 * 60 * 1000)
  const where = { projectId, timestamp: { gte: since, lte: deviationAt } }

  const [audits, drifts, deploys, snapshots] = await Promise.all([
    prisma.auditLog.findMany({
      where: { ...where, action: { in: CHANGE_ACTIONS as unknown as string[] } },
      orderBy: { timestamp: 'desc' },
      take: MAX_CHANGES,
      select: { action: true, details: true, timestamp: true },
    }).catch(() => []),
    prisma.schemaDriftEvent.findMany({
      where: { projectId, capturedAt: { gte: since, lte: deviationAt } },
      orderBy: { capturedAt: 'desc' },
      take: MAX_CHANGES,
      select: { commandTag: true, objectIdentity: true, roleName: true, capturedAt: true },
    }).catch(() => []),
    prisma.deployment.findMany({
      where: { projectId, createdAt: { gte: since, lte: deviationAt } },
      orderBy: { createdAt: 'desc' },
      take: MAX_CHANGES,
      select: { status: true, createdAt: true },
    }).catch(() => []),
    prisma.workspaceSchemaSnapshot.findMany({
      where: { projectId, createdAt: { gte: since, lte: deviationAt } },
      orderBy: { createdAt: 'desc' },
      take: MAX_CHANGES,
      select: { versionNum: true, trigger: true, tableCount: true, createdAt: true },
    }).catch(() => []),
  ])

  const out: CorrelatedChange[] = []

  for (const a of audits) {
    let what = a.action.replace(/_/g, ' ').toLowerCase()
    try {
      const d = JSON.parse(a.details ?? '{}')
      const target = d.tableName ?? d.table ?? d.location
      if (d.findingType) what = `${String(d.findingType).replace(/_/g, ' ')} repaired`
      if (target) what += ` on "${target}"`
    } catch { /* free-text details are fine — the action name still names it */ }
    out.push({
      at: a.timestamp.toISOString(),
      source: 'autonomy',
      summary: `Backenly ${what}`,
      minutesBefore: minutesBetween(a.timestamp, deviationAt),
    })
  }

  for (const d of drifts) {
    out.push({
      at: d.capturedAt.toISOString(),
      source: 'external_ddl',
      // Named as coming from OUTSIDE deliberately. These are the changes the
      // platform did not make, and the most likely explanation a developer has
      // not already thought of.
      summary:
        `${d.commandTag}${d.objectIdentity ? ` on ${d.objectIdentity}` : ''} ` +
        `over a direct database connection (${d.roleName})`,
      minutesBefore: minutesBetween(d.capturedAt, deviationAt),
    })
  }

  for (const dep of deploys) {
    out.push({
      at: dep.createdAt.toISOString(),
      source: 'deploy',
      summary: `Deployment (${dep.status})`,
      minutesBefore: minutesBetween(dep.createdAt, deviationAt),
    })
  }

  for (const s of snapshots) {
    // pre_migration/post_migration pairs bracket one change and would report it
    // twice. The post-side is the boundary where the new schema became live.
    if (s.trigger === 'pre_migration') continue
    out.push({
      at: s.createdAt.toISOString(),
      source: 'schema',
      summary: `Schema version ${s.versionNum} captured (${s.tableCount} tables, ${s.trigger})`,
      minutesBefore: minutesBetween(s.createdAt, deviationAt),
    })
  }

  return out
    .sort((a, b) => a.minutesBefore - b.minutesBefore)
    .slice(0, MAX_CHANGES)
}

/**
 * The correlation as one sentence, or null when there is nothing to say.
 *
 * The wording is load-bearing. "Three things changed on this backend in the two
 * hours before" is a fact. "This deploy caused it" would be a guess dressed as
 * a finding, and the first time it was wrong the user would stop trusting every
 * other number on the page.
 */
export function summariseCorrelation(changes: CorrelatedChange[]): string | null {
  if (changes.length === 0) return null
  const nearest = changes[0]
  const when =
    nearest.minutesBefore < 60
      ? `${nearest.minutesBefore} minutes`
      : `${Math.round(nearest.minutesBefore / 60)} hours`
  const rest = changes.length - 1
  return (
    `${changes.length} change${changes.length === 1 ? '' : 's'} landed on this backend beforehand — ` +
    `the closest was ${when} earlier: ${nearest.summary}` +
    (rest > 0 ? `, and ${rest} other${rest === 1 ? '' : 's'} before that.` : '.') +
    ` Backenly is not claiming any of them caused it; this is where to look first.`
  )
}
