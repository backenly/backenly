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

export interface AdoptExternalSchemaResult {
  adoptedEvents: number
  registeredTables: string[]
  refreshedTables: string[]
  prunedTables: string[]
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
  try {
    const { syncDirectAccessGrants } = await import('@/lib/services/direct-access')
    await syncDirectAccessGrants(projectId)
  } catch { /* non-fatal — registration below will then skip unseen tables */ }

  // Live physical tables vs platform metadata — the honest diff, independent
  // of which events happened to be captured.
  const liveRows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    schema,
  ).catch(() => [] as Array<{ table_name: string }>)
  const liveTables = new Set(liveRows.map(r => r.table_name).filter(t => !isReservedWorkspaceTable(t)))

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
  const prunedTables: string[] = []
  for (const m of metaRows) {
    if (!liveTables.has(m.name) && !isReservedWorkspaceTable(m.name)) {
      await prisma.table.delete({ where: { id: m.id } }).then(() => {
        prunedTables.push(m.name)
      }).catch(() => {})
    }
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

  // 5. Mark the events adopted (also any that arrived while we worked — the
  //    snapshot above already includes them).
  const marked = await prisma.schemaDriftEvent.updateMany({
    where: { projectId, status: 'pending' },
    data: { status: 'adopted', resolvedAt: new Date() },
  })

  await prisma.auditLog.create({
    data: {
      projectId,
      action: 'EXTERNAL_SCHEMA_ADOPTED',
      type: 'autonomy',
      details: JSON.stringify({
        adoptedEvents: marked.count,
        registeredTables,
        refreshedTables,
        prunedTables,
      }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return { adoptedEvents: marked.count, registeredTables, refreshedTables, prunedTables }
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
