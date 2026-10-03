/**
 * DRIFT WATCH — external DDL becomes observed drift, not a permission error
 * ==========================================================================
 * The open-loop half of direct database access (lib/services/direct-access.ts).
 *
 * READ_WRITE connection strings let a developer run DDL from psql / a migration
 * tool. Every such statement is recorded by the superuser-installed event
 * trigger (scripts/setup-direct-access.sql) into SchemaDriftEvent. This module
 * turns those rows into the autonomy loop's vocabulary:
 *
 *   detectPendingSchemaDrift — invariant probe (desired-state.ts). Pending
 *     events → ONE open `external_schema_change` finding with the full evidence
 *     (who, when, which objects). Evidence-gated per the finding policy: the
 *     probe reads recorded runtime events, never guesses.
 *
 *   adoptExternalSchema — the fix (ADOPT_EXTERNAL_SCHEMA executor action).
 *     Reconciles platform reality onto live reality, Kubernetes-style:
 *       • registers live tables that have no platform metadata (API + RLS +
 *         realtime via the caller-supplied registerTable, i.e. REGISTER_TABLE)
 *       • refreshes API metadata for altered tables
 *       • prunes metadata whose physical table is gone (ApiDefinition cascades)
 *       • re-baselines the WorkspaceSchemaSnapshot so shadow-mutation probes
 *         stop re-flagging the same change
 *       • re-syncs direct-access grants/ownership/RLS pass-through
 *       • marks the events adopted
 *     Adoption never executes DDL — it only updates platform bookkeeping, so it
 *     is additive and safe to auto-apply within the owner's autonomy dial.
 *
 *   reapDriftFindings — withdraws open external_schema_change findings once no
 *     pending events remain (finding-reaper contract: a finding is a claim
 *     about CURRENT state).
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { isReservedWorkspaceTable } from '@/lib/security/workspace-schema'

/** Stable location marker so every drift event folds into ONE open finding. */
const DRIFT_LOCATION = 'direct-connection'

// ── Probe (desired-state invariant) ───────────────────────────────────────────

export async function detectPendingSchemaDrift(projectId: string): Promise<RawFinding[]> {
  const events = await prisma.schemaDriftEvent.findMany({
    where: { projectId, status: 'pending' },
    orderBy: { capturedAt: 'asc' },
    take: 200,
    select: { id: true, roleName: true, commandTag: true, objectIdentity: true, capturedAt: true },
  }).catch(() => [])
  if (events.length === 0) return []

  const commands: Record<string, number> = {}
  const objects = new Set<string>()
  for (const e of events) {
    commands[e.commandTag] = (commands[e.commandTag] ?? 0) + 1
    if (e.objectIdentity) objects.add(e.objectIdentity)
  }
  const roles = [...new Set(events.map(e => e.roleName))]
  const summary = Object.entries(commands).map(([tag, n]) => `${n}× ${tag}`).join(', ')

  // External DROPs are critical: the object (and its data) is already gone,
  // adoption can only reconcile the bookkeeping — recovery needs a restore
  // point/backup, so the owner must actually see this one.
  const hasDrop = events.some(e => e.commandTag.startsWith('DROP'))

  return [{
    type: 'external_schema_change',
    severity: hasDrop ? 'critical' : 'warning',
    autoFixable: true,
    details: {
      reason:
        `${events.length} schema change${events.length === 1 ? '' : 's'} (${summary}) ` +
        `arrived over a direct database connection (${roles.join(', ')}). ` +
        `Adopting updates the stored contract — API metadata, snapshot baseline, and access grants — to match the live schema. No data is touched.`,
      location: DRIFT_LOCATION,
      eventCount: events.length,
      commands,
      objects: [...objects].slice(0, 25),
      roles,
      firstAt: events[0].capturedAt.toISOString(),
      lastAt: events[events.length - 1].capturedAt.toISOString(),
    },
  }]
}

// ── Adopt ─────────────────────────────────────────────────────────────────────

/**
 * What adoption actually achieved.
 *
 * `adopted` used to be the only outcome, written unconditionally at the end
 * regardless of what the steps above had managed. Partial execution reported
 * as completion is the same defect as a verifier failure reported as success,
 * and here it also retired the drift events - the only record that the change
 * had been noticed at all.
 */
export type AdoptOutcome =
  /** Every required step completed and the live set was established. */
  | 'adopted'
  /** The live set was established; some non-essential step did not complete. */
  | 'partial'
  /**
   * The live schema could not be read, so nothing is known about what exists.
   *
   * Critically NOT the same as "the schema is empty". Pruning against an
   * unestablished live set deletes metadata for tables that are merely
   * invisible, and ApiDefinition cascades from Table.
   */
  | 'unverified'

export interface AdoptExternalSchemaResult {
  outcome: AdoptOutcome
  /** Why, when the outcome is not `adopted`. */
  reason: string | null
  adoptedEvents: number
  registeredTables: string[]
  refreshedTables: string[]
  prunedTables: string[]
  /** Steps that did not complete, named. Empty on a clean adoption. */
  incompleteSteps: string[]
}

/**
 * Reconcile platform bookkeeping onto the live schema and mark every pending
 * drift event adopted. `registerTable` is injected by the executor (bound to
 * REGISTER_TABLE's implementation) to avoid importing the 10k-line executor
 * from autonomy code.
 */
export async function adoptExternalSchema(
  projectId: string,
  registerTable?: (tableName: string) => Promise<boolean>,
): Promise<AdoptExternalSchemaResult> {
  const events = await prisma.schemaDriftEvent.findMany({
    where: { projectId, status: 'pending' },
    select: { id: true, commandTag: true, objectIdentity: true, schemaName: true },
  })

  const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
  const schema = await resolveWorkspaceSchema(projectId)

  // 0. Ownership/grants normalization MUST come first: a table created by the
  //    external rw role is owned by that role, and backenly_user (non-superuser,
  //    no privileges on it yet) cannot even SEE it in information_schema — the
  //    catalog views filter by privilege. The sync chowns it to the project's
  //    owner role (backenly_user is a member), making it visible and operable
  //    for everything below.
  const incompleteSteps: string[] = []
  let grantsSynced = true
  try {
    const { syncDirectAccessGrants } = await import('@/lib/services/direct-access')
    await syncDirectAccessGrants(projectId)
  } catch {
    // NOT non-fatal, which is what the old comment claimed. This is the step
    // that makes an externally-created table visible at all: information_schema
    // filters by privilege, so without the chown `backenly_user` cannot see it.
    // A silent failure here shrinks the live set that step 3 prunes against,
    // and the prune then deletes metadata for tables that physically exist.
    grantsSynced = false
    incompleteSteps.push('grants-sync')
  }

  // Live physical tables vs platform metadata — the honest diff, independent
  // of which events happened to be captured.
  //
  // `.catch(() => [])` used to sit here, which made a failed catalog read
  // indistinguishable from an empty schema. Step 3 prunes against this set, so
  // that difference is the difference between reconciling and deleting a
  // project's entire metadata surface.
  let liveEstablished = true
  const liveRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    schema,
  ).catch(() => {
    liveEstablished = false
    return [] as Array<{ table_name: string }>
  })
  const liveTables = new Set(liveRows.map(r => r.table_name).filter(t => !isReservedWorkspaceTable(t)))

  // Could we look at all?
  //
  // This is the question the empty set cannot answer on its own. A schema
  // that is genuinely empty and a schema that does not exist or is not
  // visible both return zero rows, and only one of them means "everything
  // this project had is gone". Asking for the schema separates them.
  const schemaRows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.schemata WHERE schema_name = $1`,
    schema,
  ).catch(() => {
    liveEstablished = false
    return [] as Array<{ n: bigint }>
  })
  if (Number(schemaRows[0]?.n ?? 0) === 0) liveEstablished = false

  // And a grants sync that failed leaves tables owned by the external role
  // invisible to this connection, so the set is incomplete even when the read
  // itself succeeded.
  if (!grantsSynced) liveEstablished = false

  const metaRows = await prisma.table.findMany({
    where: { projectId },
    select: { id: true, name: true },
  })
  const metaByName = new Map(metaRows.map(m => [m.name, m.id]))

  // 1. Register live tables the platform doesn't know about.
  const registeredTables: string[] = []
  if (registerTable) {
    for (const t of liveTables) {
      if (!metaByName.has(t)) {
        const ok = await registerTable(t).catch(() => false)
        if (ok) registeredTables.push(t)
      }
    }
  }

  // 2. Refresh API metadata for tables named in ALTER events that still exist
  //    and were already registered (generated endpoints introspect live columns,
  //    so this is bookkeeping freshness, not a repair).
  const alteredNames = new Set<string>()
  for (const e of events) {
    if (!e.commandTag.startsWith('ALTER')) continue
    const ident = e.objectIdentity ?? ''
    const name = ident.includes('.') ? ident.slice(ident.indexOf('.') + 1).replace(/"/g, '') : ident
    if (name && liveTables.has(name) && metaByName.has(name)) alteredNames.add(name)
  }
  const refreshedTables: string[] = []
  if (registerTable) {
    for (const t of alteredNames) {
      const ok = await registerTable(t).catch(() => false)
      if (ok) refreshedTables.push(t)
    }
  }

  // 3. Prune metadata for tables that no longer physically exist (external
  //    DROP). ApiDefinition cascades from Table, so one delete per table.
  //
  // ONLY against an established live set. This is the destructive step, and
  // absence of evidence is not evidence of absence: an unreadable schema, or
  // one the grants sync never made visible, produces exactly the same empty
  // set as a genuinely emptied database.
  const prunedTables: string[] = []
  if (liveEstablished) {
    for (const m of metaRows) {
      if (!liveTables.has(m.name) && !isReservedWorkspaceTable(m.name)) {
        await prisma.table.delete({ where: { id: m.id } }).then(() => {
          prunedTables.push(m.name)
        }).catch(() => {
          // A prune that failed is a divergence that survives, so it is named
          // rather than dropped - otherwise adoption reports a reconciled
          // state it did not reach.
          incompleteSteps.push(`prune:${m.name}`)
        })
      }
    }
  } else {
    incompleteSteps.push('prune-skipped-live-set-unestablished')
  }

  // 4. New baseline so shadow-mutation/schema probes measure from adopted
  //    reality, and grants/ownership/RLS pass-through cover any new table.
  try {
    const { captureSchemaSnapshot } = await import('@/lib/services/workspace-schema-snapshot')
    await captureSchemaSnapshot(projectId, 'manual')
  } catch { /* non-fatal — next governed mutation snapshots anyway */ }
  try {
    const { syncDirectAccessGrants } = await import('@/lib/services/direct-access')
    await syncDirectAccessGrants(projectId)
  } catch { /* non-fatal */ }

  // 5. Mark the events adopted, but ONLY if adoption actually happened.
  //
  // This used to run unconditionally. Retiring a drift event is retiring the
  // only record that the change was noticed, so doing it after a run that
  // reconciled nothing loses the signal and the reason for it at once. A
  // still-pending event is re-adopted on the next pass for free.
  const outcome: AdoptOutcome = !liveEstablished
    ? 'unverified'
    : incompleteSteps.length > 0
      ? 'partial'
      : 'adopted'
  const reason = !liveEstablished
    ? 'could not establish which tables physically exist, so nothing was pruned and no drift was retired'
    : incompleteSteps.length > 0
      ? `some steps did not complete: ${incompleteSteps.join(', ')}`
      : null

  const marked =
    outcome === 'unverified'
      ? { count: 0 }
      : await prisma.schemaDriftEvent.updateMany({
          where: { projectId, status: 'pending' },
          data: { status: 'adopted', resolvedAt: new Date() },
        })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'EXTERNAL_SCHEMA_ADOPTED',
      type: 'autonomy',
      details: JSON.stringify({
        outcome,
        reason,
        adoptedEvents: marked.count,
        registeredTables,
        refreshedTables,
        prunedTables,
        incompleteSteps,
      }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return {
    outcome,
    reason,
    adoptedEvents: marked.count,
    registeredTables,
    refreshedTables,
    prunedTables,
    incompleteSteps,
  }
}

// ── Reaper ────────────────────────────────────────────────────────────────────

/**
 * Withdraw open external_schema_change findings once nothing is pending.
 * Wired into finding-reaper.reapStaleFindings so Re-scan clears it too.
 */
export async function reapDriftFindings(projectId: string): Promise<number> {
  const pending = await prisma.schemaDriftEvent.count({
    where: { projectId, status: 'pending' },
  }).catch(() => -1)
  if (pending !== 0) return 0 // events remain (or count failed) — never reap on uncertainty

  const open = await prisma.healthFinding.findMany({
    where: { projectId, type: 'external_schema_change', status: { in: ['open', 'pending_approval'] } },
    select: { id: true, details: true },
  }).catch(() => [] as Array<{ id: string; details: unknown }>)

  let withdrawn = 0
  for (const row of open) {
    await prisma.healthFinding.update({
      where: { id: row.id },
      data: {
        status: 'dismissed',
        details: {
          ...((row.details as Record<string, unknown> | null) ?? {}),
          withdrawnBy: 'drift_reaper',
          withdrawnAt: new Date().toISOString(),
        } as any,
      },
    }).then(() => { withdrawn++ }).catch(() => {})
  }
  return withdrawn
}
