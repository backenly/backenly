/**
 * ROLLBACK — put the table back exactly as it was, or say why not
 * ===============================================================
 *
 * Expand never touches the host's data or columns, so undoing an extraction is
 * removing what the ladder added, in reverse order:
 *
 *   close writes → close reads → stop the forward sync → drop the satellite
 *
 * Two guards decide whether that is safe, and neither is a description.
 *
 * ── Lossless, proven before anything is removed ─────────────────────────────
 *
 * Every write through the satellite was applied to the host in the same
 * statement, or refused. So in a healthy extraction the satellite holds nothing
 * the host lacks, and dropping it loses nothing. "Healthy" is checked, not
 * assumed: with both syncs still live, reconciliation must show no ORPHANED row
 * (a satellite row whose parent does not carry it — written around the sync,
 * by a tool that bypasses triggers) and no MISMATCHED one (two values, and no
 * way for software to know which is right). Either refuses, naming the keys. A
 * MISSING row is fine: the host has the data and the satellite never did.
 *
 * It is checked twice. Once before anything is touched, so a refusal leaves
 * the extraction exactly as it was. Then again after writes to the satellite
 * are closed and before anything is dropped: from that moment the satellite
 * only changes through the forward mirror of the host, so a clean second check
 * means nothing written afterwards can exist only in the satellite. Without
 * the second check, a write landing between the first check and the close —
 * or anything that bypassed the sync in that window — would go unexamined.
 *
 * ── It must be the satellite this ladder created ────────────────────────────
 *
 * The ledger recorded the table's oid when `create_satellite` committed. A
 * table of the same name with a different oid is somebody else's — recreated
 * by hand, restored from a backup — and dropping it because the ledger
 * remembers a namesake is how automatic recovery destroys work. Refused.
 *
 * Each removal is verified from the catalog afterwards, and the consent is
 * withdrawn so no sweep re-runs the ladder the owner just reversed.
 */

import { prisma } from '@/lib/db'
import { withMaintenanceSingleFlight } from '@/lib/autonomy/maintenance/single-flight'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { readTableFacts } from './facts'
import { latestRun, ledgerSteps, readLatestEvolutionApproval } from './consent'
import { reconcileExtraction } from './reconcile'
import { isOurSatellite, reloadDataPlane, runStatements, unregisterTable } from './primitives'
import { closeWritesSql, dropForwardSyncSql, dropSatelliteSql, ladderNames, revokeReadsSql } from './sql'

export interface RollbackAction {
  action: 'close_writes' | 'revoke_reads' | 'drop_forward_sync' | 'drop_satellite' | 'withdraw_consent'
  outcome: 'done' | 'not_needed' | 'failed'
  detail: string
}

export interface RollbackOutcome {
  status: 'rolled_back' | 'nothing_to_undo' | 'refused' | 'failed' | 'in_flight_elsewhere'
  reason: string | null
  actions: RollbackAction[]
}

export async function rollbackExtraction(input: {
  projectId: string
  planId: string
  requestedBy: string
}): Promise<RollbackOutcome> {
  const flight = await withMaintenanceSingleFlight(input.projectId, () => undo(input))
  return flight.ran
    ? flight.value
    : { status: 'in_flight_elsewhere', reason: 'another process is running a ladder on this project', actions: [] }
}

async function undo(input: { projectId: string; planId: string; requestedBy: string }): Promise<RollbackOutcome> {
  const { projectId, planId } = input
  const approval = await readLatestEvolutionApproval(projectId, planId)
  if (!approval) return { status: 'refused', reason: 'no extraction with this plan id was ever approved here', actions: [] }

  const spec = approval.spec
  const n = ladderNames(spec)
  const schema = await resolveWorkspaceSchema(projectId)
  const target = { schema }
  const ledger = await ledgerSteps(projectId, planId)
  // What a rung observed after committing, whatever its final status: a rung
  // that created a table and then failed its postcondition still created it.
  const recorded = (kind: string) =>
    ledger.find(s => s.kind === kind && s.observedPostState)?.observedPostState as Record<string, unknown> | undefined
  const actions: RollbackAction[] = []

  const host = await readTableFacts(schema, spec.host)
  if (!host) return { status: 'refused', reason: `${spec.host} no longer exists`, actions }
  const sat = await readTableFacts(schema, spec.satellite)
  const ours = isOurSatellite(sat, spec)
  const forwardLive = host.triggers.some(t => t.name === n.forward)

  if (sat && !ours) {
    return { status: 'refused', reason: `${spec.satellite} exists but was not created by this extraction`, actions }
  }
  if (!sat && !forwardLive) {
    await withdraw(approval.id, input.requestedBy, actions)
    return { status: 'nothing_to_undo', reason: 'nothing this extraction creates is present', actions }
  }

  if (sat) {
    const createdOid = recorded('create_satellite')?.oid
    if (createdOid === undefined) {
      return {
        status: 'refused',
        reason: `${spec.satellite} is in the catalog but the ledger has no record of creating it, so it is not this ladder's to drop`,
        actions,
      }
    }
    if (Number(createdOid) !== sat.oid) {
      return {
        status: 'refused',
        reason: `${spec.satellite} was recreated since this ladder made it (oid ${String(createdOid)} then, ${sat.oid} now)`,
        actions,
      }
    }
  }

  const step = async (
    action: RollbackAction['action'],
    needed: boolean,
    sql: string[],
    verify: () => Promise<boolean>,
    ok: string,
  ): Promise<boolean> => {
    if (!needed) {
      actions.push({ action, outcome: 'not_needed', detail: 'nothing to remove' })
      return true
    }
    try {
      await runStatements(sql)
    } catch (err) {
      actions.push({ action, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) })
      return false
    }
    if (!(await verify())) {
      actions.push({ action, outcome: 'failed', detail: 'the statements committed but the catalog still shows the object' })
      return false
    }
    actions.push({ action, outcome: 'done', detail: ok })
    return true
  }

  const lossless = async (): Promise<string | null> => {
    const facts = await readTableFacts(schema, spec.host)
    if (!facts) return `${spec.host} no longer exists`
    const r = await reconcileExtraction(projectId, facts, spec)
    return r.orphaned > 0 || r.mismatched > 0
      ? `${spec.satellite} holds data ${spec.host} does not (${r.orphaned} orphaned, ${r.mismatched} different; ` +
          `keys ${[...r.samples.orphaned, ...r.samples.mismatched].join(', ')}). Dropping it would lose that; reconcile by hand first.`
      : null
  }

  // The first lossless check: at one snapshot, with both syncs still live,
  // before anything is touched.
  if (sat) {
    const problem = await lossless()
    if (problem) return { status: 'refused', reason: problem, actions }
  }

  const writers = (recorded('open_writes')?.granted as string[] | undefined) ?? []
  const readers = (recorded('expose_reads')?.granted as string[] | undefined) ?? []
  const satNow = () => readTableFacts(schema, spec.satellite)

  // The second lossless check, after the satellite stopped taking writes.
  const recheck = async (): Promise<boolean> => {
    if (!sat) return true
    const problem = await lossless().catch(err => `the lossless check could not run: ${err instanceof Error ? err.message : String(err)}`)
    if (!problem) return true
    actions.push({ action: 'close_writes', outcome: 'failed', detail: `writes are closed, nothing was dropped: ${problem}` })
    return false
  }

  const okSoFar =
    (await step(
      'close_writes',
      !!sat && (sat.triggers.some(t => t.name === n.reverse) || sat.policies.some(p => [n.policies.insert, n.policies.update, n.policies.delete].includes(p.name))),
      closeWritesSql(spec, target, writers),
      async () => {
        const f = await satNow()
        return !!f && !f.triggers.some(t => t.name === n.reverse) && !f.policies.some(p => [n.policies.insert, n.policies.update, n.policies.delete].includes(p.name))
      },
      `writes to ${spec.satellite} closed; ${writers.length} role grant(s) revoked`,
    )) &&
    (await recheck()) &&
    (await step(
      'revoke_reads',
      !!sat && sat.policies.some(p => p.name === n.policies.select),
      revokeReadsSql(spec, target, readers),
      async () => {
        const f = await satNow()
        return !!f && !f.policies.some(p => p.name === n.policies.select)
      },
      `reads of ${spec.satellite} closed; ${readers.length} role grant(s) revoked`,
    )) &&
    (await step(
      'drop_forward_sync',
      forwardLive,
      dropForwardSyncSql(spec, target),
      async () => !((await readTableFacts(schema, spec.host))?.triggers.some(t => t.name === n.forward) ?? false),
      `${spec.host} no longer mirrors into ${spec.satellite}`,
    )) &&
    (await step(
      'drop_satellite',
      !!sat,
      dropSatelliteSql(spec, target),
      async () => (await satNow()) === null,
      `${spec.satellite} dropped; ${spec.host} is as it was before the extraction`,
    ))

  if (!okSoFar) {
    await markLedger(projectId, planId, 'failed', actions)
    return { status: 'failed', reason: actions.find(a => a.outcome === 'failed')?.detail ?? 'a removal failed', actions }
  }

  await unregisterTable(projectId, schema, spec.satellite)
  const reload = await reloadDataPlane()
  await withdraw(approval.id, input.requestedBy, actions)
  await markLedger(projectId, planId, 'verified', actions)
  return { status: 'rolled_back', reason: reload, actions }
}

async function withdraw(approvalId: string, by: string, actions: RollbackAction[]): Promise<void> {
  await prisma.maintenanceApproval
    .updateMany({ where: { id: approvalId, revokedAt: null }, data: { revokedAt: new Date(), revokedBy: by } })
    .catch(() => {})
  actions.push({ action: 'withdraw_consent', outcome: 'done', detail: 'consent withdrawn so no sweep re-runs this ladder' })
}

/**
 * Record the rollback on every rung row, and stop them counting as applied.
 *
 * `rolled_back` rather than leaving `completed`: a re-approved ladder for the
 * same plan version would otherwise skip every rung as "already applied" over a
 * schema that no longer has any of it.
 */
async function markLedger(
  projectId: string,
  planId: string,
  rollbackStatus: 'verified' | 'failed',
  actions: RollbackAction[],
): Promise<void> {
  const detail = actions.map(a => `${a.action}: ${a.outcome}`).join('; ')
  await prisma.maintenanceStepExecution
    .updateMany({
      where: { execution: { projectId, planId }, status: { in: ['completed', 'dispatched', 'failed'] } },
      data: {
        rollbackStatus,
        rollbackDetail: detail,
        rollbackAt: new Date(),
        ...(rollbackStatus === 'verified' ? { status: 'rolled_back' } : {}),
      },
    })
    .catch(() => {})
  const run = await latestRun(projectId, planId)
  if (run && rollbackStatus === 'verified') {
    await prisma.maintenanceExecution
      .update({ where: { id: run.executionId }, data: { status: 'rolled_back', haltReason: detail } })
      .catch(() => {})
  }
}
